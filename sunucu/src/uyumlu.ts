// OpenAI uyumlu motor: kurum içi LLM (vLLM, TGI, ağ geçidi), LM Studio ya da Ollama'nın /v1 adresi.
// Ajanlar Kovan'ın kendi döngüsüyle (sunucu/src/ajan) ayrı süreçte çalışır; Claude Code gerekmez.
// API anahtarı ayar dosyasına yazılmaz: ortam değişkeninin adı ya da anahtarı içeren dosyanın yolu verilir.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HttpHatasi, baglantiHatasi, jsonIstek, type AracBicimi, type BaglantiAyari, type DonguSonucu } from "./ajan/dongu.js";
import type { AjanKarti } from "./kartlar.js";
import { sonuc, sureciOldur, yedekJsonTalimati, type AjanCagrisi, type AjanSonucu, type Motor } from "./motor.js";
import type { Kasa } from "./kasa.js";
import { KovanHatasi } from "./ortak.js";
import type { AnahtarKaynagi, MotorDurumu } from "./tipler.js";

export interface UyumluMotorAyari {
  tur: "openai";
  adres: string;                      // ör. https://llm.kurum.local/v1
  model: string;
  anahtar_degiskeni?: string | null;  // anahtarı tutan ortam değişkeninin ADI
  anahtar_dosyasi?: string | null;    // ya da anahtarı içeren dosya
  anahtar_basligi?: string;           // varsayılan Authorization ("Bearer <anahtar>")
  ek_basliklar?: Record<string, string>;
  ca_dosyasi?: string | null;         // kurumun kök sertifikası (PEM)
  arac_bicimi?: AracBicimi;
  sicaklik?: number | null;
  en_fazla_token?: number | null;
  baglam_token?: number;
  en_fazla_tur?: number;
  yerel?: boolean;                    // true (varsayılan): veri kurumun dışına çıkmaz, Hepsi yerel'de kullanılabilir
  es_zamanli?: number;                // aynı anda kaç ajan çağrısı; fazlası sırada bekler (süresi sırası gelince başlar)
}

const AJAN_BETIGI = fileURLToPath(new URL("./ajan/kovan-ajan.ts", import.meta.url));
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const evYolu = (y: string) => y.replace(/^~(?=$|\/)/, os.homedir());

export class UyumluMotor implements Motor {
  readonly tur = "openai" as const;
  readonly yerel: boolean;
  hazir = false;
  hata: string | null = null;
  surum = "OpenAI uyumlu";
  modeller: string[] = [];
  private sonKontrol = 0;
  private saglikSuruyor: Promise<boolean> | null = null;
  /** Aynı anda en fazla es_zamanli çağrı: Ollama gibi tek yuvalı sunucuda sıradaki ajanın süresi beklerken dolmasın. */
  private calisan = 0;
  private sira: (() => void)[] = [];

  /** Ayarlar ekranından girilen anahtar; kalıcı istendiyse kasaya da yazılmıştır. */
  private ekrandaki: string | null = null;
  private ekrandakiKasada = false;
  /** Kasadan okunan anahtar; undefined: henüz okunmadı. */
  private kasadaki: string | null | undefined = undefined;

  constructor(readonly ad: string, readonly ayar: UyumluMotorAyari, readonly kasa: Kasa | null = null) {
    this.yerel = ayar.yerel !== false;
  }

  /**
   * Sıra: ekrandan girilen > anahtar_dosyasi > anahtar_degiskeni > işletim sisteminin kasası.
   * Dosya ve değişken her çağrıda yeniden okunur: değişirse Kovan'ı yeniden başlatmak gerekmez.
   */
  anahtar(): { deger: string | null; hata: string | null; kaynak: AnahtarKaynagi | null } {
    if (this.ekrandaki) return { deger: this.ekrandaki, hata: null, kaynak: this.ekrandakiKasada ? "kasa" : "ekran" };
    const { anahtar_dosyasi: dosya, anahtar_degiskeni: degisken } = this.ayar;
    let hata: string | null = null;
    if (dosya) {
      const p = evYolu(dosya);
      const d = fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
      if (d) return { deger: d, hata: null, kaynak: "dosya" };
      hata = fs.existsSync(p) ? `API anahtarı dosyası boş: ${p}` : `API anahtarı dosyası yok: ${p}`;
    } else if (degisken) {
      const d = process.env[degisken]?.trim();
      if (d) return { deger: d, hata: null, kaynak: "degisken" };
      hata = `API anahtarı yok: ${degisken} ortam değişkeni boş`;
    }
    const k = this.kasadanOku();
    if (k) return { deger: k, hata: null, kaynak: "kasa" };
    return { deger: null, hata: hata && `${hata}. Ayarlar ekranından gir ya da Kovan'ı başlatmadan önce ayarla.`, kaynak: null };
  }

  private kasadanOku(): string | null {
    if (!this.kasa) return null;
    if (this.kasadaki === undefined) {
      try { this.kasadaki = this.kasa.oku(this.ad); } catch { this.kasadaki = null; }
    }
    return this.kasadaki;
  }

  /** Ayarlar ekranından: anahtarı belleğe al; kalıcıysa kasaya da yaz. Anahtar hiçbir hata mesajına girmez. */
  anahtarAyarla(deger: string, kalici: boolean): void {
    const d = deger.trim();
    if (!d) throw new KovanHatasi("API anahtarı boş.");
    if (d.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(d)) throw new KovanHatasi("API anahtarı boşluk ya da kontrol karakteri içeremez, en fazla 4096 karakter olabilir.");
    if (kalici) {
      if (!this.kasa) throw new KovanHatasi("Bu makinede işletim sistemi kasası yok; anahtar yalnızca bellekte tutulabilir.");
      try { this.kasa.yaz(this.ad, d); } catch (e) { throw new KovanHatasi((e as Error).message, 500); }
      this.kasadaki = d;
    }
    this.ekrandaki = d;
    this.ekrandakiKasada = kalici;
    this.sonKontrol = 0;
  }

  /** Ekrandan girileni ve kasadakini siler; dosya ve ortam değişkenine dokunmaz. */
  anahtarSil(): void {
    this.ekrandaki = null;
    this.ekrandakiKasada = false;
    if (this.kasa) {
      try { this.kasa.sil(this.ad); } catch (e) { throw new KovanHatasi(`Kasadan silinemedi: ${(e as Error).message}`, 500); }
      this.kasadaki = null;
    }
    this.sonKontrol = 0;
  }

  private baglanti(anahtar: string | null, model = this.ayar.model): BaglantiAyari {
    const a = this.ayar;
    return {
      adres: a.adres.replace(/\/+$/, ""), model, anahtar,
      anahtar_basligi: a.anahtar_basligi || "Authorization", ek_basliklar: a.ek_basliklar ?? {},
      ca: a.ca_dosyasi ? fs.readFileSync(evYolu(a.ca_dosyasi), "utf8") : null,
      arac_bicimi: a.arac_bicimi ?? "otomatik", sicaklik: a.sicaklik ?? null, en_fazla_token: a.en_fazla_token ?? null,
      baglam_token: a.baglam_token ?? 32_768, en_fazla_tur: a.en_fazla_tur ?? 100,
    };
  }

  async saglik(zorla = false): Promise<boolean> {
    // Aynı anda gelen çağrılar (paralel onaycılar) süren denetimi bekler; yarım kalmış "hazır değil" görmesinler
    if (this.saglikSuruyor) return this.saglikSuruyor;
    if (!zorla && Date.now() - this.sonKontrol < 10_000) return this.hazir;
    this.saglikSuruyor = this.saglikDenetle().then(([hazir, hata]) => {
      this.hazir = hazir;
      this.hata = hata;
      this.sonKontrol = Date.now();
      return hazir;
    }).finally(() => { this.saglikSuruyor = null; });
    return this.saglikSuruyor;
  }

  private async saglikDenetle(): Promise<[boolean, string | null]> {
    const a = this.anahtar();
    if (a.hata) return [false, a.hata];
    let b: BaglantiAyari;
    try { b = this.baglanti(a.deger); } catch (e) { return [false, `ca_dosyasi okunamadı: ${(e as Error).message}`]; }
    try {
      // Yerel sunucu üretim yaparken (ya da bellek baskısında) yavaş yanıtlayabilir
      const v = await jsonIstek(b, "/models", undefined, { sure_ms: 15_000 });
      this.modeller = (Array.isArray(v?.data) ? v.data : []).map((m: { id?: string }) => String(m?.id ?? "")).filter(Boolean);
      if (this.modeller.length && !this.modeller.includes(this.ayar.model)) {
        return [false, `Model sunucuda yok: ${this.ayar.model}. Sunucudaki modeller: ${this.modeller.slice(0, 8).join(", ")}`];
      }
    } catch (e) {
      // /models'i sunmayan ağ geçitleri var: erişim sorunu değilse hazır say
      if (!(e instanceof HttpHatasi && [404, 405].includes(e.durum))) return [false, baglantiHatasi(e, b.adres).mesaj];
    }
    return [true, null];
  }

  private async yuvaAl(): Promise<() => void> {
    const sinir = Math.max(1, this.ayar.es_zamanli ?? 1);
    if (this.calisan >= sinir) await new Promise<void>((coz) => this.sira.push(coz));
    this.calisan++;
    let birakildi = false;
    return () => {
      if (birakildi) return;
      birakildi = true;
      this.calisan--;
      this.sira.shift()?.();
    };
  }

  modelSec(kart: AjanKarti): string {
    return kart.yerel_model ?? this.ayar.model;
  }

  async durumOzeti(): Promise<MotorDurumu> {
    const hazir = await this.saglik();
    return {
      hazir, surum: this.surum, hata: this.hata, yol: null, tur: this.tur, yerel: this.yerel, model: this.ayar.model, adres: this.ayar.adres,
      anahtar_kaynagi: this.anahtar().kaynak, anahtar_basligi: this.ayar.anahtar_basligi || "Authorization", kasa: this.kasa?.ad ?? null,
    };
  }

  async calistir(c: AjanCagrisi): Promise<AjanSonucu> {
    if (!(await this.saglik())) return sonuc({ hata: this.hata ?? `${this.ad} hazır değil`, kalici_hata: true });
    const birak = await this.yuvaAl();
    try { return await this.calistirYuvada(c); } finally { birak(); }
  }

  private async calistirYuvada(c: AjanCagrisi): Promise<AjanSonucu> {
    const a = this.anahtar();
    const { anahtar: _gizli, ...baglanti } = this.baglanti(null, c.model);
    const girdi = JSON.stringify({
      baglanti,
      istek: {
        sistem: c.sistem, sistem_modu: c.sistem_modu, istem: c.sema ? c.istem + yedekJsonTalimati(c) : c.istem,
        araclar: c.araclar, izinli: c.izinli, cwd: c.cwd, sure_sn: c.sure_sn,
      },
    });
    // Anahtar yalnızca alt sürecin ortamında; stdin'de, günlükte ve Bash'in ortamında yok
    const env: NodeJS.ProcessEnv = { ...process.env, KOVAN_LLM_ANAHTAR: a.deger ?? "" };
    if (this.ayar.anahtar_degiskeni) delete env[this.ayar.anahtar_degiskeni];
    const t0 = Date.now();
    return new Promise<AjanSonucu>((coz) => {
      const p = spawn(process.execPath, ["--import", TSX, AJAN_BETIGI], { cwd: c.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      let cikti = "";
      let hata = "";
      let bitti = false;
      let zamanAsimi = false;
      const sure = () => (Date.now() - t0) / 1000;
      // Alt süreç süreyi kendisi uygular; bu yalnızca takılırsa diye
      const saat = setTimeout(() => { zamanAsimi = true; sureciOldur(p); }, (c.sure_sn + 30) * 1000);
      const kapat = () => { clearTimeout(saat); c.surecCb?.(p, true); };
      p.stdout!.setEncoding("utf8").on("data", (d) => { cikti += d; });
      p.stderr!.setEncoding("utf8").on("data", (d) => { hata += d; });
      p.on("error", (e) => {
        if (bitti) return;
        bitti = true; kapat();
        coz(sonuc({ hata: `Kovan ajanı başlatılamadı: ${e.message}`, sure_sn: sure() }));
      });
      p.on("close", (kod) => {
        if (bitti) return;
        bitti = true; kapat();
        let v: Partial<DonguSonucu> | null = null;
        try { v = JSON.parse(cikti); } catch { /* aşağıda */ }
        if (!v) {
          coz(sonuc({
            sure_sn: sure(), zaman_asimi: zamanAsimi, ham: (cikti || hata).slice(-4000),
            hata: zamanAsimi ? `Süre sınırı aşıldı (${c.sure_sn} sn); süreç durduruldu` : kod === null ? "Süreç durduruldu" : `Kovan ajanı yanıt vermedi (çıkış kodu ${kod}): ${hata.slice(-400) || "boş çıktı"}`,
          }));
          return;
        }
        coz(sonuc({
          ok: Boolean(v.ok), metin: v.metin ?? "", hata: v.hata ?? null, kalici_hata: Boolean(v.kalici_hata), zaman_asimi: Boolean(v.zaman_asimi),
          girdi_token: v.girdi_token ?? 0, cikti_token: v.cikti_token ?? 0, tur_sayisi: v.tur_sayisi ?? 0, izin_retleri: v.izin_retleri ?? [],
          sure_sn: sure(), maliyet: 0, ham: cikti.slice(-4000),
        }));
      });
      c.surecCb?.(p, false);
      p.stdin!.on("error", () => { /* süreç erken kapanırsa EPIPE */ });
      p.stdin!.end(girdi);
    });
  }
}
