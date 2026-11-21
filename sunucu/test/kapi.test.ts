// Büyük Birader (her aşamanın sonunda işin tamamına bakan, veto edebilen göz), aşama sonu onay kapısı
// (karar özeti madde madde, mimari kararlar seçenekleriyle) ve ajanla konuşma.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Ayarlar } from "../src/ayarlar.js";
import { BIRADER_SEMASI, KARAR_SEMASI, yedekJsonTalimati, type AjanCagrisi, type AjanSonucu, type Motor } from "../src/motor.js";
import { ozetCikar } from "../src/plan.js";
import type { Fikir } from "../src/tipler.js";
import { BetikMotor, KOK, SahteMotor, bekle, bekliyor, dosya, geciciKok, istemi, kovanOlustur, varMi, type TestKovani } from "./yardimci/ortam.js";

// Küçük bir akış: iki planlama aşaması (ikisi de kapılı, ikincisi ADR'li), kapısız bir kod aşaması ve kabul.
const KAPILI = `ad: Kapılı
aciklama: Kapı ve Büyük Birader testleri için.
fikir_butcesi_usd: 5
ortak_karar: false
asamalar:
  - id: brif
    kapi: true
    ad: Kapsam
    ajan: urun-sahibi
    gorev: Kapsamı yaz.
    girdiler: [fikir]
    cikti: brif
    dogrulama:
      - ad: Analist onayı
        inceleyen: analist
  - id: teknik-plan
    kapi: true
    ad: Teknik plan
    ajan: mimar
    gorev: Planı yaz.
    girdiler: [brif]
    cikti: teknik-plan
    dogrulama:
      - ad: ADR biçimi
        adr: { en_az: 1 }
      - ad: Analist onayı
        inceleyen: analist
  - id: testler
    ad: Testler
    ajan: test-otomasyon
    calisma_dizini: kod
    gorev: Testleri yaz.
    girdiler: [brif]
    cikti: test-ozeti
    yazabilir: [testler, test-be.sh]
    kilitle: [testler, test-be.sh]
  - id: kabul
    ad: Kabul
    tur: insan
    soru: Tamam mı?
`;
const FIKIR = "Bitki sulama hatırlatıcısı: bitki ekle, sulama günü gelince göster.";
const BB = "buyuk-birader";
const ACIK = { acik: true, en_fazla_veto: 2 };
type Betik = (c: AjanCagrisi) => Partial<AjanSonucu> | null;

/** Deneme motoru betikle sarılır: betik null dönerse deneme davranışı; bütün çağrılar kaydedilir. */
async function kur(ayar: Partial<Ayarlar> = {}, betik: Betik = () => null) {
  const deneme = new BetikMotor("deneme", betik);
  const k = await kovanOlustur({
    kok: geciciKok({ kapili: KAPILI }),
    ayar: { ajan_sorulari: false, ...ayar },
    motorlar: new Map<string, Motor>([["deneme", deneme], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]),
  });
  return { k, deneme };
}
const hukum = (h: string, ek: object = {}) => ({ metin: "", yapisal: { hukum: h, ozet: `Betik: ${h}`, bulgular: [], oneri: "", ...ek } });
const KANITLI = [{ konu: "Kapsam dışı ekleme", kanit: "belgeler/brif.md: 'çoklu kullanıcı' fikirde yok", aciklama: "Kapsam, fikirde olmayan bir özelliği içeriyor." }];
const kapida = (asama: string, adimHaric?: number) => (f: Fikir) =>
  f.durum === "bekliyor" && f.bekleme?.kaynak === "kapi" && f.bekleme.asama_id === asama && f.bekleme.adim_id !== adimHaric;
const hepsiOnay = (f: Fikir) => f.bekleme!.sorular!.map((s) => ({ secilenler: [s.secenekler[0].etiket.replace(" (Önerilen)", "")] }));
const adimlari = (k: TestKovani, fid: string, asama: string, tip: string, ajan?: string) =>
  k.depo.adimlar(fid).filter((s) => s.asama_id === asama && s.tip === tip && (!ajan || s.ajan === ajan));

describe("Karar özeti (kovan-ozet)", () => {
  const blok = (govde: string) => "# Belge\n\n```kovan-ozet\n" + govde + "\n```\n";

  it("geçerli bloğu okur; tür yazılmazsa karar sayar", () => {
    const r = ozetCikar(blok("kararlar:\n  - baslik: Giriş yok\n    karar: İlk sürümde giriş ekranı olmayacak.\n    neden: Tek kullanıcı.\n    alternatif: E-posta ile giriş\n    tur: Varsayım\n  - baslik: Veri cihazda\n    karar: Veriler tarayıcıda tutulur.\n    neden: Sunucu istenmedi."));
    expect(r.maddeler).toEqual([
      { baslik: "Giriş yok", karar: "İlk sürümde giriş ekranı olmayacak.", neden: "Tek kullanıcı.", alternatif: "E-posta ile giriş", tur: "varsayim" },
      { baslik: "Veri cihazda", karar: "Veriler tarayıcıda tutulur.", neden: "Sunucu istenmedi.", alternatif: "", tur: "karar" },
    ]);
  });

  it("eksik bloğu, boş kararı ve nedeni, yinelenen başlığı ve fazla maddeyi insan diliyle reddeder", () => {
    expect(ozetCikar("# Belge").hatalar![0]).toMatch(/kovan-ozet bloğu yok/);
    expect(ozetCikar(blok("kararlar: []")).hatalar![0]).toMatch(/blok boş/);
    const r = ozetCikar(blok("kararlar:\n  - baslik: A\n    karar: x\n  - baslik: a\n    neden: y")).hatalar!.join(" ");
    expect(r).toMatch(/A: neden boş/);
    expect(r).toMatch(/aynı başlık iki kez/);
    expect(r).toMatch(/karar boş/);
    const dokuz = Array.from({ length: 9 }, (_, i) => `  - baslik: M${i}\n    karar: k\n    neden: n`).join("\n");
    expect(ozetCikar(blok("kararlar:\n" + dokuz)).hatalar![0]).toMatch(/En fazla 8 madde/);
  });
});

describe("Büyük Birader", () => {
  it("her aşamanın sonunda işin tamamına bakar; yalnızca okur, hükmü deftere ve zaman çizelgesine girer", async () => {
    const { k, deneme } = await kur({ buyuk_birader: ACIK });
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    await bekle(k, fid, bekliyor("insan"));
    const d = k.ork.fikirDetayi(fid);
    // Üç ajan aşamasının her birinde bir değerlendirme; teknik planda deneme motoru bir uyarı yazar, akış durmaz
    expect(d.birader.map((b) => `${b.asama_id}:${b.hukum}`)).toEqual(["brif:UYGUN", "teknik-plan:DIKKAT", "testler:UYGUN"]);
    expect(dosya(k, fid, "belgeler/birader-defteri.md")).toContain("## Teknik plan, tur 1: DİKKAT");
    expect(adimlari(k, fid, "teknik-plan", "inceleme", BB)[0]).toMatchObject({ durum: "uyari", ajan_ad: "Büyük Birader" });
    expect(varMi(k, fid, `incelemeler/brif-tur1-${BB}-adim${adimlari(k, fid, "brif", "inceleme", BB)[0].id}.md`)).toBe(true);
    expect(d.asamalar.find((a) => a.id === "brif")!.onaylar.at(-1)).toEqual({ ad: "Büyük Birader", kisa: "BB", durum: "onay" });
    expect(d.asamalar.find((a) => a.id === "kabul")!.onaylar).toEqual([]);

    const cagrilar = deneme.cagrilar.filter((c) => c.rol === BB);
    expect(cagrilar).toHaveLength(3);
    for (const c of cagrilar) {
      expect(c.araclar).toEqual(["Read", "Glob", "Grep"]);   // yazma ve komut aracı yok
      expect(c.izinli).toEqual([]);
      expect(c.cwd).toBe(path.join(k.calisma, fid));          // fikrin kökü: belgeler, incelemeler, kod
      expect(c.sistem).toContain("Sen Büyük Birader'sin");
    }
    // İkinci aşamada önceki aşamanın karar özetini, gidişatı ve kendi önceki hükmünü görür
    const plan = cagrilar[1].istem;
    expect(plan).toContain("## Gidişat");
    expect(plan).toContain("| Kapsam | 1 | 0 | 0 | 0 |");
    expect(plan).toContain("### Kapsam (belgeler/brif.md)");
    expect(plan).toContain("- Kapsam, tur 1: UYGUN.");
    expect(plan).toContain("## Bu aşamanın çıktısı (belgeler/teknik-plan.md)");
    // Büyük Birader açıkken kapı olmasa da her aşamadan karar özeti istenir (aşamaları özetlerinden izler)
    expect(deneme.cagrilar.find((c) => c.rol === "urun-sahibi")!.sistem).toContain("# Karar özeti (kovan-ozet)");
    expect(dosya(k, fid, "belgeler/test-ozeti.md")).toContain("```kovan-ozet");
  });

  it("veto aşamayı kanıtlı bulgularla yazarına geri gönderir; onay kurulu yeniden bakmaz, Büyük Birader bakar", async () => {
    let n = 0;
    const { k } = await kur({ buyuk_birader: ACIK }, (c) => (c.rol === BB && c.asama_id === "brif" && ++n === 1 ? hukum("VETO", { bulgular: KANITLI }) : null));
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    await bekle(k, fid, bekliyor("insan"));
    const uretimler = adimlari(k, fid, "brif", "uret");
    expect(uretimler).toHaveLength(2);
    const ikinci = istemi(k, fid, uretimler[1].id);
    expect(ikinci).toContain("### Büyük Birader: VETO");
    expect(ikinci).toContain("**Kapsam dışı ekleme**: Kapsam, fikirde olmayan bir özelliği içeriyor. (kanıt: belgeler/brif.md");
    expect(adimlari(k, fid, "brif", "inceleme", "analist")).toHaveLength(1);              // onayı korundu
    expect(adimlari(k, fid, "brif", "inceleme", BB).map((s) => s.durum)).toEqual(["veto", "onay"]);
    expect(k.depo.adimlar(fid).some((s) => s.asama_id === "brif" && s.ajan_ad === "Onay korundu")).toBe(true);
    expect(k.depo.fikir(fid)!.birader_veto).toBe(0);                                      // yeni aşamada sayaç sıfır
    expect(k.ork.biraderDefteri(fid).filter((b) => b.asama_id === "brif").map((b) => b.hukum)).toEqual(["VETO", "UYGUN"]);
  });

  it("kanıtsız veto geçersizdir: DİKKAT'e düşer, aşama geri çevrilmez", async () => {
    const { k } = await kur({ buyuk_birader: ACIK }, (c) => (c.rol === BB && c.asama_id === "brif"
      ? hukum("VETO", { bulgular: [{ konu: "Beğenmedim", kanit: "", aciklama: "Bence başka türlü olmalıydı." }] }) : null));
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    await bekle(k, fid, bekliyor("insan"));
    expect(adimlari(k, fid, "brif", "uret")).toHaveLength(1);
    expect(k.ork.biraderDefteri(fid)[0]).toMatchObject({ asama_id: "brif", hukum: "DIKKAT", dusuruldu: true });
    expect(k.depo.adimlar(fid).find((s) => s.ajan_ad === "Kanıtsız veto")!.ozet).toContain("DİKKAT'e düşürüldü");
  });

  it("veto sınırında karar sana gelir; 'olduğu gibi kabul et' ile aşama geçer", async () => {
    const { k } = await kur({ buyuk_birader: { acik: true, en_fazla_veto: 1 } }, (c) => (c.rol === BB && c.asama_id === "brif" ? hukum("VETO", { bulgular: KANITLI }) : null));
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    const f = await bekle(k, fid, bekliyor("tur_siniri"));
    expect(f.bekleme!.mesaj).toContain("Büyük Birader 'Kapsam' aşamasını 2. kez veto etti (sınır 1)");
    expect(f.bekleme!.secenekler.map((s) => s.anahtar)).toEqual(["bir_tur_daha", "devam", "durdur"]);
    expect(f.bekleme!.detay).toContain("### Büyük Birader: VETO");
    expect(adimlari(k, fid, "brif", "uret")).toHaveLength(2);     // bir veto turu yapıldı, ikincisi sana geldi
    k.ork.kararVer(fid, "devam");
    await bekle(k, fid, bekliyor("insan"));
    expect(adimlari(k, fid, "teknik-plan", "uret")).toHaveLength(1);
  });

  it("değerlendirme alınamazsa akış kilitlenmez: o aşamada onsuz devam edilebilir, sonraki aşamada yine bakar", async () => {
    const { k, deneme } = await kur({ buyuk_birader: ACIK, deneme_sayisi: 1 }, (c) => (c.rol === BB && c.asama_id === "brif" ? { ok: false, hata: "model cevap vermedi", kalici_hata: true } : null));
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    const f = await bekle(k, fid, bekliyor("hata"));
    expect(f.bekleme!.mesaj).toContain("Büyük Birader 'Kapsam' aşamasını değerlendiremedi: model cevap vermedi");
    expect(f.bekleme!.secenekler.map((s) => s.anahtar)).toEqual(["tekrar_dene", "birader_atla", "durdur"]);
    k.ork.kararVer(fid, "birader_atla");
    await bekle(k, fid, bekliyor("insan"));
    expect(deneme.cagrilar.filter((c) => c.rol === BB).map((c) => c.asama_id)).toEqual(["brif", "teknik-plan", "testler"]);
    expect(k.ork.biraderDefteri(fid).map((b) => b.asama_id)).toEqual(["teknik-plan", "testler"]);
  });

  it("kapalıyken ve akışta kapatılmışken (Mini) hiç çağrılmaz; karar özeti de istenmez", async () => {
    const kapali = await kur();
    let fid = await kapali.k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    await bekle(kapali.k, fid, bekliyor("insan"));
    expect(kapali.deneme.cagrilar.some((c) => c.rol === BB)).toBe(false);
    expect(kapali.deneme.cagrilar.some((c) => c.sistem.includes("kovan-ozet"))).toBe(false);
    expect(kapali.k.ork.fikirDetayi(fid).birader).toEqual([]);

    const mini = await kur({ buyuk_birader: ACIK });
    fid = await mini.k.ork.yeniFikir("", FIKIR, "mini", "deneme");
    await bekle(mini.k, fid, bekliyor("insan"));
    expect(mini.deneme.cagrilar.some((c) => c.rol === BB)).toBe(false);
  });

  it("ucuz inceleme modeli ona uygulanmaz; Hepsi yerel'de yerel motorda koşar", async () => {
    const claude = new SahteMotor("claude");
    const yerel = new SahteMotor("qwen-yerel", true);
    const k = await kovanOlustur({
      kok: geciciKok({ kapili: KAPILI }), ayar: { ajan_sorulari: false, buyuk_birader: ACIK, claude_inceleme_modeli: "haiku" },
      motorlar: new Map<string, Motor>([["deneme", new SahteMotor("deneme")], ["claude", claude], ["qwen-yerel", yerel]]),
    });
    let fid = await k.ork.yeniFikir("", FIKIR, "kapili", "claude");
    await bekle(k, fid, bekliyor("insan"));
    expect(claude.cagrilar.find((c) => c.rol === "analist" && c.gorev_turu === "inceleme")!.model).toBe("haiku");
    expect(claude.cagrilar.find((c) => c.rol === BB)!.model).toBe("sonnet");

    claude.cagrilar.length = 0;
    fid = await k.ork.yeniFikir("", FIKIR, "kapili", "yerel");
    await bekle(k, fid, bekliyor("insan"));
    expect(yerel.cagrilar.filter((c) => c.rol === BB)).toHaveLength(3);
    expect(claude.cagrilar).toHaveLength(0);
  });

  it("JSON şeması desteklemeyen (yerel) modele hüküm biçimi istemin sonunda verilir; inceleme kararıyla karışmaz", () => {
    const cagri = (sema: object) => ({ gorev_turu: "inceleme", sema } as AjanCagrisi);
    expect(yedekJsonTalimati(cagri(BIRADER_SEMASI))).toContain('{"hukum": "UYGUN" | "DIKKAT" | "VETO"');
    expect(yedekJsonTalimati(cagri(BIRADER_SEMASI))).not.toContain('"karar"');
    expect(yedekJsonTalimati(cagri(KARAR_SEMASI))).toContain('{"karar": "ONAY" | "DUZELT" | "SORU"');
  });

  it("açıkken kartı yoksa Kovan anlaşılır bir hatayla başlamaz", async () => {
    const kok = geciciKok();
    fs.rmSync(path.join(kok, "ajanlar", `${BB}.md`));
    await expect(kovanOlustur({ kok, ayar: { buyuk_birader: ACIK } })).rejects.toThrow(/buyuk_birader açık ama ajanlar\/buyuk-birader\.md yok/);
    await expect(kovanOlustur({ kok })).resolves.toBeTruthy();
  });
});

describe("Aşama sonu kapısı", () => {
  it("planlama: kapsam ve teknik plan sonunda kapı; onayla ilerler, kilit ve ADR onaydan sonra yazılır, deftere onay girmez", async () => {
    const { k } = await kur({ katilim: "planlama", buyuk_birader: ACIK });
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    let f = await bekle(k, fid, kapida("brif"));
    expect(f.katilim).toBe("planlama");
    expect(f.bekleme!.sebep).toBe("ajan_sorusu");
    expect(f.bekleme!.mesaj).toContain("Kapsam hazır: onay kurulu geçirdi");
    expect(f.bekleme!.birader).toMatchObject({ asama_id: "brif", hukum: "UYGUN" });
    const sorular = f.bekleme!.sorular!;
    expect(sorular.map((s) => s.kapi!.tur)).toEqual(["ozet", "ozet", "genel"]);
    expect(sorular[0]).toMatchObject({ baslik: "brif ana kararı", soran_ad: "Ürün Sahibi", insan: true });
    expect(sorular[0].soru).toMatch(/^Bu aşama, .*\nNeden: Deneme modu.*\nAlternatif: Daha kapsamlı/s);
    expect(sorular[1].kapi).toEqual({ tur: "ozet", madde_turu: "varsayim" });
    expect(sorular[0].secenekler.map((o) => o.etiket)).toEqual(["Onaylıyorum (Önerilen)", "Değiştir"]);
    expect(sorular.at(-1)!.baslik).toBe("Belgenin geneli");
    expect(() => k.ork.kararVer(fid, "devam")).toThrow(/ajan sorusu/);

    k.ork.cevapla(fid, hepsiOnay(f));
    f = await bekle(k, fid, kapida("teknik-plan"));
    expect(k.ork.kararlar(fid)).toEqual([]);                                   // onaylar karar defterini şişirmez
    expect(k.ork.onaylar(fid).map((o) => `${o.asama_id}:${o.maddeler.length}`)).toEqual(["brif:2"]);
    expect(dosya(k, fid, "belgeler/onaylar.md")).toContain("## Kapsam");

    // Teknik plan: mimari karar seçenekleriyle gelir, Mimar'ın önerisi ilk sırada; onaya kadar ADR dosyası yok
    const adr = f.bekleme!.sorular!.find((s) => s.kapi?.tur === "adr")!;
    expect(adr.baslik).toBe("Mimari karar: Veri tarayıcıda tutulur");
    expect(adr.kapi).toEqual({ tur: "adr", oneri: "Tarayıcı deposu" });
    expect(adr.secenekler.map((o) => o.etiket)).toEqual(["Tarayıcı deposu (Önerilen)", "Sunucu veritabanı"]);
    expect(adr.secenekler[1].aciklama).toBe("Artı: Cihazlar arası erişim Eksi: Hesap, barındırma ve kişisel veri yükü");
    expect(f.bekleme!.birader).toMatchObject({ hukum: "DIKKAT" });
    expect(varMi(k, fid, "kod/adr")).toBe(false);
    expect(k.ork.fikirDetayi(fid).adrler).toEqual([]);

    k.ork.cevapla(fid, hepsiOnay(f));
    f = await bekle(k, fid, bekliyor("insan"));
    expect(varMi(k, fid, "kod/adr/README.md")).toBe(true);
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toEqual(["adr", "test-be.sh", "testler"]);
    // Kod aşamasında planlama kapısı yok
    expect(k.depo.adimlar(fid).filter((s) => s.ajan_ad === "Ajan sorusu").map((s) => s.asama_id)).toEqual(["brif", "teknik-plan"]);
    expect(k.ork.onaylar(fid).find((o) => o.asama_id === "teknik-plan")!.maddeler.at(-1)).toEqual({ baslik: "Mimari karar: Veri tarayıcıda tutulur", karar: "Tarayıcı deposu" });
  });

  it("Değiştir not ister; notla aynı aşama yeniden çalışır, karar deftere girer, kurul ve Büyük Birader yeniden bakar", async () => {
    const { k } = await kur({ katilim: "planlama", buyuk_birader: ACIK });
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    let f = await bekle(k, fid, kapida("brif"));
    const ilk = f.bekleme!.adim_id;
    const cevap = hepsiOnay(f);
    expect(() => k.ork.cevapla(fid, [cevap[0], { secilenler: ["Değiştir"] }, cevap[2]])).toThrow(/"Varsayılan kapsam": neyin değişmesini istediğini yaz/);
    k.ork.cevapla(fid, [cevap[0], { secilenler: ["Değiştir"], serbest: "Bildirimler de kapsama girsin" }, cevap[2]]);
    f = await bekle(k, fid, kapida("brif", ilk));

    const uretimler = adimlari(k, fid, "brif", "uret");
    expect(uretimler).toHaveLength(2);
    const ikinci = istemi(k, fid, uretimler[1].id);
    expect(ikinci).toContain("### Projenin sahibinin kararları (aşama onayı)\n- **Varsayılan kapsam**: Bildirimler de kapsama girsin");
    expect(ikinci).toContain("onayladığı diğer kararları ve belgenin gerisini koru");
    expect(k.ork.kararlar(fid)).toMatchObject([{ baslik: "Varsayılan kapsam", cevap: "Bildirimler de kapsama girsin", karar_veren: "insan" }]);
    expect(adimlari(k, fid, "brif", "inceleme", "analist")).toHaveLength(2);
    expect(adimlari(k, fid, "brif", "inceleme", BB)).toHaveLength(2);
    expect(k.ork.onaylar(fid)).toEqual([]);
    expect(f.tur).toBe(2);
    // Senin istediğin tur, aşamanın tur hakkından yemez
    expect(k.depo.adimlar(fid).some((s) => s.asama_id === "brif" && s.ajan_ad === "Seni bekliyor")).toBe(false);
  });

  it("mimari kararda farklı seçenek seçilirse teknik plan o kararla yeniden yazılır; seçim deftere girer", async () => {
    const { k } = await kur({ katilim: "planlama" });
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    let f = await bekle(k, fid, kapida("brif"));
    k.ork.cevapla(fid, hepsiOnay(f));
    f = await bekle(k, fid, kapida("teknik-plan"));
    const ilk = f.bekleme!.adim_id;
    const cevap = hepsiOnay(f);
    const i = f.bekleme!.sorular!.findIndex((s) => s.kapi?.tur === "adr");
    expect(() => k.ork.cevapla(fid, cevap.map((c, j) => (j === i ? { secilenler: [], serbest: "bilmiyorum" } : c)))).toThrow(/için seçeneklerden birini seç/);
    k.ork.cevapla(fid, cevap.map((c, j) => (j === i ? { secilenler: ["Sunucu veritabanı"] } : c)));
    f = await bekle(k, fid, kapida("teknik-plan", ilk));
    expect(k.ork.kararlar(fid)[0]).toMatchObject({ baslik: "Mimari karar: Veri tarayıcıda tutulur", cevap: '"Sunucu veritabanı" seçildi (öneri "Tarayıcı deposu" idi).' });
    const ikinci = istemi(k, fid, adimlari(k, fid, "teknik-plan", "uret")[1].id);
    expect(ikinci).toContain('**Mimari karar: Veri tarayıcıda tutulur**: "Sunucu veritabanı" seçildi');
    expect(ikinci).toContain("## Alınan kararlar");
    expect(varMi(k, fid, "kod/adr")).toBe(false);
  });

  it("karar özeti eksikse onay kuruluna gitmeden yazara döner", async () => {
    let n = 0;
    const { k } = await kur({ katilim: "planlama" }, (c) => (c.rol === "urun-sahibi" && c.gorev_turu === "uret" && ++n === 1 ? { metin: "# Kapsam\nBitki ekle, sulama günü göster." } : null));
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    await bekle(k, fid, kapida("brif"));
    const ozet = k.depo.adimlar(fid).filter((s) => s.ajan_ad === "Karar özeti");
    expect(ozet).toHaveLength(1);
    expect(ozet[0]).toMatchObject({ durum: "kirmizi" });
    expect(ozet[0].ozet).toContain("kovan-ozet bloğu yok");
    expect(adimlari(k, fid, "brif", "uret")).toHaveLength(2);
    expect(adimlari(k, fid, "brif", "inceleme")).toHaveLength(1);                 // ilk tur kurula gitmedi
    expect(istemi(k, fid, adimlari(k, fid, "brif", "uret")[1].id)).toContain("### Karar özeti: GEÇERSİZ");
  });

  it("sonda: kapı yok. her_asama: kod aşamasında da kapı açılır ve kilit onayı bekler", async () => {
    const sonda = await kur({ katilim: "sonda" });
    let fid = await sonda.k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    let f = await bekle(sonda.k, fid, bekliyor());
    expect(f.bekleme!.sebep).toBe("insan");
    expect(sonda.k.depo.adimlar(fid).some((s) => s.ajan_ad === "Ajan sorusu")).toBe(false);

    const hepsi = await kur({ katilim: "sonda" });
    fid = await hepsi.k.ork.yeniFikir("", FIKIR, "kapili", "deneme", { katilim: "her_asama" });   // fikir başına seçilir
    for (const asama of ["brif", "teknik-plan"]) { f = await bekle(hepsi.k, fid, kapida(asama)); hepsi.k.ork.cevapla(fid, hepsiOnay(f)); }
    f = await bekle(hepsi.k, fid, kapida("testler"));
    expect(f.bekleme!.sorular![0].soran_ad).toBe("Test Otomasyon");
    expect(varMi(hepsi.k, fid, "kod/testler/be/sulama.test.mjs")).toBe(true);
    expect(JSON.parse(dosya(hepsi.k, fid, ".kovan/kilitler.json")).yollar).toEqual(["adr"]);        // testler henüz kilitli değil
    hepsi.k.ork.cevapla(fid, hepsiOnay(f));
    await bekle(hepsi.k, fid, bekliyor("insan"));
    expect(JSON.parse(dosya(hepsi.k, fid, ".kovan/kilitler.json")).yollar).toEqual(["adr", "test-be.sh", "testler"]);
    await expect(hepsi.k.ork.yeniFikir("", FIKIR, "kapili", "deneme", { katilim: "bazen" })).rejects.toThrow(/Bilinmeyen katılım: bazen/);
  });

  it("katılım fikir ortasında değişir; değişmeyen belge yeniden doğrulanırken kapı yeniden açılmaz", async () => {
    const { k } = await kur({ katilim: "planlama" });
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    let f = await bekle(k, fid, kapida("brif"));
    k.ork.cevapla(fid, hepsiOnay(f));
    f = await bekle(k, fid, kapida("teknik-plan"));
    k.ork.cevapla(fid, hepsiOnay(f));
    f = await bekle(k, fid, bekliyor("insan"));
    const kabul = f.bekleme!.adim_id;
    // Kabulden kapsama geri gönder: kapsam yeniden yazılır (kapı açılır), teknik plan değişmeden yeniden doğrulanır (kapı açılmaz)
    k.ork.kararVer(fid, "geri_gonder", "Kapsama haftalık özet ekle", "brif");
    f = await bekle(k, fid, kapida("brif"));
    k.ork.cevapla(fid, hepsiOnay(f));
    f = await bekle(k, fid, (x) => x.durum === "bekliyor" && x.bekleme?.adim_id !== kabul && x.bekleme?.sebep === "insan");
    const kapilar = k.depo.adimlar(fid).filter((s) => s.ajan_ad === "Ajan sorusu").map((s) => s.asama_id);
    expect(kapilar).toEqual(["brif", "teknik-plan", "brif"]);
    expect(adimlari(k, fid, "teknik-plan", "uret")).toHaveLength(1);

    k.ork.katilimDegistir(fid, "sonda");
    expect(k.depo.fikir(fid)!.katilim).toBe("sonda");
    expect(() => k.ork.katilimDegistir(fid, "arada")).toThrow(/Bilinmeyen katılım/);
  });

  it("mevcut proje akışında: keşfin kendi öneri kartı var, fark analizinde kapı açılır", async () => {
    const proje = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kovan-kapi-test-")), "taksit");
    fs.cpSync(path.join(KOK, "ornekler", "proje-ornek"), proje, { recursive: true });
    const k = await kovanOlustur({ ayar: { katilim: "planlama", buyuk_birader: ACIK } });
    const fid = await k.ork.yeniFikir("", "Kalan kuruş hatasını düzelt ve taksit özeti ekle.", "proje", "deneme", { proje });
    let f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.kaynak).toBe("kesif");                                     // keşifte çift kart yok
    expect(k.ork.biraderDefteri(fid).map((b) => b.asama_id)).toEqual(["kesif"]);  // Büyük Birader keşfe de bakar
    k.ork.cevapla(fid, [{ secilenler: ["Yeni özellik"] }, { secilenler: ["Orta"] }, { secilenler: ["npm test"] }, { secilenler: ["Onayla"] }]);
    f = await bekle(k, fid, kapida("fark-analizi"), 60_000);
    expect(f.bekleme!.sorular!.at(-1)!.baslik).toBe("Belgenin geneli");
    k.ork.durdur(fid);
  });
});

describe("Ajanla konuşma", () => {
  const cevapBekle = async (k: TestKovani, fid: string, id: number) => {
    for (let i = 0; i < 400; i++) {
      const m = k.ork.sohbetOku(fid).find((x) => x.id === id)!;
      if (m.durum !== "bekliyor") return m;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("konuşma cevabı gelmedi");
  };

  it("kapıda ajana ve Büyük Birader'e soru sorulur; ajan yalnızca okur, cevap karara bağlanınca deftere girer", async () => {
    const { k, deneme } = await kur({ katilim: "planlama", buyuk_birader: ACIK });
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    let f = await bekle(k, fid, kapida("brif"));
    k.ork.cevapla(fid, hepsiOnay(f));
    f = await bekle(k, fid, kapida("teknik-plan"));
    expect(k.ork.fikirDetayi(fid).sohbet_hedefleri.map((h) => `${h.id}@${h.asama_id}`)).toEqual(["urun-sahibi@brif", "mimar@teknik-plan", `${BB}@null`]);

    expect(() => k.ork.sor(fid, "mimar", "teknik-plan", "  ")).toThrow(/Sorunu yaz/);
    expect(() => k.ork.sor(fid, "test-otomasyon", "testler", "Hangi test çatısı?")).toThrow(/şu an soru sorulamaz/);   // belgesi henüz yok
    const id = k.ork.sor(fid, "mimar", "teknik-plan", "Veriyi neden tarayıcıda tutuyoruz, sunucuya taşımak ne kadar iş?");
    const m = await cevapBekle(k, fid, id);
    expect(m).toMatchObject({ hedef: "mimar", hedef_ad: "Ana Mimar", asama_id: "teknik-plan", durum: "tamam", karar: null });
    expect(m.cevap).toContain("Deneme modu: sorunu aldım");
    const cagri = deneme.cagrilar.find((c) => c.gorev_turu === "sohbet")!;
    expect(cagri.araclar).toEqual([]);                                // Mimar'ın kartında araç yok; konuşmada da yok
    expect(cagri.izinli).toEqual([]);
    expect(cagri.sema).toBeNull();
    expect(cagri.sistem).toContain("# Konuşma (projenin sahibi soruyor)");
    expect(cagri.sistem).not.toContain("kovan-ozet");
    expect(cagri.istem).toContain("# Soru (projenin sahibinden)\n\nVeriyi neden tarayıcıda tutuyoruz");
    expect(cagri.istem).toContain("## Bağlam: Teknik plan");
    const adim = k.depo.adimlar(fid).find((s) => s.tip === "sohbet")!;
    expect(adim).toMatchObject({ asama_id: "teknik-plan", ajan: "mimar", durum: "tamam" });
    // Konuşma hiçbir şeyi değiştirmez: kapı yerinde, belge aynı
    expect(k.depo.fikir(fid)!.bekleme!.kaynak).toBe("kapi");

    expect(() => k.ork.sohbetKarari(fid, id, " ")).toThrow(/Kararı bir cümleyle yaz/);
    k.ork.sohbetKarari(fid, id, "Veri ilk sürümde tarayıcıda kalsın; depolama bir arayüzün arkasında olsun.");
    expect(k.ork.kararlar(fid).at(-1)).toMatchObject({ soran: "Ana Mimar", asama_id: "teknik-plan", karar_veren: "insan", cevap: "Veri ilk sürümde tarayıcıda kalsın; depolama bir arayüzün arkasında olsun." });
    expect(() => k.ork.sohbetKarari(fid, id, "bir daha")).toThrow(/zaten karara bağlandı/);

    // Büyük Birader'e soru: fikrin kökünü okur, önceki sorusunu hatırlar
    const id2 = k.ork.sor(fid, BB, "teknik-plan", "Bu iş nereye gidiyor, bir risk görüyor musun?");
    await cevapBekle(k, fid, id2);
    const bb = deneme.cagrilar.filter((c) => c.gorev_turu === "sohbet")[1];
    expect(bb.rol).toBe(BB);
    expect(bb.araclar).toEqual(["Read", "Glob", "Grep"]);
    expect(bb.cwd).toBe(path.join(k.calisma, fid));
    expect(bb.istem).toContain("## Gidişat");
    expect(bb.istem).toContain("Veri ilk sürümde tarayıcıda kalsın");     // karara bağlanan sonuç artık bağlayıcı kararlar arasında
    expect(k.ork.fikirDetayi(fid).sohbet.map((x) => x.durum)).toEqual(["tamam", "tamam"]);
  });

  it("fikir çalışırken ve önceki cevap beklenirken soru sorulamaz; cevap hatası konuşmaya yazılır", async () => {
    const yavas = new SahteMotor("deneme", false, new (await import("../src/motor.js")).DenemeMotoru(0.2));
    const k = await kovanOlustur({
      kok: geciciKok({ kapili: KAPILI }), ayar: { ajan_sorulari: false, katilim: "planlama" },
      motorlar: new Map<string, Motor>([["deneme", yavas], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]),
    });
    const fid = await k.ork.yeniFikir("", FIKIR, "kapili", "deneme");
    await bekle(k, fid, (f) => f.durum === "calisiyor");
    expect(() => k.ork.sor(fid, "urun-sahibi", "brif", "Neden?")).toThrow(/Fikir çalışırken soru sorulamaz/);
    await bekle(k, fid, kapida("brif"));
    const id = k.ork.sor(fid, "urun-sahibi", "brif", "Kapsam neden bu kadar dar?");
    expect(() => k.ork.sor(fid, "urun-sahibi", "brif", "Bir şey daha")).toThrow(/Önceki sorunun cevabı bekleniyor/);
    expect((await cevapBekle(k, fid, id)).durum).toBe("tamam");

    yavas.hataVerecekAsamalar.add("brif");
    const id2 = k.ork.sor(fid, "urun-sahibi", "brif", "Peki ya bildirimler?");
    const m = await cevapBekle(k, fid, id2);
    expect(m).toMatchObject({ durum: "hata" });
    expect(m.cevap).toContain("Soru cevaplanamadı");
    expect(() => k.ork.sohbetKarari(fid, id2, "x")).toThrow(/Karara bağlanacak cevap bulunamadı/);
  });

  it("API: katılım fikirle gelir ve değişir; soru sorulur, cevap detayda görünür, karara bağlanır", async () => {
    const { k } = await kur({ katilim: "sonda", buyuk_birader: ACIK });
    const HOST = { host: "127.0.0.1:8765" };
    const durum = (await k.app.inject({ url: "/api/durum", headers: HOST })).json() as { katilim: string; buyuk_birader: boolean };
    expect(durum).toMatchObject({ katilim: "sonda", buyuk_birader: true });
    const akislar = (await k.app.inject({ url: "/api/akislar", headers: HOST })).json() as { id: string; buyuk_birader: boolean; asamalar: { id: string; kapi: boolean }[] }[];
    expect(akislar.find((a) => a.id === "mini")!.buyuk_birader).toBe(false);
    expect(akislar.find((a) => a.id === "tam-yigin")!.asamalar.filter((a) => a.kapi).map((a) => a.id)).toEqual(["brif", "analiz", "ux-tasarim", "teknik-plan", "teslim-plani"]);

    const r = await k.app.inject({ method: "POST", url: "/api/fikirler", headers: HOST, payload: { metin: FIKIR, profil: "kapili", motor: "deneme", katilim: "planlama" } });
    const fid = (r.json() as { id: string }).id;
    await bekle(k, fid, kapida("brif"));
    const s = await k.app.inject({ method: "POST", url: `/api/fikirler/${fid}/sor`, headers: HOST, payload: { hedef: "urun-sahibi", asama: "brif", soru: "Kapsam dışında ne kaldı?" } });
    expect(s.statusCode).toBe(200);
    const mid = (s.json() as { id: number }).id;
    await cevapBekle(k, fid, mid);
    const d = (await k.app.inject({ url: `/api/fikirler/${fid}`, headers: HOST })).json() as { sohbet: { cevap: string }[]; birader: unknown[]; onaylar: unknown[]; bekleme: { birader: { hukum: string } } };
    expect(d.sohbet[0].cevap).toContain("Deneme modu");
    expect(d.birader).toHaveLength(1);
    expect(d.bekleme.birader.hukum).toBe("UYGUN");
    expect((await k.app.inject({ method: "POST", url: `/api/fikirler/${fid}/sohbet/${mid}/karar`, headers: HOST, payload: { metin: "Bildirimler ikinci sürüme kalsın." } })).statusCode).toBe(200);
    expect(k.ork.kararlar(fid).at(-1)!.cevap).toBe("Bildirimler ikinci sürüme kalsın.");
    expect((await k.app.inject({ method: "POST", url: `/api/fikirler/${fid}/katilim`, headers: HOST, payload: { katilim: "her_asama" } })).statusCode).toBe(200);
    expect(k.depo.fikir(fid)!.katilim).toBe("her_asama");
    expect((await k.app.inject({ method: "POST", url: `/api/fikirler/${fid}/katilim`, headers: HOST, payload: { katilim: "hic" } })).statusCode).toBe(400);
  });
});
