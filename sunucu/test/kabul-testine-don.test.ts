// Kilitli kabul testinin kendisi hatalıysa: iş kaleminin tur sınırında "Kabul testine geri gönder".
// Test, kalemin kabul testi aşamasında Test Otomasyon tarafından düzeltilir ve yeniden kilitlenir; yazılan kod korunur.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AjanCagrisi, AjanSonucu, Motor } from "../src/motor.js";
import { BetikMotor, bekle, bekliyor, dosya, geciciKok, istemi, kovanOlustur, ORNEK_MINI, SahteMotor } from "./yardimci/ortam.js";

const AKIS = `ad: Kalemli
aciklama: Test için plan, kabul testi ve iş kalemi.
fikir_butcesi_usd: 5
asamalar:
  - id: teslim-plani
    ad: Teslim planı
    ajan: proje-yoneticisi
    gorev: Plan yaz.
    girdiler: [fikir]
    cikti: teslim-plani
    dogrulama:
      - ad: Plan biçimi
        plan: true
  - id: kalemler
    ad: İş kalemleri
    tur: kalemler
    plan: teslim-plani
    gelistiriciler:
      be-yazilimci: { alan: backend, taraf: be }
    adimlar:
      - id: kabul-testi
        ad: Kabul testi
        ajan: test-otomasyon
        calisma_dizini: kod
        gorev: Test yaz.
        girdiler: [teslim-plani]
        cikti: "{kalem_kucuk}-kabul-testi"
        yazabilir: ["testler/{taraf}/{kalem_kucuk}"]
        kilitle: ["testler/{taraf}/{kalem_kucuk}"]
      - id: is-kalemi
        ad: İş kalemi
        ajan: "{gelistirici}"
        calisma_dizini: kod
        gorev: Kodu yaz.
        girdiler: [teslim-plani]
        cikti: "{kalem_kucuk}-is-notu"
        yazabilir: ["{alan}"]
        dogrulama:
          - ad: Testler
            komut: "grep -q dogru testler/be/p1/test.txt"
        en_fazla_tur: 1
  - id: kabul
    ad: Kabul
    tur: insan
    soru: Tamam mı?
`;

describe("Kabul testine geri gönder", () => {
  it("test şüphesi varsa tur sınırında önerilir; test notla düzeltilip yeniden kilitlenir, kod yeniden yazılmadan doğrulanır", async () => {
    const cagrilar: AjanCagrisi[] = [];
    const betik = (c: AjanCagrisi): Partial<AjanSonucu> | null => {
      if (c.gorev_turu !== "uret") return null;
      cagrilar.push(c);
      if (c.rol === "proje-yoneticisi") return { metin: "# Plan\n\n```kovan-plan\n- {id: P1, baslik: Hesap, gelistirici: be-yazilimci, kapsam: hesap}\n```\n" };
      if (c.rol === "test-otomasyon") {
        const yol = path.join(c.cwd, "testler", "be", "p1");
        fs.mkdirSync(yol, { recursive: true });
        // İlk yazımda kurulum hatası; iş kaleminden gelen notla düzeltilir
        fs.writeFileSync(path.join(yol, "test.txt"), c.istem.includes("kilitli testte hata") ? "dogru\n" : "hatali\n");
        return { metin: "Testler yazıldı." };
      }
      fs.mkdirSync(path.join(c.cwd, "backend"), { recursive: true });
      fs.writeFileSync(path.join(c.cwd, "backend", "kod.txt"), "kod\n");
      return { metin: "Kod yazıldı. TEST ŞÜPHESİ: test.txt kurulum hatası yüzünden kırmızı; kod doğru." };
    };
    const motorlar = new Map<string, Motor>([["deneme", new BetikMotor("deneme", betik)], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]);
    const k = await kovanOlustur({ kok: geciciKok({ kalemli: AKIS }), motorlar, ayar: { ajan_sorulari: false } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kalemli", "deneme");

    const f = await bekle(k, fid, bekliyor("tur_siniri"));
    expect(f.bekleme!.asama_id).toBe("p1-is-kalemi");
    expect(f.bekleme!.secenekler.map((s) => [s.anahtar, s.onerilen])).toEqual([
      ["kabul_testine_don", true], ["bir_tur_daha", false], ["devam", false], ["durdur", false],
    ]);
    expect(() => k.ork.kararVer(fid, "kabul_testine_don", "")).toThrow(/not olarak yaz/);

    k.ork.kararVer(fid, "kabul_testine_don", "para() yardımcısı bayrağı true yapıyor; bayraksız senaryonun girdisini koru.");
    await bekle(k, fid, bekliyor("insan"));

    const d = k.ork.fikirDetayi(fid);
    // Test, kabul testi aşamasında notla düzeltildi ve yeniden kilitlendi
    const testCagrilari = cagrilar.filter((c) => c.rol === "test-otomasyon");
    expect(testCagrilari).toHaveLength(2);
    expect(testCagrilari[1].istem).toContain("para() yardımcısı bayrağı true yapıyor");
    expect(dosya(k, fid, "kod/testler/be/p1/test.txt")).toBe("dogru\n");
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toContain("testler/be/p1");
    // Kod yeniden yazılmadı: iş kalemi yalnızca yeniden doğrulandı ve testler yeşil
    expect(cagrilar.filter((c) => c.rol === "be-yazilimci")).toHaveLength(1);
    expect(d.adimlar.some((a) => a.asama_id === "p1-is-kalemi" && a.ajan_ad === "Yeniden doğrulama")).toBe(true);
    expect(d.adimlar.filter((a) => a.asama_id === "p1-is-kalemi" && a.tip === "kontrol").map((a) => a.durum)).toEqual(["kirmizi", "yesil"]);
    expect(k.ork.kararlar(fid).at(-1)).toMatchObject({ baslik: "Projenin sahibinin notu", asama_id: "p1-is-kalemi" });
    expect(istemi(k, fid, d.adimlar.filter((a) => a.tip === "uret" && a.ajan === "test-otomasyon")[1].id)).toContain("## Önceki çalışman");
  });

  it("test şüphesi yoksa seçenek görünmez", async () => {
    const betik = (c: AjanCagrisi): Partial<AjanSonucu> | null => {
      if (c.gorev_turu !== "uret") return null;
      if (c.rol === "proje-yoneticisi") return { metin: "```kovan-plan\n- {id: P1, baslik: Hesap, gelistirici: be-yazilimci, kapsam: hesap}\n```" };
      if (c.rol === "test-otomasyon") {
        fs.mkdirSync(path.join(c.cwd, "testler", "be", "p1"), { recursive: true });
        fs.writeFileSync(path.join(c.cwd, "testler", "be", "p1", "test.txt"), "hatali\n");
      }
      return { metin: "Yazıldı." };
    };
    const motorlar = new Map<string, Motor>([["deneme", new BetikMotor("deneme", betik)], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]);
    const k = await kovanOlustur({ kok: geciciKok({ kalemli: AKIS }), motorlar, ayar: { ajan_sorulari: false } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kalemli", "deneme");
    const f = await bekle(k, fid, bekliyor("tur_siniri"));
    expect(f.bekleme!.secenekler.map((s) => s.anahtar)).toEqual(["bir_tur_daha", "devam", "durdur"]);
  });
});
