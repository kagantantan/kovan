// Sınırlar ve dayanıklılık: yazma alanı ve kilitler, durdur/devam, yeniden başlatma, bütçe, tur sınırı,
// paralel onay kurulu, hibrit yönlendirme ve Claude'a devretme, izin reddi.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DenemeMotoru, type Motor } from "../src/motor.js";
import { bekle, bekliyor, dosya, geciciKok, istemi, kovanOlustur, ORNEK_MINI, SahteMotor, varMi } from "./yardimci/ortam.js";

const KISA_KOD = `ad: Kısa kod
aciklama: Test için iki aşama.
fikir_butcesi_usd: 5
asamalar:
  - id: otomatik-testler
    ad: Otomatik testler
    ajan: test-otomasyon
    calisma_dizini: kod
    gorev: Testleri yaz.
    girdiler: [fikir]
    cikti: test-ozeti
    yazabilir: [testler, test-be.sh]
    kilitle: [testler, test-be.sh]
  - id: be-gelistirme
    ad: BE geliştirme
    ajan: be-yazilimci
    calisma_dizini: kod
    gorev: Kodu yaz.
    girdiler: [fikir, test-ozeti]
    cikti: be-notu
    yazabilir: [backend]
    dogrulama:
      - ad: BE testleri
        komut: bash test-be.sh
        sure_dk: 2
    en_fazla_tur: 1
`;

const KISA_ANALIZ = `ad: Kısa analiz
aciklama: Test için.
fikir_butcesi_usd: 5
asamalar:
  - id: brif
    ad: Brif
    ajan: urun-sahibi
    gorev: Brif yaz.
    girdiler: [fikir]
    cikti: brif
  - id: analiz
    ad: Analiz
    ajan: analist
    gorev: Analiz yaz.
    girdiler: [fikir, brif]
    cikti: analiz
    dogrulama:
      - ad: PO onayı
        inceleyen: urun-sahibi
      - ad: Mimar onayı
        inceleyen: mimar
      - ad: Güvenlik onayı
        inceleyen: guvenlik
    en_fazla_tur: 1
`;

function hibritMotorlar() {
  const claude = new SahteMotor("claude");
  const yerel = new SahteMotor("qwen-yerel", true);
  return { claude, yerel, motorlar: new Map<string, Motor>([["deneme", new DenemeMotoru(0)], ["claude", claude], ["qwen-yerel", yerel]]) };
}

describe("Yazma alanı ve kilitler", () => {
  it("alan dışına ve kilitli testlere yazılanı geri alır, ihlali kaydeder, yazara bildirir", async () => {
    process.env.KOVAN_DENEME_IHLAL = "1";
    try {
      const k = await kovanOlustur({ ayar: { ajan_sorulari: false } });
      const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
      await bekle(k, fid, bekliyor("insan"));
      const d = k.ork.fikirDetayi(fid);
      const ihlal = d.adimlar.filter((a) => a.ajan_ad === "Sınır ihlali");
      expect(ihlal).toHaveLength(1);
      expect(ihlal[0].ozet).toContain("testler/be/sulama.test.mjs (kilitli)");
      expect(ihlal[0].ozet).toContain("notlar.txt (alan dışı)");
      expect(dosya(k, fid, "kod/testler/be/sulama.test.mjs")).not.toContain("testi gevşettim");
      expect(varMi(k, fid, "kod/notlar.txt")).toBe(false);
      // İkinci turda yazar ihlali düzeltme isteklerinde görür
      const beAdimlari = d.adimlar.filter((a) => a.asama_id === "be-gelistirme" && a.tip === "uret");
      expect(istemi(k, fid, beAdimlari[1].id)).toContain("### Sınır ihlali");
    } finally {
      delete process.env.KOVAN_DENEME_IHLAL;
    }
  });
});

describe("Durdur, devam ettir, yeniden başlatma", () => {
  it("çalışan fikir durdurulur ve kaldığı yerden devam eder", async () => {
    const k = await kovanOlustur({ gecikme: 0.25, ayar: { ajan_sorulari: false } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    await bekle(k, fid, (f) => f.durum === "calisiyor" && f.asama_idx >= 1);
    k.ork.durdur(fid);
    await bekle(k, fid, (f) => f.durum === "durduruldu");
    expect(() => k.ork.durdur(fid)).toThrow(/zaten/);
    k.ork.devamEttir(fid);
    await bekle(k, fid, bekliyor("insan"));
    const adlar = k.ork.fikirDetayi(fid).adimlar.map((a) => a.ajan_ad);
    expect(adlar).toContain("Durduruldu");
    expect(adlar).toContain("Devam");
  });

  it("soru beklerken durdurulabilir", async () => {
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(() => k.ork.kararVer(fid, "kabul")).toThrow(/ajan sorusu/);
    k.ork.kararVer(fid, "durdur");
    const f = await bekle(k, fid, (x) => x.durum === "durduruldu");
    expect(f.bekleme).toBeNull();
  });

  it("Kovan yeniden başlarsa yarım kalan iş sana sorulur, 'Tekrar dene' ile sürer", async () => {
    const kok = geciciKok();
    const a = await kovanOlustur({ kok, gecikme: 0.4, ayar: { ajan_sorulari: false } });
    const fid = await a.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    await bekle(a, fid, (f) => f.durum === "calisiyor" && a.depo.adimlar(fid).some((s) => s.durum === "calisiyor"));
    // Süreç çökmüş gibi: o anki diskin kopyasıyla yeni bir Kovan aç
    const kopya = fs.mkdtempSync(path.join(os.tmpdir(), "kovan-kopya-"));
    fs.cpSync(a.calisma, kopya, { recursive: true });
    const b = await kovanOlustur({ kok, ayar: { calisma_dizini: kopya, ajan_sorulari: false } });
    const f = b.depo.fikir(fid)!;
    expect(f.durum).toBe("bekliyor");
    expect(f.bekleme!.sebep).toBe("kesildi");
    expect(f.bekleme!.secenekler.map((s) => s.anahtar)).toEqual(["tekrar_dene", "durdur"]);
    expect(b.depo.adimlar(fid).some((s) => s.durum === "kesildi")).toBe(true);
    b.ork.kararVer(fid, "tekrar_dene");
    await bekle(b, fid, bekliyor("insan"));
  });
});

describe("Bütçe ve tur sınırı", () => {
  it("bütçe dolunca sorar; artırınca devam eder", async () => {
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.depo.fikirGuncelle(fid, { butce_usd: 0.001 });
    k.ork.cevapla(fid, [{ secilenler: ["Türkçe"] }]);
    const f = await bekle(k, fid, bekliyor("butce"));
    expect(f.bekleme!.secenekler[0]).toMatchObject({ anahtar: "butce_artir", onerilen: true });
    k.ork.kararVer(fid, "butce_artir");
    const g = await bekle(k, fid, bekliyor("insan"));
    expect(g.butce_usd).toBe(1);
  });

  it("tur sınırında bulgularla sorar; 'Bir tur daha' notla devam eder", async () => {
    const k = await kovanOlustur({ kok: geciciKok({ "kisa-analiz": KISA_ANALIZ }), ayar: { ajan_sorulari: false } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-analiz", "deneme");
    const f = await bekle(k, fid, bekliyor("tur_siniri"));
    expect(f.bekleme!.secenekler.map((s) => s.anahtar)).toEqual(["bir_tur_daha", "devam", "durdur"]);   // deneme modunda devretme yok
    expect(f.bekleme!.detay).toContain("PO onayı (Ürün Sahibi): DÜZELT");
    k.ork.kararVer(fid, "bir_tur_daha", "Hata davranışını tablo olarak yaz");
    await bekle(k, fid, (x) => x.durum === "tamamlandi");
    const d = k.ork.fikirDetayi(fid);
    const uretim = d.adimlar.filter((a) => a.asama_id === "analiz" && a.tip === "uret");
    expect(uretim).toHaveLength(2);
    expect(istemi(k, fid, uretim[1].id)).toContain("### İnsanın notu\nHata davranışını tablo olarak yaz");
  });

  it("onay kurulu paralel çalışır; kapatılınca sırayla", async () => {
    for (const paralel of [true, false]) {
      const sayan = new SahteMotor("deneme", false, new DenemeMotoru(0.15));
      const k = await kovanOlustur({
        kok: geciciKok({ "kisa-analiz": KISA_ANALIZ }),
        ayar: { ajan_sorulari: false, paralel_inceleme: paralel },
        motorlar: new Map<string, Motor>([["deneme", sayan], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]),
      });
      const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-analiz", "deneme");
      await bekle(k, fid, bekliyor("tur_siniri"));
      expect(sayan.enFazlaAnlik).toBe(paralel ? 3 : 1);
    }
  });
});

describe("Hibrit yönlendirme", () => {
  it("kodu yerel model, gerisini Claude yazar", async () => {
    const { claude, yerel, motorlar } = hibritMotorlar();
    const k = await kovanOlustur({ motorlar });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "hibrit");
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.ork.cevapla(fid, [{ secilenler: ["Türkçe"] }]);
    await bekle(k, fid, bekliyor("insan"));
    expect(yerel.cagrilar.map((c) => c.asama_id)).toEqual(["be-gelistirme", "be-gelistirme"]);
    expect(claude.cagrilar.map((c) => c.asama_id)).toEqual(["brif", "brif", "otomatik-testler"]);
    expect(k.ork.fikirDetayi(fid).motor_cagrilari).toEqual({ claude: 3, "qwen-yerel": 2 });
  });

  it("yerel model kalıcı hata verirse aşama Claude'a devredilebilir", async () => {
    const { claude, yerel, motorlar } = hibritMotorlar();
    yerel.hataVerecekAsamalar.add("be-gelistirme");
    const k = await kovanOlustur({ motorlar, ayar: { ajan_sorulari: false } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "hibrit");
    const f = await bekle(k, fid, bekliyor("hata"));
    expect(yerel.cagrilar).toHaveLength(1);                     // kalıcı hata tekrar denenmez
    expect(f.bekleme!.secenekler.map((s) => s.anahtar)).toEqual(["tekrar_dene", "claude_devral", "atla", "durdur"]);
    k.ork.kararVer(fid, "claude_devral");
    await bekle(k, fid, bekliyor("insan"));
    const d = k.ork.fikirDetayi(fid);
    expect(d.fikir.istisnalar).toEqual({ "be-gelistirme": "claude" });
    expect(d.asamalar.find((a) => a.id === "be-gelistirme")!.motor).toBe("claude");
    expect(claude.cagrilar.filter((c) => c.asama_id === "be-gelistirme").length).toBeGreaterThan(0);
  });

  it("yerel aşama tur sınırına takılınca önerilen seçenek Claude'a devretmek", async () => {
    const { motorlar } = hibritMotorlar();
    const k = await kovanOlustur({ kok: geciciKok({ "kisa-kod": KISA_KOD }), motorlar });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-kod", "hibrit");
    const f = await bekle(k, fid, bekliyor("tur_siniri"));
    expect(f.bekleme!.secenekler.map((s) => s.anahtar)).toEqual(["claude_devral", "bir_tur_daha", "devam", "durdur"]);
    expect(f.bekleme!.secenekler[0].onerilen).toBe(true);
    expect(f.bekleme!.detay).toContain("BE testleri: KIRMIZI");
    k.ork.kararVer(fid, "claude_devral");
    await bekle(k, fid, (x) => x.durum === "tamamlandi");
    const uretim = k.ork.fikirDetayi(fid).adimlar.filter((a) => a.asama_id === "be-gelistirme" && a.tip === "uret");
    expect(uretim.map((a) => a.motor)).toEqual(["qwen-yerel", "claude"]);
  });

  it("izinsiz araç çağrıları zaman çizelgesine düşer", async () => {
    const { yerel, motorlar } = hibritMotorlar();
    yerel.izinRetleri.set("be-gelistirme", ["Bash(curl https://ornek.invalid)"]);
    const k = await kovanOlustur({ motorlar, ayar: { ajan_sorulari: false } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "hibrit");
    await bekle(k, fid, bekliyor("insan"));
    const red = k.ork.fikirDetayi(fid).adimlar.filter((a) => a.ajan_ad === "İzin reddi");
    expect(red.length).toBeGreaterThan(0);
    expect(red[0].ozet).toContain("Bash(curl https://ornek.invalid)");
  });
});
