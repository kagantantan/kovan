// Orkestratör: her fikri akışındaki aşamalardan geçiren durum makinesi.
//
// Bir aşama = Üret -> Doğrula döngüsü:
//   1. Üret     : aşamanın ajanı çıktısını yazar (belge ya da kod/ klasöründe dosyalar)
//   2. Denetle  : yazma alanı dışındaki ve kilitli dosyalardaki değişiklikler geri alınır, ihlal kaydedilir
//   3. Doğrula  : önce deterministik komutlar (test), sonra onay kurulu (inceleyen ajanlar, paralel)
//   4. Bulgu varsa tur artar ve bulgular üreten ajana gider; tur sınırında karar insana kalır
//
// İnsan döngüde: ajanlar kararı veremediklerinde seçenekli soru sorar (kovan-soru); sistem de tur sınırı,
// kalıcı hata, bütçe ve teslimde açıklamalı seçeneklerle sorar. Cevaplar karar defterine yazılır ve
// sonraki bütün ajanların istemine girer.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bosAsama, type Akis, type Asama, type Dogrulayici } from "./akislar.js";
import { MODLAR, type Ayarlar, type Mod } from "./ayarlar.js";
import type { Depo } from "./depo.js";
import type { Adim, AjanSorusu, AsamaGorunumu, Bekleme, BeklemeSebebi, Cevap, DosyaIcerigi, Fikir, FikirDetayi, FikirOzeti, Karar, OnayRozeti, Secenek } from "./tipler.js";
export type { Cevap, Karar };
import type { AjanKarti } from "./kartlar.js";
import { KARAR_SEMASI, jsonCikar, soruCikar, sorulariDogrula, sureciOldur, type AjanCagrisi, type AjanSonucu, type HamSoru, type Motor } from "./motor.js";
import { KovanHatasi, altinda, atomikYaz, bekle, jsonOku, kisalt, kuyruk, simdi } from "./ortak.js";

const YOKSAY_KLASOR = new Set(["__pycache__", ".pytest_cache", ".git", "node_modules", ".venv", "venv", "test-results",
  "playwright-report", "coverage", "dist", "build", ".next", ".vite", ".cache", ".turbo", ".parcel-cache"]);
const YOKSAY_DOSYA = new Set([".DS_Store", ".coverage"]);
const YOKSAY_UZANTI = new Set([".pyc", ".pyo", ".log", ".tsbuildinfo"]);

const ORTAK_KURALLAR = `# Ortak kurallar (her ajan için)
- Yalnızca sana verilen girdilere ve rolüne dayan. Girdilerde olmayan bilgiyi uydurma.
- Bir şeyi varsaymak zorundaysan "VARSAYIM:" diye açıkça işaretle.
- Emin değilsen "BİLMİYORUM" de. Emin görünen yanlış bir cevap, eksik bir cevaptan daha kötüdür.
- Rolünün dışındaki işi yapma; başka rolün kararını değiştirme.
- "İnsan kararları" bölümündeki kararlar bağlayıcıdır; onlarla çelişme.
- Türkçe yaz; yerleşmiş teknik terimleri (test, interface, rounding, edge case gibi) İngilizce bırak.`;

const SORU_KURALLARI = `# İnsana soru (human in the loop)
Kararı sen veremiyorsan ve yanlış bir varsayım işi ciddi biçimde boşa çıkaracaksa insana soru sorabilirsin.
- Önce girdilere ve "İnsan kararları" bölümüne bak; cevap oradaysa sorma. Küçük konularda "VARSAYIM:" yazıp devam et.
- Soracaksan çıktın YALNIZCA şu blok olsun (başka metin ya da dosya yok):
\`\`\`kovan-soru
{"sorular": [{"baslik": "3-4 kelime", "soru": "Tek başına anlaşılır, net bir soru?", "coklu": false,
  "secenekler": [{"etiket": "Önerdiğin seçenek (Önerilen)", "aciklama": "Seçilirse ne olur"}, {"etiket": "Başka seçenek", "aciklama": "Seçilirse ne olur"}]}]}
\`\`\`
- En fazla 3 soru; her soruda 2-4 seçenek. Önerdiğini ilk sıraya koy ve etiketinin sonuna "(Önerilen)" yaz.
- "Diğer" seçeneği ekleme; insan her zaman kendi cevabını yazabilir. Birden çok seçenek seçilebilecekse "coklu": true yap.`;

const INCELEME_KURALLARI = `# İnceleme kuralları
- Somut ve düzeltilebilir bir eksik ya da hata varsa DUZELT ver; yoksa ONAY ver.
- Stil ve zevk farkı için DUZELT verme. Mükemmel değil ama doğru ve yeterliyse ONAY.
- Yalnızca kendi rolünün alanına bak; başka onaycının alanındaki konular için DUZELT verme.
- Her bulgu tek cümle: neyin, neden yanlış olduğu ve hangi kritere/kurala aykırı olduğu. En fazla 5 bulgu.
- Emin olmadığın bir konuda bulgu yazma; doğrulayamadığın bir şeyi hata sayma.
- Senin rolün incelemek: düzeltmeyi kendin yazma, dosya değiştirme.`;

const INCELEME_SORU_KURALI = `# İnsana soru (kovan-soru)
Karar vermen insanın bir kararına bağlıysa ve yanlış bir varsayım işi boşa çıkaracaksa "karar": "SORU" ver, soruları "sorular" alanına yaz.
- Önce "İnsan kararları" bölümüne bak; cevap oradaysa sorma. Somut bir hata görüyorsan soru değil DUZELT ver.
- Her soru: baslik (3-4 kelime), soru, coklu, secenekler [{etiket, aciklama}] (2-4 seçenek). En fazla 3 soru.
- Önerdiğin seçeneği ilk sıraya koy ve etiketinin sonuna "(Önerilen)" yaz. "Diğer" ekleme; insan kendi cevabını yazabilir.`;

const SORU_HAKKI_DOLDU = "# İnsana soru\nBu aşamada soru hakkın doldu. Belirsizliklerde \"VARSAYIM:\" yazıp devam et.";

const SECENEK_TANIM: Record<string, Omit<Secenek, "anahtar" | "onerilen">> = {
  kabul: { etiket: "Kabul ediyorum", aciklama: "Teslimi onayla; fikir tamamlanır." },
  geri_gonder: { etiket: "Notumla geri gönder", aciklama: "Seçtiğin aşama notunla yeniden çalışır; sonraki aşamalar yeniden yazılmaz, yeniden doğrulanır." },
  bir_tur_daha: { etiket: "Bir tur daha", aciklama: "Bulgularla aynı ajana bir tur daha ver." },
  claude_devral: { etiket: "Bu aşamayı Claude'a devret", aciklama: "Yerel model tıkandı; bu aşama Claude ile devam etsin." },
  devam: { etiket: "Olduğu gibi kabul et", aciklama: "Bulgulara rağmen sonraki aşamaya geç." },
  tekrar_dene: { etiket: "Tekrar dene", aciklama: "Aynı adımı yeniden çalıştır (ör. giriş yaptıktan ya da Ollama'yı açtıktan sonra)." },
  atla: { etiket: "Bu aşamayı atla", aciklama: "Aşamayı çıktısı olmadan geç; sonraki aşamalar eksik girdiyle çalışabilir." },
  butce_artir: { etiket: "Bütçeyi artır ve devam et", aciklama: "Fikir bütçesini %50 (en az 1 $) artır." },
  durdur: { etiket: "Durdur", aciklama: "İşi durdur; sonra kaldığı yerden devam ettirebilirsin.", tehlikeli: true },
};

const SECIM_ETIKET: Record<string, string> = {
  devam: "Olduğu gibi kabul edildi, devam", bir_tur_daha: "Bir tur daha verildi", tekrar_dene: "Tekrar denendi",
  atla: "Aşama atlandı", butce_artir: "Bütçe artırıldı", kabul: "Kabul edildi", geri_gonder: "Notla geri gönderildi",
  claude_devral: "Aşama Claude'a devredildi", durdur: "Durduruldu",
};

function secenekler(anahtarlar: string[], onerilen?: string): Secenek[] {
  const sirali = onerilen && anahtarlar.includes(onerilen) ? [onerilen, ...anahtarlar.filter((a) => a !== onerilen)] : anahtarlar;
  return sirali.map((a, i) => ({ anahtar: a, ...SECENEK_TANIM[a], onerilen: i === 0 && !SECENEK_TANIM[a].tehlikeli }));
}

type Sonuc = "ok" | "bekle" | "dur";

/** Yazma alanı girdisini gösterir: klasörse sonuna "/" ekler (test-be.sh gibi dosyalara eklemez). */
function klasorGibi(y: string): string {
  return /\.[a-z0-9]+$/i.test(y) ? y : `${y}/`;
}

function ozetSatiri(metin: string): string {
  for (const satir of (metin ?? "").split("\n")) {
    const s = satir.trim().replace(/^[#>*\-| ]+/, "").trim();
    if (s && !s.startsWith("```")) return kisalt(s, 140);
  }
  return "";
}

function citAyikla(metin: string): string {
  const s = metin.trim();
  if (s.startsWith("```")) {
    const ilk = s.split("\n", 1)[0];
    const govde = s.slice(ilk.length + 1).trimEnd();
    if (["", "markdown", "md"].includes(ilk.replace(/`/g, "").trim().toLowerCase()) && govde.endsWith("```")) return govde.slice(0, -3).trimEnd();
  }
  return s;
}

function testOzeti(cikti: string, kod: number): string {
  const satirlar = (cikti ?? "").split("\n").map((s) => s.trim()).filter((s) => s && !/^[-=]+$/.test(s));
  const onemli = satirlar.filter((s) => /^(# |ℹ )?(Ran |OK|FAILED|tests |pass |fail )/.test(s) || / passed| failed/.test(s));
  const secilen = onemli.length ? onemli.slice(-3) : satirlar.slice(-2);
  return kisalt((kod === 0 ? "Yeşil" : `Kırmızı (çıkış kodu ${kod})`) + (secilen.length ? " · " + secilen.join(" · ") : ""), 200);
}

export class Orkestrator {
  private durdurIstekleri = new Set<string>();
  private surecler = new Map<string, Set<import("node:child_process").ChildProcess>>();
  private kuyrukListe: string[] = [];
  private calisanlar = new Set<string>();
  private tekrar = new Set<string>();

  constructor(
    private calisma: string,
    private cfg: Ayarlar,
    private depo: Depo,
    readonly kartlar: Map<string, AjanKarti>,
    readonly akislar: Map<string, Akis>,
    readonly motorlar: Map<string, Motor>,
  ) {
    for (const k of kartlar.values()) {
      if (!motorlar.has(k.motor) || k.motor === "deneme") {
        throw new KovanHatasi(`ajanlar/${k.id}.md: motor '${k.motor}' tanımlı değil (claude ya da kovan.yaml'daki motorlar: ${[...motorlar.keys()].filter((m) => m !== "deneme").join(", ")})`);
      }
    }
    this.kurtar();
  }

  // ================================ motor seçimi ================================
  private motorSec(f: Fikir, kart: AjanKarti, asama?: Asama, uretici = false): Motor {
    if (f.motor === "deneme") return this.motorlar.get("deneme")!;
    if (f.motor === "hibrit") {
      if (uretici && asama && f.istisnalar?.[asama.id]) return this.motorlar.get(f.istisnalar[asama.id]) ?? this.motorlar.get("claude")!;
      return this.motorlar.get(kart.motor) ?? this.motorlar.get("claude")!;
    }
    return this.motorlar.get("claude")!;
  }

  private gerekenMotorlar(akis: Akis, mod: Mod): string[] {
    if (mod !== "hibrit") return [mod];
    const adlar = new Set<string>();
    for (const a of akis.asamalar) {
      for (const r of [a.ajan, ...a.dogrulama.map((v) => v.inceleyen)]) if (r) adlar.add(this.kartlar.get(r)!.motor);
    }
    return adlar.size ? [...adlar] : ["claude"];
  }

  private devralinabilir(f: Fikir, asama: Asama): boolean {
    if (f.motor !== "hibrit" || !asama.ajan) return false;
    return this.motorSec(f, this.kartlar.get(asama.ajan)!, asama, true).yerel;
  }

  // ================================ dış arayüz ================================
  async yeniFikir(baslik: string, metin: string, profil: string, mod: string): Promise<string> {
    metin = (metin ?? "").trim();
    if (!metin) throw new KovanHatasi("Fikir metni boş olamaz.");
    const akis = this.akislar.get(profil);
    if (!akis) throw new KovanHatasi(`Bilinmeyen akış: ${profil}`);
    if (!MODLAR.includes(mod as Mod)) throw new KovanHatasi(`Bilinmeyen mod: ${mod} (hibrit, claude ya da deneme)`);
    for (const ad of this.gerekenMotorlar(akis, mod as Mod)) {
      const m = this.motorlar.get(ad)!;
      if (!(await m.saglik(true))) {
        throw new KovanHatasi(`'${ad}' motoru hazır değil: ${m.hata}${m.yerel ? " Yerel motor olmadan çalıştırmak için 'Hepsi Claude' modunu seç." : ""}`);
      }
    }
    const fid = this.depo.yeniId();
    const d = path.join(this.calisma, fid);
    for (const alt of ["belgeler", "kod", "incelemeler", "gunluk", ".kovan"]) fs.mkdirSync(path.join(d, alt), { recursive: true });
    fs.writeFileSync(path.join(d, "belgeler", "fikir.md"), metin + "\n", "utf8");
    // Ajan kod/ kökünde çıplak `npm install` çalıştırırsa npm üst klasörlere çıkıp Kovan'ın kendi
    // package.json'ını değiştirmesin diye kod/ kendi (boş) paket kökü olur.
    fs.writeFileSync(path.join(d, "kod", "package.json"), JSON.stringify({
      name: `kovan-${fid.toLowerCase()}`, private: true,
      description: "Kovan çalışma alanı kökü. Kod backend/, frontend/ ve testler/ altında; npm'i --prefix ile çalıştır.",
    }, null, 2) + "\n", "utf8");
    const zaman = simdi();
    this.depo.fikirEkle({
      id: fid, baslik: (baslik ?? "").trim() || kisalt(metin.split("\n")[0], 70), metin, profil, motor: mod as Mod,
      durum: "sirada", asama_idx: 0, tur: 1, faz: "uret", ek_tur: 0, soru_turu: 0, geri_bildirim: null, bekleme: null,
      butce_usd: akis.fikir_butcesi_usd, maliyet_usd: 0, girdi_token: 0, cikti_token: 0, istisnalar: {},
      olusturma: zaman, guncelleme: zaman, baslama: null, bitis: null,
    });
    this.planla(fid);
    return fid;
  }

  /** Sistem kararı (tur sınırı, hata, bütçe, teslim, kesinti). */
  kararVer(fid: string, secim: string, not = "", hedef: string | null = null): void {
    not = (not ?? "").trim();
    const f = this.fikirAl(fid);
    if (f.durum !== "bekliyor" || !f.bekleme) throw new KovanHatasi("Bu fikir şu an senden karar beklemiyor.");
    const b = f.bekleme;
    if (b.sebep === "ajan_sorusu" && secim !== "durdur") throw new KovanHatasi("Bu bekleme bir ajan sorusu; cevaplarını gönder.");
    if (secim !== "durdur" && !b.secenekler.some((s) => s.anahtar === secim)) throw new KovanHatasi(`Bu bekleme için geçersiz seçim: ${secim}`);
    const akis = this.akislar.get(f.profil)!;
    const idx = f.asama_idx;
    const asama = akis.asamalar[idx] ?? null;
    const g: Partial<Fikir> = { bekleme: null, durum: "sirada" };
    const notEkle = (gb: string | null) => ((gb ?? "") + (not ? `\n\n### İnsanın notu\n${not}` : "")).trim();

    switch (secim) {
      case "durdur":
        Object.assign(g, { durum: "durduruldu", bitis: simdi() });
        break;
      case "devam": case "kabul": case "atla":
        if (secim === "devam" && asama?.kilitle.length) this.kilitle(fid, asama);
        if (secim === "atla" && asama) this.sistemAdimi(fid, asama, "Atlandı", "atlandi", "Aşama senin kararınla atlandı.");
        Object.assign(g, this.ilerlemeAlanlari(fid, akis, idx + 1));
        break;
      case "bir_tur_daha":
        Object.assign(g, { ek_tur: f.ek_tur + 1, tur: f.tur + 1, faz: "uret", geri_bildirim: notEkle(f.geri_bildirim) });
        break;
      case "tekrar_dene":
        if (not && f.faz === "uret") g.geri_bildirim = notEkle(f.geri_bildirim);
        break;
      case "claude_devral":
        if (!asama) throw new KovanHatasi("Devredilecek aşama yok.");
        g.istisnalar = { ...f.istisnalar, [asama.id]: "claude" };
        if (b.sebep === "tur_siniri") Object.assign(g, { ek_tur: f.ek_tur + 1, tur: f.tur + 1, faz: "uret", geri_bildirim: notEkle(f.geri_bildirim) });
        else if (not) g.geri_bildirim = notEkle(f.geri_bildirim);
        break;
      case "butce_artir":
        g.butce_usd = Math.round(Math.max(f.butce_usd * 1.5, f.butce_usd + 1) * 100) / 100;
        break;
      case "geri_gonder": {
        if (!not) throw new KovanHatasi("Geri gönderirken ne istediğini not olarak yaz.");
        let h = (hedef ?? "").trim() || asama?.geri_donus || null;
        if (!h) {
          const onceki = akis.asamalar.slice(0, idx).filter((a) => a.tur === "ajan");
          if (!onceki.length) throw new KovanHatasi("Geri gönderilecek bir ajan aşaması yok.");
          h = onceki.at(-1)!.id;
        }
        const hidx = akis.asamalar.findIndex((a) => a.id === h);
        if (hidx < 0) throw new KovanHatasi(`Böyle bir aşama yok: ${h}`);
        if (hidx >= idx || akis.asamalar[hidx].tur !== "ajan") throw new KovanHatasi("Yalnızca önceki bir ajan aşamasına geri gönderebilirsin.");
        Object.assign(g, { asama_idx: hidx, tur: 1, faz: "uret", ek_tur: 0, soru_turu: 0, geri_bildirim: `### İnsanın notu\n${not}` });
        break;
      }
      default:
        throw new KovanHatasi(`Bilinmeyen seçim: ${secim}`);
    }
    const etiket = (SECIM_ETIKET[secim] ?? secim) + (not ? ` · Not: ${not}` : "");
    this.depo.adimGuncelle(fid, b.adim_id, { durum: "karar", bitis: simdi(), ozet: kisalt(`${b.mesaj} → ${etiket}`, 300) });
    this.depo.fikirGuncelle(fid, g);
    if (g.durum === "sirada") { this.durdurIstekleri.delete(fid); this.planla(fid); }
  }

  /** Ajanın sorularına insanın cevapları. Cevaplar karar defterine yazılır, aynı adım yeniden çalışır. */
  cevapla(fid: string, cevaplar: Cevap[]): void {
    const f = this.fikirAl(fid);
    const b = f.bekleme;
    if (f.durum !== "bekliyor" || !b || b.sebep !== "ajan_sorusu" || !b.sorular) throw new KovanHatasi("Bu fikir şu an bir ajan sorusu beklemiyor.");
    if (!Array.isArray(cevaplar) || cevaplar.length !== b.sorular.length) throw new KovanHatasi("Her soruya bir cevap ver.");
    const yeni: Karar[] = b.sorular.map((s, i) => {
      const c = cevaplar[i] ?? { secilenler: [] };
      const secilen = (c.secilenler ?? []).map((e) => String(e).replace(/\s*\(Önerilen\)\s*$/i, "").trim()).filter(Boolean);
      const serbest = String(c.serbest ?? "").trim();
      if (!secilen.length && !serbest) throw new KovanHatasi(`"${s.baslik}" sorusunu cevapla: bir seçenek seç ya da kendi cevabını yaz.`);
      if (!s.coklu && secilen.length > 1) throw new KovanHatasi(`"${s.baslik}" sorusunda tek seçenek seçilebilir.`);
      return {
        zaman: simdi(), asama_id: b.asama_id, asama_ad: b.asama_ad, soran: s.soran_ad, baslik: s.baslik, soru: s.soru,
        cevap: [secilen.join(", "), serbest].filter(Boolean).join(" · Not: "),
      };
    });
    const kararlar = [...this.kararlar(fid), ...yeni];
    this.kararlariYaz(fid, kararlar);
    this.depo.adimGuncelle(fid, b.adim_id, {
      durum: "karar", bitis: simdi(), ozet: kisalt("Cevaplandı: " + yeni.map((k) => `${k.baslik} → ${k.cevap}`).join(" · "), 300),
      dosya: "belgeler/kararlar.md",
    });
    const g: Partial<Fikir> = { bekleme: null, durum: "sirada", soru_turu: f.soru_turu + 1 };
    // Üretici sorduysa aynı adım kararla yeniden çalışır; onaycı sorduysa üretici kararı ve bulguları yeni turda işler.
    if (b.kaynak === "inceleme") Object.assign(g, { faz: "uret", tur: f.tur + 1, geri_bildirim: b.bekleyen_geri_bildirim ?? null });
    this.depo.fikirGuncelle(fid, g);
    this.durdurIstekleri.delete(fid);
    this.planla(fid);
  }

  durdur(fid: string): void {
    const f = this.fikirAl(fid);
    if (f.durum === "sirada" || f.durum === "calisiyor") {
      this.durdurIstekleri.add(fid);
      for (const p of this.surecler.get(fid) ?? []) sureciOldur(p);
      const sirada = this.kuyrukListe.indexOf(fid);
      if (sirada >= 0) this.kuyrukListe.splice(sirada, 1);
      if (!this.calisanlar.has(fid)) this.durdurUygula(fid);
    } else if (f.durum === "bekliyor") {
      if (f.bekleme) this.depo.adimGuncelle(fid, f.bekleme.adim_id, { durum: "karar", bitis: simdi(), ozet: kisalt(`${f.bekleme.mesaj} → Durduruldu`, 300) });
      this.depo.fikirGuncelle(fid, { durum: "durduruldu", bekleme: null, bitis: simdi() });
    } else {
      throw new KovanHatasi("Bu fikir zaten durmuş ya da bitmiş.");
    }
  }

  devamEttir(fid: string): void {
    const f = this.fikirAl(fid);
    if (f.durum !== "durduruldu") throw new KovanHatasi("Yalnızca durdurulmuş bir fikir devam ettirilebilir.");
    this.depo.fikirGuncelle(fid, { durum: "sirada", bitis: null });
    this.sistemAdimi(fid, null, "Devam", "tamam", "Kaldığı yerden devam ediyor.");
    this.planla(fid);
  }

  fikirListesi(): FikirOzeti[] {
    return this.depo.fikirler().map((f) => {
      const akis = this.akislar.get(f.profil);
      const asama = akis?.asamalar[f.asama_idx];
      return {
        id: f.id, baslik: f.baslik, durum: f.durum, profil: f.profil, akis_ad: akis?.ad ?? f.profil, motor: f.motor,
        maliyet_usd: f.maliyet_usd, butce_usd: f.butce_usd, olusturma: f.olusturma, guncelleme: f.guncelleme, asama_ad: asama?.ad ?? "Teslim",
        asama_no: f.asama_idx + 1, asama_sayisi: akis?.asamalar.length ?? 0, bekleme_sebebi: f.bekleme?.sebep ?? null,
      };
    });
  }

  fikirDetayi(fid: string): FikirDetayi {
    const f = this.fikirAl(fid);
    const akis = this.akislar.get(f.profil);
    const adimlar = this.depo.adimlar(fid);
    const asamalar = (akis?.asamalar ?? []).map((a, i): AsamaGorunumu => {
      let durum: AsamaGorunumu["durum"];
      if (f.durum === "tamamlandi" || i < f.asama_idx) durum = adimlar.some((s) => s.asama_id === a.id && s.durum === "atlandi") ? "atlandi" : "tamam";
      else if (i === f.asama_idx) durum = ({ bekliyor: "bekliyor", calisiyor: "aktif", sirada: "sirada", durduruldu: "durdu" } as Record<string, AsamaGorunumu["durum"]>)[f.durum] ?? "aktif";
      else durum = "bekleyen";
      return {
        id: a.id, ad: a.ad, tur: a.tur, durum, ajan: a.ajan ? this.kartlar.get(a.ajan)!.kisaltma : "Sen",
        ajan_ad: a.ajan ? this.kartlar.get(a.ajan)!.ad : "Sen",
        motor: a.ajan ? this.motorSec(f, this.kartlar.get(a.ajan)!, a, true).ad : null,
        yazabilir: a.yazabilir, kilitle: a.kilitle, en_fazla_tur: a.en_fazla_tur, onaylar: this.onayRozetleri(a, adimlar),
      };
    });
    const motorCagrilari: Record<string, number> = {};
    for (const s of adimlar) if ((s.tip === "uret" || s.tip === "inceleme") && s.motor) motorCagrilari[s.motor] = (motorCagrilari[s.motor] ?? 0) + 1;
    return {
      fikir: f,
      akis_ad: akis?.ad ?? f.profil,
      asamalar,
      adimlar,
      bekleme: f.bekleme,
      kararlar: this.kararlar(fid),
      dosyalar: this.dosyaListesi(fid),
      onizlemeler: this.onizlemeler(fid),
      aktif_sure_sn: Math.round(adimlar.filter((s) => s.tip !== "sistem").reduce((t, s) => t + (s.sure_sn ?? 0), 0) * 10) / 10,
      ajan_cagrisi: adimlar.filter((s) => s.tip === "uret" || s.tip === "inceleme").length,
      motor_cagrilari: motorCagrilari,
    };
  }

  private onayRozetleri(a: Asama, adimlar: Adim[]): OnayRozeti[] {
    return a.dogrulama.map((v) => {
      if (v.tip === "komut") {
        const son = adimlar.filter((s) => s.asama_id === a.id && s.tip === "kontrol" && s.ajan_ad === v.ad).at(-1);
        return { ad: v.ad, kisa: "TEST", durum: son?.durum ?? null };
      }
      const kart = this.kartlar.get(v.inceleyen!)!;
      const son = adimlar.filter((s) => s.asama_id === a.id && s.tip === "inceleme" && s.ajan === kart.id).at(-1);
      return { ad: `${v.ad} · ${kart.ad}`, kisa: kart.kisaltma, durum: son?.durum ?? null };
    });
  }

  dosyaYolu(fid: string, yol: string): string {
    this.fikirAl(fid);   // bilinmeyen id (ör. "../") burada 404 olur
    const kok = fs.realpathSync(path.join(this.calisma, fid));
    const aday = path.resolve(kok, yol);
    if (!aday.startsWith(kok + path.sep)) throw new KovanHatasi("Bu dosyaya erişilemez.", 403);
    if (!fs.existsSync(aday) || !fs.statSync(aday).isFile()) throw new KovanHatasi(`Dosya yok: ${yol}`, 404);
    const gercek = fs.realpathSync(aday);
    if (!gercek.startsWith(kok + path.sep)) throw new KovanHatasi("Bu dosyaya erişilemez.", 403);
    return gercek;
  }

  dosyaOku(fid: string, yol: string): DosyaIcerigi {
    const veri = fs.readFileSync(this.dosyaYolu(fid, yol));
    const kesildi = veri.length > 300_000;
    let icerik: string;
    try { icerik = new TextDecoder("utf-8", { fatal: true }).decode(veri.subarray(0, 300_000)); }
    catch { icerik = "(ikili dosya, gösterilemiyor)"; }
    return { yol, icerik, kesildi, boyut: veri.length };
  }

  // ================================ çalıştırma ================================
  private fikirAl(fid: string): Fikir {
    const f = this.depo.fikir(fid);
    if (!f) throw new KovanHatasi(`Fikir bulunamadı: ${fid}`, 404);
    return f;
  }

  /** Sunucu kapanıp açıldıysa yarıda kalan işleri insanın kararına bırakır. */
  private kurtar(): void {
    this.depo.calisanAdimlariKapat();
    for (const f of this.depo.durumdakiler("calisiyor", "sirada")) {
      const asama = this.akislar.get(f.profil)?.asamalar[f.asama_idx] ?? null;
      this.bekleyeAl(f.id, asama, "kesildi", "Kovan yeniden başladı; bu iş yarıda kalmıştı. Kaldığı yerden devam edebilirsin.",
        secenekler(["tekrar_dene", "durdur"], "tekrar_dene"));
    }
  }

  private planla(fid: string): void {
    if (this.kuyrukListe.includes(fid)) return;
    if (this.calisanlar.has(fid)) { this.tekrar.add(fid); return; }
    this.kuyrukListe.push(fid);
    this.pompala();
  }

  private pompala(): void {
    while (this.calisanlar.size < Math.max(1, this.cfg.paralel_fikir) && this.kuyrukListe.length) {
      const fid = this.kuyrukListe.shift()!;
      this.calisanlar.add(fid);
      void this.calistirGuvenli(fid).finally(() => {
        this.calisanlar.delete(fid);
        if (this.tekrar.delete(fid)) this.planla(fid);
        this.pompala();
      });
    }
  }

  /** Testler ve kapanış için: sırada ya da çalışan iş kalmayana kadar bekler. */
  async bosalt(zamanAsimiMs = 60_000): Promise<void> {
    const t0 = Date.now();
    while ((this.calisanlar.size || this.kuyrukListe.length) && Date.now() - t0 < zamanAsimiMs) await bekle(20);
  }

  private async calistirGuvenli(fid: string): Promise<void> {
    try {
      await this.calistir(fid);
    } catch (e) {
      const iz = (e as Error).stack ?? String(e);
      try {
        fs.writeFileSync(path.join(this.calisma, fid, "gunluk", "orkestrator-hatasi.txt"), iz, "utf8");
        this.bekleyeAl(fid, null, "hata", `Orkestratör hatası: ${(e as Error).message}`, secenekler(["tekrar_dene", "durdur"], "tekrar_dene"), kisalt(iz, 3000));
      } catch (e2) {
        console.error(e2);
      }
    }
  }

  private async calistir(fid: string): Promise<void> {
    let f = this.depo.fikir(fid);
    if (!f || (f.durum !== "sirada" && f.durum !== "calisiyor")) return;
    if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return; }
    const akis = this.akislar.get(f.profil);
    if (!akis) { this.bekleyeAl(fid, null, "hata", `Akış bulunamadı: ${f.profil}`, secenekler(["durdur"])); return; }
    this.depo.fikirGuncelle(fid, { durum: "calisiyor", baslama: f.baslama ?? simdi() });
    for (;;) {
      if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return; }
      f = this.depo.fikir(fid)!;
      const idx = f.asama_idx;
      if (idx >= akis.asamalar.length) {
        this.depo.fikirGuncelle(fid, { durum: "tamamlandi", bitis: simdi() });
        this.sistemAdimi(fid, null, "Teslim", "tamam", "Akış tamamlandı.");
        return;
      }
      if ((await this.asamaYurut(fid, akis.asamalar[idx])) !== "ok") return;
      this.depo.fikirGuncelle(fid, this.ilerlemeAlanlari(fid, akis, idx + 1));
    }
  }

  private async asamaYurut(fid: string, asama: Asama): Promise<Sonuc> {
    if (asama.tur === "insan") {
      return this.bekleyeAl(fid, asama, "insan", asama.soru || "Onayın gerekiyor.", secenekler(["kabul", "geri_gonder", "durdur"], "kabul"),
        this.teslimOzeti(fid));
    }
    for (;;) {
      if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return "dur"; }
      const f = this.depo.fikir(fid)!;
      const tur = f.tur;
      const sinir = asama.en_fazla_tur + f.ek_tur;
      let ekBulgular: string[] = [];
      if (f.faz !== "dogrula") {
        const [r, ek] = await this.uret(fid, asama, tur, f.geri_bildirim);
        if (r !== "ok") return r;
        ekBulgular = ek;
        this.depo.fikirGuncelle(fid, { faz: "dogrula" });
      }
      const [bulgular, r] = await this.dogrula(fid, asama, tur, ekBulgular);
      if (r !== "ok") return r;
      if (!bulgular.length) {
        if (asama.kilitle.length) this.kilitle(fid, asama);
        return "ok";
      }
      const gb = [...ekBulgular, ...bulgular].join("\n\n");
      if (tur >= sinir) {
        this.depo.fikirGuncelle(fid, { faz: "uret", geri_bildirim: gb });
        const devral = this.devralinabilir(this.depo.fikir(fid)!, asama);
        const anahtarlar = ["bir_tur_daha", ...(devral ? ["claude_devral"] : []), "devam", "durdur"];
        return this.bekleyeAl(fid, asama, "tur_siniri", `'${asama.ad}' ${tur} turda onay alamadı. Bulgular aşağıda; nasıl ilerleyelim?`,
          secenekler(anahtarlar, devral ? "claude_devral" : "bir_tur_daha"), gb);
      }
      this.depo.fikirGuncelle(fid, { tur: tur + 1, faz: "uret", geri_bildirim: gb });
    }
  }

  // ---------------------------------- üret ----------------------------------
  private async uret(fid: string, asama: Asama, tur: number, geriBildirim: string | null): Promise<[Sonuc, string[]]> {
    const kart = this.kartlar.get(asama.ajan!)!;
    const f = this.depo.fikir(fid)!;
    const motor = this.motorSec(f, kart, asama, true);
    const model = motor.modelSec(kart);
    const d = path.join(this.calisma, fid);
    const dizinModu = asama.calisma_dizini === "kod";
    const cwd = path.join(d, dizinModu ? "kod" : "belgeler");
    if (asama.kilitle.length) this.kilitKaldir(fid, asama.kilitle);
    const istem = this.uretimIstemi(fid, asama, geriBildirim, dizinModu);
    const sistem = [kart.govde.trim(), ORTAK_KURALLAR, this.soruKurallari(f)].filter(Boolean).join("\n\n");
    let son: AjanSonucu | null = null;
    let sonHata = "";
    let deneme = 0;
    for (deneme = 1; deneme <= this.cfg.deneme_sayisi; deneme++) {
      if (this.butceAsildi(fid)) return [this.butceBeklemesi(fid, asama), []];
      const adim = this.depo.adimEkle({ fikir_id: fid, asama_id: asama.id, asama_ad: asama.ad, tip: "uret", ajan: kart.id, ajan_ad: kart.ad, tur, deneme, durum: "calisiyor", motor: motor.ad, model });
      if (dizinModu) this.onKopyaAl(fid);
      const cagri: AjanCagrisi = {
        rol: kart.id, asama_id: asama.id, gorev_turu: "uret", sistem, istem, model, araclar: [...kart.araclar],
        izinli: [...kart.izinli_komutlar], cwd, sure_sn: kart.sure_dk * 60, sistem_modu: kart.sistem_promptu,
        butce_usd: kart.butce_usd, sema: null, efor: kart.efor, surecCb: this.surecKaydedici(fid),
      };
      son = await motor.calistir(cagri);
      const gunluk = this.gunlukYaz(fid, adim, motor, cagri, son);
      this.depo.maliyetEkle(fid, son.maliyet, son.girdi_token, son.cikti_token);
      const ek = dizinModu ? [...this.alanDenetle(fid, asama, kart), ...this.kilitDenetle(fid, asama, kart)] : [];
      if (this.durdurIstekleri.has(fid)) {
        this.adimKapat(fid, adim, "durduruldu", son, "Kullanıcı durdurdu", gunluk);
        this.durdurUygula(fid);
        return ["dur", []];
      }
      if (son.ok) {
        const soru = this.cfg.ajan_sorulari ? soruCikar(son.metin) : null;
        if (soru?.sorular) {
          this.adimKapat(fid, adim, "soru", son, `${soru.sorular.length} soru: ${soru.sorular.map((s) => s.baslik).join(", ")}`, gunluk);
          return [this.ajanSorusuBeklemesi(fid, asama, [{ kart, sorular: soru.sorular }], "uret"), []];
        }
        if (soru?.hata) {
          sonHata = `Soru bloğu okunamadı: ${soru.hata}`;
          this.adimKapat(fid, adim, "hata", son, sonHata, gunluk);
          continue;
        }
      }
      if (son.ok && (son.metin.trim() || dizinModu)) {
        const metin = son.metin.trim() || "(ajan özet yazmadı)";
        const yol = this.belgeKaydet(fid, asama.cikti!, dizinModu ? metin : citAyikla(metin), adim);
        this.adimKapat(fid, adim, "tamam", son, ozetSatiri(metin), yol);
        if (metin.includes("TEST ŞÜPHESİ")) {
          this.sistemAdimi(fid, asama, "Test şüphesi", "uyari", kisalt(metin.split("TEST ŞÜPHESİ")[1].replace(/^[:\s]+/, ""), 400));
        }
        return ["ok", ek];
      }
      sonHata = son.hata ?? "Ajan boş çıktı döndürdü";
      this.adimKapat(fid, adim, son.zaman_asimi ? "takildi" : "hata", son, sonHata, gunluk);
      if (son.kalici_hata) break;
      await this.tekrarOncesiBekle(motor, deneme);
    }
    const anahtarlar = ["tekrar_dene", ...(this.devralinabilir(f, asama) ? ["claude_devral"] : []), "atla", "durdur"];
    return [this.bekleyeAl(fid, asama, "hata", `${kart.ad} başarısız oldu (${Math.min(deneme, this.cfg.deneme_sayisi)} deneme): ${sonHata}`,
      secenekler(anahtarlar, "tekrar_dene")), []];
  }

  // -------------------------------- doğrula ---------------------------------
  private async dogrula(fid: string, asama: Asama, tur: number, ekBulgular: string[] = []): Promise<[string[], Sonuc]> {
    const bulgular: string[] = [];
    for (const v of asama.dogrulama.filter((x) => x.tip === "komut")) {
      if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return [[], "dur"]; }
      const [yesil, cikti] = await this.komutKos(fid, asama, v, tur);
      if (yesil === null) return [[], "dur"];
      if (!yesil) {
        bulgular.push(`### ${v.ad}: KIRMIZI\nKomut: \`${v.komut}\`\n\`\`\`\n${kuyruk(cikti, 3500)}\n\`\`\``);
        return [bulgular, "ok"];   // kırmızı koda onay kurulu harcanmaz
      }
    }
    const kurul = asama.dogrulama.filter((x) => x.tip === "ajan");
    if (!kurul.length) return [bulgular, "ok"];
    if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return [[], "dur"]; }
    if (this.butceAsildi(fid)) return [[], this.butceBeklemesi(fid, asama)];

    let sonuclar: IncelemeSonucu[];
    if (this.cfg.paralel_inceleme && kurul.length > 1) {
      sonuclar = await Promise.all(kurul.map((v) => this.incele(fid, asama, v, tur)));
    } else {
      sonuclar = [];
      for (const v of kurul) {
        const s = await this.incele(fid, asama, v, tur);
        sonuclar.push(s);
        if (s.tur === "dur") break;
      }
    }
    if (this.durdurIstekleri.has(fid) || sonuclar.some((s) => s.tur === "dur")) { this.durdurUygula(fid); return [[], "dur"]; }
    const hatalar = sonuclar.map((s, i) => [kurul[i], s] as const).filter(([, s]) => s.tur === "hata");
    if (hatalar.length) {
      const mesaj = hatalar.map(([v, s]) => `${this.kartlar.get(v.inceleyen!)!.ad}: ${s.mesaj}`).join("; ");
      return [[], this.bekleyeAl(fid, asama, "hata", `Onay kurulu tamamlanamadı. ${mesaj}`, secenekler(["tekrar_dene", "atla", "durdur"], "tekrar_dene"))];
    }
    sonuclar.forEach((s, i) => {
      if (s.tur === "ok" && s.karar!.karar === "DUZELT") {
        const kart = this.kartlar.get(kurul[i].inceleyen!)!;
        const maddeler = s.karar!.bulgular.map((b) => `- ${b}`).join("\n") || "- (madde yazılmadı)";
        bulgular.push(`### ${kurul[i].ad} (${kart.ad}): DÜZELT\nGerekçe: ${s.karar!.gerekce}\n${maddeler}`);
      }
    });
    // Onaycı sorusu: insan cevaplayınca üretici, kararı ve aynı turdaki DÜZELT bulgularını tek turda işler.
    const soranlar = sonuclar.map((s, i) => [kurul[i], s] as const).filter(([, s]) => s.tur === "soru");
    if (soranlar.length) {
      const notlar = soranlar.map(([v]) => `### ${v.ad} (${this.kartlar.get(v.inceleyen!)!.ad}): SORU\n` +
        "Karar vermek için insana sordu; cevap \"İnsan kararları\" bölümünde. Çıktını bu karara göre gözden geçir, gerekiyorsa güncelle.");
      return [[], this.ajanSorusuBeklemesi(fid, asama, soranlar.map(([v, s]) => ({ kart: this.kartlar.get(v.inceleyen!)!, sorular: s.sorular! })),
        "inceleme", [...ekBulgular, ...bulgular, ...notlar].join("\n\n"), bulgular.length ? bulgular.join("\n\n") : null)];
    }
    return [bulgular, "ok"];
  }

  private async komutKos(fid: string, asama: Asama, v: Dogrulayici, tur: number): Promise<[boolean | null, string]> {
    const d = path.join(this.calisma, fid);
    const adim = this.depo.adimEkle({ fikir_id: fid, asama_id: asama.id, asama_ad: asama.ad, tip: "kontrol", ajan: "-", ajan_ad: v.ad, tur, deneme: 1, durum: "calisiyor", motor: "sistem", model: null });
    const kaydet = this.surecKaydedici(fid);
    const t0 = Date.now();
    const { kod, cikti, zamanAsimi } = await new Promise<{ kod: number; cikti: string; zamanAsimi: boolean }>((coz) => {
      let cikti = "";
      let zamanAsimi = false;
      const p = spawn("bash", ["-c", v.komut!], { cwd: path.join(d, "kod"), detached: true, stdio: ["ignore", "pipe", "pipe"] });
      kaydet(p, false);
      p.stdout!.setEncoding("utf8").on("data", (x) => { cikti += x; });
      p.stderr!.setEncoding("utf8").on("data", (x) => { cikti += x; });
      const saat = setTimeout(() => { zamanAsimi = true; sureciOldur(p); }, v.sure_dk * 60_000);
      p.on("error", (e) => { clearTimeout(saat); kaydet(p, true); coz({ kod: -1, cikti: `Komut çalıştırılamadı: ${e.message}`, zamanAsimi: false }); });
      p.on("close", (k) => { clearTimeout(saat); kaydet(p, true); coz({ kod: k ?? -1, cikti: zamanAsimi ? `${cikti}\n(süre sınırı aşıldı: ${v.sure_dk} dk)` : cikti, zamanAsimi }); });
    });
    const sure = Math.round((Date.now() - t0) / 100) / 10;
    const yol = `gunluk/adim-${adim}-kontrol.txt`;
    fs.writeFileSync(path.join(d, yol), `$ ${v.komut}\n(çıkış kodu: ${kod})\n\n${cikti}`, "utf8");
    if (this.durdurIstekleri.has(fid)) {
      this.depo.adimGuncelle(fid, adim, { durum: "durduruldu", bitis: simdi(), sure_sn: sure, ozet: "Kullanıcı durdurdu", dosya: yol });
      this.durdurUygula(fid);
      return [null, cikti];
    }
    const yesil = kod === 0;
    this.depo.adimGuncelle(fid, adim, { durum: yesil ? "yesil" : zamanAsimi ? "takildi" : "kirmizi", bitis: simdi(), sure_sn: sure, ozet: testOzeti(cikti, kod), dosya: yol });
    return [yesil, cikti];
  }

  private async incele(fid: string, asama: Asama, v: Dogrulayici, tur: number): Promise<IncelemeSonucu> {
    const kart = this.kartlar.get(v.inceleyen!)!;
    const f = this.depo.fikir(fid)!;
    const motor = this.motorSec(f, kart);
    const model = motor.modelSec(kart);
    const dizinModu = asama.calisma_dizini === "kod";
    const cwd = path.join(this.calisma, fid, dizinModu ? "kod" : "belgeler");
    const istem = this.incelemeIstemi(fid, asama, v, tur, dizinModu);
    const sistem = [kart.govde.trim(), ORTAK_KURALLAR, INCELEME_KURALLARI, this.soruKurallari(f, true)].filter(Boolean).join("\n\n");
    let son: AjanSonucu | null = null;
    for (let deneme = 1; deneme <= this.cfg.deneme_sayisi; deneme++) {
      const adim = this.depo.adimEkle({ fikir_id: fid, asama_id: asama.id, asama_ad: asama.ad, tip: "inceleme", ajan: kart.id, ajan_ad: kart.ad, tur, deneme, durum: "calisiyor", motor: motor.ad, model });
      const cagri: AjanCagrisi = {
        rol: kart.id, asama_id: asama.id, gorev_turu: "inceleme", sistem, istem, model,
        araclar: dizinModu ? ["Read", "Glob", "Grep"] : [], izinli: [], cwd, sure_sn: v.sure_dk * 60,
        sistem_modu: dizinModu ? "ekle" : kart.sistem_promptu, butce_usd: kart.butce_usd, sema: KARAR_SEMASI, efor: kart.efor,
        surecCb: this.surecKaydedici(fid),
      };
      son = await motor.calistir(cagri);
      const gunluk = this.gunlukYaz(fid, adim, motor, cagri, son);
      this.depo.maliyetEkle(fid, son.maliyet, son.girdi_token, son.cikti_token);
      if (this.durdurIstekleri.has(fid)) { this.adimKapat(fid, adim, "durduruldu", son, "Kullanıcı durdurdu", gunluk); return { tur: "dur" }; }
      const ham = (son.yapisal ?? jsonCikar(son.metin)) as Record<string, unknown> | null;
      const kararAdi = String(ham?.karar ?? "").toUpperCase();
      if (son.ok && ham && kararAdi === "SORU" && this.cfg.ajan_sorulari) {
        const s = sorulariDogrula(ham.sorular);
        if (s.sorular) {
          const yol = this.incelemeKaydet(fid, asama, v, kart, tur, adim, { karar: "SORU", gerekce: String(ham.gerekce ?? ""), bulgular: s.sorular.map((x) => `SORU: ${x.soru}`) });
          this.adimKapat(fid, adim, "soru", son, `${s.sorular.length} soru: ${s.sorular.map((x) => x.baslik).join(", ")}`, yol);
          return { tur: "soru", sorular: s.sorular };
        }
      }
      if (son.ok && ham && (kararAdi === "ONAY" || kararAdi === "DUZELT")) {
        const hb = Array.isArray(ham.bulgular) ? ham.bulgular : ham.bulgular ? [ham.bulgular] : [];
        const karar = { karar: kararAdi, gerekce: String(ham.gerekce ?? ""), bulgular: hb.map(String).filter((b) => b.trim()).slice(0, 8) };
        const yol = this.incelemeKaydet(fid, asama, v, kart, tur, adim, karar);
        const durum = karar.karar === "ONAY" ? "onay" : "duzelt";
        let ozet = kisalt(karar.gerekce, 160);
        if (durum === "duzelt") ozet = `${karar.bulgular.length} bulgu · ${ozet}`;
        this.adimKapat(fid, adim, durum, son, ozet, yol);
        return { tur: "ok", karar };
      }
      this.adimKapat(fid, adim, son.zaman_asimi ? "takildi" : "hata", son, son.hata ?? "Karar (ONAY/DUZELT) okunamadı", gunluk);
      if (son.kalici_hata) break;
      await this.tekrarOncesiBekle(motor, deneme);
    }
    return { tur: "hata", mesaj: son?.hata || "karar okunamadı" };
  }

  // -------------------------------- istemler --------------------------------
  /** Soru hakkı yumuşak sınırdır: dolunca istem bunu söyler; ajan yine de sorarsa soru sana gelir
   *  (her soru senin cevabını beklediği için başıboş bir döngü oluşamaz). */
  private soruKurallari(f: Fikir, inceleme = false): string {
    if (!this.cfg.ajan_sorulari) return "";
    if (f.soru_turu >= this.cfg.en_fazla_soru_turu) return SORU_HAKKI_DOLDU;
    return inceleme ? INCELEME_SORU_KURALI : SORU_KURALLARI;
  }

  private kararBolumu(fid: string): string[] {
    const k = this.kararlar(fid);
    if (!k.length) return [];
    return ["", "## İnsan kararları", "Projenin sahibi bu kararları verdi; bağlayıcıdır:", ...k.flatMap((x) => [`### ${x.baslik}`, `Soru (${x.soran}): ${x.soru}`, `Cevap: ${x.cevap}`])];
  }

  private uretimIstemi(fid: string, asama: Asama, geriBildirim: string | null, dizinModu: boolean): string {
    const p = [`# Görev: ${asama.ad}`, "", asama.gorev || "-", ...this.kararBolumu(fid), "", "## Girdiler"];
    for (const g of asama.girdiler) p.push("", `### ${g}`, this.belgeOku(fid, g) || "(bu belge henüz yok)");
    if (dizinModu) {
      const kilitli = this.kilitOku(fid).yollar;
      const dosyalar = this.kodDosyalari(fid);
      p.push("", "## Çalışma dizini", "Şu an `kod/` klasöründesin. Bu klasörün dışına çıkma.");
      if (asama.yazabilir.length) p.push("YAZMA ALANIN (yalnızca buraya yazabilirsin; dışındaki her değişiklik sistemce geri alınır ve ihlal olarak kaydedilir): " + asama.yazabilir.map((y) => `\`${klasorGibi(y)}\``).join(", "));
      if (kilitli.length) p.push("KİLİTLİ (yalnızca okunur; değiştirirsen sistem geri alır ve ihlal olarak kaydeder): " + kilitli.map((k) => `\`${k}\``).join(", "));
      p.push("Mevcut dosyalar: " + (dosyalar.length ? dosyalar.slice(0, 80).map((x) => `\`${x}\``).join(", ") : "(boş)"));
    }
    if (geriBildirim) {
      const onceki = asama.cikti ? this.belgeOku(fid, asama.cikti) : "";
      if (dizinModu) p.push("", "## Önceki çalışman", "Önceki turdaki dosyaların yerinde duruyor; onları güncelle.");
      else if (onceki) p.push("", "## Önceki çıktın", onceki);
      p.push("", "## Düzeltme istekleri", geriBildirim, "", "Yalnızca bu isteklere göre düzelt; onaylanmış kısımları bozma.");
    }
    p.push("", "## Çıktı", dizinModu
      ? "İşin bitince son mesajında kısa bir özet yaz: ne yaptın, hangi dosyalar, testlerin son durumu."
      : "Yalnızca istenen belgeyi markdown olarak yaz. Giriş ya da kapanış cümlesi ekleme.");
    return p.join("\n");
  }

  private incelemeIstemi(fid: string, asama: Asama, v: Dogrulayici, tur: number, dizinModu: boolean): string {
    const yazar = this.kartlar.get(asama.ajan!)!;
    const p = [`# İnceleme: ${asama.ad} (tur ${tur})`, "", `Yazar: ${yazar.ad}. Bu onay kurulunda senin odağın:`,
      v.odak || "Çıktı, referans belgelerdeki gereksinimleri doğru ve eksiksiz karşılıyor mu?", ...this.kararBolumu(fid), ""];
    if (dizinModu) {
      p.push("## İncelenen", "Çalışma dizinindeki (`kod/`) dosyaları Read, Glob ve Grep ile oku. Dosya değiştiremezsin.");
      if (asama.yazabilir.length) p.push("Yazarın yazma alanı: " + asama.yazabilir.map((y) => `\`${klasorGibi(y)}\``).join(", "));
      p.push("", "### Yazarın özeti", this.belgeOku(fid, asama.cikti) || "-");
      const sonTest = this.depo.adimlar(fid).filter((s) => s.asama_id === asama.id && s.tip === "kontrol").at(-1);
      if (sonTest) p.push("", "### Son test sonucu", sonTest.ozet || "-");
    } else {
      p.push("## İncelenen belge", `### ${asama.cikti}`, this.belgeOku(fid, asama.cikti) || "(boş)");
    }
    p.push("", "## Referans belgeler");
    for (const g of asama.girdiler) p.push("", `### ${g}`, this.belgeOku(fid, g) || "(yok)");
    p.push("", "## Kararın", 'Yalnızca JSON döndür: {"karar": "ONAY" | "DUZELT" | "SORU", "gerekce": "...", "bulgular": ["..."], "sorular": []}');
    return p.join("\n");
  }

  // ----------------------------- karar defteri -----------------------------
  kararlar(fid: string): Karar[] {
    return jsonOku<Karar[]>(path.join(this.calisma, fid, ".kovan", "kararlar.json"), []);
  }

  private kararlariYaz(fid: string, kararlar: Karar[]): void {
    atomikYaz(path.join(this.calisma, fid, ".kovan", "kararlar.json"), JSON.stringify(kararlar, null, 2));
    const md = ["# Kararların", "", "Ajanların sorduğu ve senin cevapladığın kararlar. Sonraki bütün ajanlar bunları bağlayıcı kural olarak görür.", ""];
    for (const k of kararlar) md.push(`## ${k.baslik}`, `- Aşama: ${k.asama_ad ?? "-"} · soran: ${k.soran} · ${k.zaman}`, `- Soru: ${k.soru}`, `- **Cevap: ${k.cevap}**`, "");
    atomikYaz(path.join(this.calisma, fid, "belgeler", "kararlar.md"), md.join("\n"));
  }

  // --------------------------- yazma alanı ve kilitler ---------------------------
  private gizliMi(rel: string): boolean {
    const parcalar = rel.split("/");
    const ad = parcalar.at(-1)!;
    return parcalar.some((p) => YOKSAY_KLASOR.has(p)) || YOKSAY_DOSYA.has(ad) || YOKSAY_UZANTI.has(path.extname(ad));
  }

  /** kok altındaki dosyalar (göreli), yok sayılan klasörlere hiç girmeden. */
  private agac(kok: string): string[] {
    const sonuc: string[] = [];
    if (!fs.existsSync(kok)) return sonuc;
    const gez = (dizin: string, rel: string) => {
      for (const g of fs.readdirSync(dizin, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const r = rel ? `${rel}/${g.name}` : g.name;
        if (g.isDirectory()) { if (!YOKSAY_KLASOR.has(g.name)) gez(path.join(dizin, g.name), r); }
        else if (!this.gizliMi(r)) sonuc.push(r);
      }
    };
    gez(kok, "");
    return sonuc;
  }

  private agacHash(kok: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const rel of this.agac(kok)) {
      const p = path.join(kok, rel);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) m.set(rel, "link:" + fs.readlinkSync(p));
      else if (st.isFile()) m.set(rel, crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
    return m;
  }

  private onKopyaAl(fid: string): void {
    const d = path.join(this.calisma, fid);
    const onceki = path.join(d, ".kovan", "onceki");
    fs.rmSync(onceki, { recursive: true, force: true });
    for (const rel of this.agac(path.join(d, "kod"))) {
      const hedef = path.join(onceki, rel);
      fs.mkdirSync(path.dirname(hedef), { recursive: true });
      fs.cpSync(path.join(d, "kod", rel), hedef, { verbatimSymlinks: true });
    }
    fs.mkdirSync(onceki, { recursive: true });
  }

  /** Yazma alanı dışındaki ve kilitli yollardaki değişiklikleri çalıştırma öncesine geri alır. */
  private alanDenetle(fid: string, asama: Asama, kart: AjanKarti): string[] {
    const d = path.join(this.calisma, fid);
    const kod = path.join(d, "kod");
    const onceki = path.join(d, ".kovan", "onceki");
    if (!fs.existsSync(onceki)) return [];
    const once = this.agacHash(onceki);
    const sonra = this.agacHash(kod);
    const degisen = [...new Set([...once.keys(), ...sonra.keys()])].filter((k) => once.get(k) !== sonra.get(k)).sort();
    const kilitli = this.kilitOku(fid).yollar;
    const ihlaller: string[] = [];
    for (const rel of degisen) {
      const kilitte = kilitli.some((y) => altinda(rel, y));
      const alanDisi = asama.yazabilir.length > 0 && !asama.yazabilir.some((y) => altinda(rel, y));
      if (!kilitte && !alanDisi) continue;
      ihlaller.push(`${rel} (${kilitte ? "kilitli" : "alan dışı"})`);
      const hedef = path.join(kod, rel);
      fs.rmSync(hedef, { recursive: true, force: true });
      if (once.has(rel)) {
        fs.mkdirSync(path.dirname(hedef), { recursive: true });
        fs.cpSync(path.join(onceki, rel), hedef, { verbatimSymlinks: true });
      }
    }
    if (!ihlaller.length) return [];
    const liste = ihlaller.slice(0, 12).join(", ") + (ihlaller.length > 12 ? ` (+${ihlaller.length - 12})` : "");
    const not = `${kart.ad} sınır dışına yazdı: ${liste}. Sistem geri aldı.`;
    this.sistemAdimi(fid, asama, "Sınır ihlali", "ihlal", not);
    const alan = asama.yazabilir.map((y) => `\`${klasorGibi(y)}\``).join(", ") || "kilitli olmayan her yer";
    return [`### Sınır ihlali\n${not}\nYazma alanın: ${alan}. Kilitli: ${kilitli.join(", ") || "-"}. Bir test ya da tasarım yanlışsa değiştirme; son mesajında 'TEST ŞÜPHESİ:' diye gerekçesiyle yaz.`];
  }

  private kilitYolu(fid: string) { return path.join(this.calisma, fid, ".kovan", "kilitler.json"); }

  private kilitOku(fid: string): { yollar: string[]; hashler: Record<string, string> } {
    const v = jsonOku<{ yollar?: string[]; hashler?: Record<string, string> }>(this.kilitYolu(fid), {});
    return { yollar: v.yollar ?? [], hashler: v.hashler ?? {} };
  }

  private hashle(kod: string, yollar: string[]): Record<string, string> {
    const sonuc: Record<string, string> = {};
    for (const [k, h] of this.agacHash(kod)) if (yollar.some((y) => altinda(k, y))) sonuc[k] = h;
    return sonuc;
  }

  private kilitle(fid: string, asama: Asama): void {
    const d = path.join(this.calisma, fid);
    const kod = path.join(d, "kod");
    const yollar = [...new Set([...this.kilitOku(fid).yollar, ...asama.kilitle])].sort();
    const hashler = this.hashle(kod, yollar);
    const kopya = path.join(d, ".kovan", "kilitli");
    fs.rmSync(kopya, { recursive: true, force: true });
    for (const rel of Object.keys(hashler)) {
      fs.mkdirSync(path.dirname(path.join(kopya, rel)), { recursive: true });
      fs.cpSync(path.join(kod, rel), path.join(kopya, rel), { verbatimSymlinks: true });
    }
    atomikYaz(this.kilitYolu(fid), JSON.stringify({ yollar, hashler }, null, 2));
    const eksik = asama.kilitle.filter((y) => !fs.existsSync(path.join(kod, y)));
    this.sistemAdimi(fid, asama, "Kilit", "kilit",
      `Kilitlendi: ${asama.kilitle.join(", ")} (${Object.keys(hashler).length} dosya, SHA-256)` + (eksik.length ? ` · bulunamayan: ${eksik.join(", ")}` : ""));
  }

  private kilitKaldir(fid: string, yollar: string[]): void {
    const reg = this.kilitOku(fid);
    if (!yollar.some((y) => reg.yollar.includes(y))) return;
    const hashler = Object.fromEntries(Object.entries(reg.hashler).filter(([k]) => !yollar.some((y) => altinda(k, y))));
    atomikYaz(this.kilitYolu(fid), JSON.stringify({ yollar: reg.yollar.filter((y) => !yollar.includes(y)), hashler }, null, 2));
  }

  /** İkinci savunma hattı: kilit kaydındaki hash'lerle karşılaştırır (normalde alanDenetle yakalar). */
  private kilitDenetle(fid: string, asama: Asama, kart: AjanKarti): string[] {
    const reg = this.kilitOku(fid);
    if (!reg.yollar.length) return [];
    const d = path.join(this.calisma, fid);
    const kod = path.join(d, "kod");
    const kopya = path.join(d, ".kovan", "kilitli");
    const simdiki = this.hashle(kod, reg.yollar);
    const degisen = [...new Set([...Object.keys(simdiki), ...Object.keys(reg.hashler)])].filter((k) => simdiki[k] !== reg.hashler[k]).sort();
    if (!degisen.length) return [];
    for (const rel of degisen) {
      const hedef = path.join(kod, rel);
      fs.rmSync(hedef, { recursive: true, force: true });
      if (reg.hashler[rel] && fs.existsSync(path.join(kopya, rel))) {
        fs.mkdirSync(path.dirname(hedef), { recursive: true });
        fs.cpSync(path.join(kopya, rel), hedef, { verbatimSymlinks: true });
      }
    }
    const not = `${kart.ad} kilitli dosyalara dokundu: ${degisen.join(", ")}. Sistem dosyaları geri aldı.`;
    this.sistemAdimi(fid, asama, "Sınır ihlali", "ihlal", not);
    return [`### Sınır ihlali\n${not} Kilitli dosyaları değiştirme.`];
  }

  // ------------------------------- yardımcılar -------------------------------
  /** Sonraki aşamaya geçiş. Aşama daha önce üretilmişse (geri dönüş sonrası) yeniden yazılmaz,
   *  yalnızca testler ve onay kurulu yeniden bakar. Sorun bulurlarsa normal döngü işler. */
  private ilerlemeAlanlari(fid: string, akis: Akis, sonraki: number): Partial<Fikir> {
    let faz: "uret" | "dogrula" = "uret";
    const a = akis.asamalar[sonraki];
    if (a && a.tur === "ajan" && this.depo.adimlar(fid).some((s) => s.asama_id === a.id && s.tip === "uret" && s.durum === "tamam")) {
      faz = "dogrula";
      this.sistemAdimi(fid, a, "Yeniden doğrulama", "yeniden", "Önceki çıktı korunuyor; yalnızca testler ve onay kurulu yeniden bakıyor.");
    }
    return { asama_idx: sonraki, tur: 1, faz, ek_tur: 0, soru_turu: 0, geri_bildirim: null };
  }

  private bekleyeAl(fid: string, asama: Asama | null, sebep: BeklemeSebebi, mesaj: string, sec: Secenek[], detay: string | null = null,
    ek: Partial<Bekleme> = {}): "bekle" {
    const adim = this.sistemAdimi(fid, asama, sebep === "ajan_sorusu" ? "Ajan sorusu" : "Seni bekliyor", "bekliyor", mesaj, false);
    const b: Bekleme = { sebep, asama_id: asama?.id ?? null, asama_ad: asama?.ad ?? null, mesaj, secenekler: sec, detay, adim_id: adim, zaman: simdi(), ...ek };
    if (sec.some((s) => s.anahtar === "geri_gonder") && asama) {
      const f = this.depo.fikir(fid)!;
      const akis = this.akislar.get(f.profil)!;
      const idx = akis.asamalar.findIndex((a) => a.id === asama.id);
      b.geri_hedefler = akis.asamalar.slice(0, idx).filter((a) => a.tur === "ajan").map((a) => ({ id: a.id, ad: a.ad }));
      b.varsayilan_hedef = asama.geri_donus ?? b.geri_hedefler.at(-1)?.id ?? null;
    }
    this.depo.fikirGuncelle(fid, { durum: "bekliyor", bekleme: b });
    return "bekle";
  }

  private ajanSorusuBeklemesi(fid: string, asama: Asama, soranlar: { kart: AjanKarti; sorular: HamSoru[] }[], kaynak: "uret" | "inceleme",
    bekleyenGeriBildirim: string | null = null, detay: string | null = null): "bekle" {
    const sorular: AjanSorusu[] = soranlar.flatMap(({ kart, sorular: s }) => s.map((x) => ({ ...x, soran: kart.id, soran_ad: kart.ad }))).slice(0, 4);
    const kimler = [...new Set(soranlar.map((s) => s.kart.ad))].join(", ");
    return this.bekleyeAl(fid, asama, "ajan_sorusu", `${kimler} devam etmek için kararını soruyor.`, [], detay,
      { sorular, kaynak, bekleyen_geri_bildirim: bekleyenGeriBildirim });
  }

  private async tekrarOncesiBekle(motor: Motor, deneme: number): Promise<void> {
    if (deneme < this.cfg.deneme_sayisi && motor.tur !== "deneme") await bekle(3000);
  }

  private butceAsildi(fid: string): boolean {
    const f = this.depo.fikir(fid);
    return Boolean(f && f.butce_usd && f.maliyet_usd >= f.butce_usd);
  }

  private butceBeklemesi(fid: string, asama: Asama): "bekle" {
    const f = this.depo.fikir(fid)!;
    return this.bekleyeAl(fid, asama, "butce",
      `Fikir bütçesi doldu: $${f.maliyet_usd.toFixed(3)} / $${f.butce_usd.toFixed(2)}. Abonelikte bu tutar faturalanmaz ama kullanım limitinden yer; yükün göstergesidir.`,
      secenekler(["butce_artir", "durdur"], "butce_artir"));
  }

  private durdurUygula(fid: string): void {
    this.durdurIstekleri.delete(fid);
    const f = this.depo.fikir(fid);
    if (!f || f.durum === "durduruldu") return;
    this.depo.fikirGuncelle(fid, { durum: "durduruldu", bitis: simdi() });
    this.sistemAdimi(fid, null, "Durduruldu", "durduruldu", "Senin isteğinle durduruldu.");
  }

  private surecKaydedici(fid: string) {
    return (p: import("node:child_process").ChildProcess, bitti: boolean) => {
      const kume = this.surecler.get(fid) ?? new Set();
      if (bitti) kume.delete(p); else kume.add(p);
      this.surecler.set(fid, kume);
    };
  }

  calisanSurecSayisi(fid: string): number {
    return this.surecler.get(fid)?.size ?? 0;
  }

  /** Kapanışta çalışan ajan ve test süreçlerini (süreç grubuyla) kapatır; yarım kalan iş açılışta sana sorulur. */
  async kapat(): Promise<void> {
    const hepsi = [...this.surecler.values()].flatMap((k) => [...k]);
    for (const p of hepsi) if (p.pid && p.exitCode === null) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* bitmiş */ } }
    const t0 = Date.now();
    while (hepsi.some((p) => p.exitCode === null && p.signalCode === null) && Date.now() - t0 < 2000) await bekle(50);
    for (const p of hepsi) if (p.pid && p.exitCode === null && p.signalCode === null) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* bitmiş */ } }
  }

  private sistemAdimi(fid: string, asama: Asama | null, baslik: string, durum: string, ozet: string, kapat = true): number {
    const f = this.depo.fikir(fid);
    const id = this.depo.adimEkle({ fikir_id: fid, asama_id: asama?.id ?? "-", asama_ad: asama?.ad ?? "-", tip: "sistem", ajan: "-", ajan_ad: baslik, tur: f?.tur ?? 1, deneme: 1, durum, ozet: kisalt(ozet, 300), motor: "sistem", model: null });
    if (kapat) this.depo.adimGuncelle(fid, id, { bitis: simdi(), sure_sn: 0 });
    return id;
  }

  private adimKapat(fid: string, adim: number, durum: string, s: AjanSonucu | null, ozet: string, dosya = ""): void {
    const alanlar: Partial<Adim> = { durum, bitis: simdi(), ozet: kisalt(ozet ?? "", 300), dosya };
    if (s) Object.assign(alanlar, { sure_sn: Math.round(s.sure_sn * 10) / 10, maliyet_usd: Math.round(s.maliyet * 10_000) / 10_000, girdi_token: s.girdi_token, cikti_token: s.cikti_token, ajan_turu: s.tur_sayisi });
    this.depo.adimGuncelle(fid, adim, alanlar);
    if (s?.izin_retleri.length) {
      const a = this.depo.adim(fid, adim)!;
      this.sistemAdimi(fid, { ...bosAsama(a.asama_id, a.asama_ad) }, "İzin reddi", "uyari",
        `${a.ajan_ad} izinsiz ${s.izin_retleri.length} çağrı denedi, sistem reddetti: ${s.izin_retleri.slice(0, 5).join(", ")}`);
    }
  }

  private belgeOku(fid: string, anahtar: string | null): string {
    if (!anahtar) return "";
    const p = path.join(this.calisma, fid, "belgeler", `${anahtar}.md`);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
  }

  private belgeKaydet(fid: string, anahtar: string, metin: string, adim: number): string {
    const d = path.join(this.calisma, fid, "belgeler");
    fs.mkdirSync(path.join(d, "_surumler"), { recursive: true });
    const icerik = metin.trimEnd() + "\n";
    fs.writeFileSync(path.join(d, `${anahtar}.md`), icerik, "utf8");
    fs.writeFileSync(path.join(d, "_surumler", `${anahtar}-adim${adim}.md`), icerik, "utf8");
    return `belgeler/_surumler/${anahtar}-adim${adim}.md`;
  }

  private incelemeKaydet(fid: string, asama: Asama, v: Dogrulayici, kart: AjanKarti, tur: number, adim: number,
    karar: { karar: string; gerekce: string; bulgular: string[] }): string {
    const rel = `incelemeler/${asama.id}-tur${tur}-${kart.id}-adim${adim}.md`;
    const satirlar = [`# ${v.ad}: ${asama.ad}, tur ${tur}`, "", `İnceleyen: ${kart.ad}`, `Karar: **${karar.karar}**`, "", `Gerekçe: ${karar.gerekce}`, "", "## Bulgular",
      ...(karar.bulgular.length ? karar.bulgular.map((b) => `- ${b}`) : ["- (yok)"])];
    fs.writeFileSync(path.join(this.calisma, fid, rel), satirlar.join("\n") + "\n", "utf8");
    return rel;
  }

  private gunlukYaz(fid: string, adim: number, motor: Motor, c: AjanCagrisi, s: AjanSonucu): string {
    const rel = `gunluk/adim-${adim}.json`;
    const veri: Record<string, unknown> = {
      adim, motor: motor.ad, rol: c.rol, asama: c.asama_id, gorev_turu: c.gorev_turu, model: c.model, araclar: c.araclar,
      izinli: c.izinli, cwd: c.cwd, sure_siniri_sn: c.sure_sn, sistem: c.sistem, istem: c.istem,
      sonuc: { ok: s.ok, hata: s.hata, zaman_asimi: s.zaman_asimi, maliyet_usd: s.maliyet, girdi_token: s.girdi_token, cikti_token: s.cikti_token,
        tur_sayisi: s.tur_sayisi, sure_sn: Math.round(s.sure_sn * 100) / 100, metin: s.metin.slice(0, 20_000), yapisal: s.yapisal,
        izin_retleri: s.izin_retleri, ham: s.ham },
    };
    if (motor.komut) {
      try { veri.komut = motor.komut(c).map((x) => (x.length < 200 ? x : x.slice(0, 80) + " …")); } catch { /* yok say */ }
    }
    fs.writeFileSync(path.join(this.calisma, fid, rel), JSON.stringify(veri, null, 2), "utf8");
    return rel;
  }

  /** kod/ altındaki ajan dosyaları (Kovan'ın koyduğu kök package.json hariç). */
  private kodDosyalari(fid: string): string[] {
    return this.agac(path.join(this.calisma, fid, "kod")).filter((r) => !path.basename(r).startsWith(".") && r !== "package.json");
  }

  private teslimOzeti(fid: string): string | null {
    const adimlar = this.depo.adimlar(fid);
    const satirlar: string[] = [];
    const testler = new Map<string, string>();
    for (const s of adimlar) if (s.tip === "kontrol") testler.set(s.ajan_ad, s.ozet);
    for (const [ad, oz] of testler) satirlar.push(`${ad}: ${oz}`);
    const notlar = new Map<string, string>();
    for (const s of adimlar) if (s.tip === "inceleme" && (s.durum === "onay" || s.durum === "duzelt")) notlar.set(s.ajan_ad, s.ozet);
    if (notlar.size) { satirlar.push("Onay kurulunun son notları:"); for (const [ad, oz] of notlar) satirlar.push(`  ${ad}: ${oz}`); }
    const kararlar = this.kararlar(fid);
    if (kararlar.length) { satirlar.push("Senin kararların:"); for (const k of kararlar) satirlar.push(`  ${k.baslik}: ${k.cevap}`); }
    const dosyalar = this.kodDosyalari(fid);
    if (dosyalar.length) satirlar.push("Kod dosyaları: " + dosyalar.slice(0, 30).join(", ") + (dosyalar.length > 30 ? " …" : ""));
    return satirlar.join("\n") || null;
  }

  /** Tarayıcıda açılabilecek çıktılar: UX prototipi, frontend build'i (yoksa statik index.html). */
  private onizlemeler(fid: string): { ad: string; yol: string }[] {
    const kod = path.join(this.calisma, fid, "kod");
    const var_ = (rel: string) => fs.existsSync(path.join(kod, rel));
    const liste: { ad: string; yol: string }[] = [];
    if (var_("tasarim/prototip.html")) liste.push({ ad: "UX prototipi", yol: "kod/tasarim/prototip.html" });
    if (var_("frontend/dist/index.html")) liste.push({ ad: "Frontend (build)", yol: "kod/frontend/dist/index.html" });
    else if (var_("frontend/index.html") && !/src=["']\/?src\//.test(fs.readFileSync(path.join(kod, "frontend/index.html"), "utf8")))
      liste.push({ ad: "Frontend", yol: "kod/frontend/index.html" });
    return liste;
  }

  private dosyaListesi(fid: string) {
    const d = path.join(this.calisma, fid);
    const listele = (alt: string) => this.agac(path.join(d, alt))
      .filter((r) => !r.split("/").includes("_surumler") && !path.basename(r).startsWith("."))
      .map((r) => {
        const yol = `${alt}/${r}`;
        let boyut = 0;
        try { boyut = fs.statSync(path.join(d, yol)).size; } catch { /* yok */ }
        return { yol, boyut };
      });
    return { belgeler: listele("belgeler"), incelemeler: listele("incelemeler"), kod: listele("kod").filter((d) => d.yol !== "kod/package.json") };
  }
}

interface IncelemeSonucu {
  tur: "ok" | "soru" | "hata" | "dur";
  karar?: { karar: string; gerekce: string; bulgular: string[] };
  sorular?: HamSoru[];
  mesaj?: string;
}
