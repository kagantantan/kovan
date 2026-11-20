// Mimari karar kayıtları (ADR): kovan-adr bloğu, sistem denetimi, kod/adr/ altına yazılıp kilitlenmesi, yazılımcıya gösterilmesi.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { akislariYukle } from "../src/akislar.js";
import { kartlariYukle } from "../src/kartlar.js";
import type { AjanCagrisi, AjanSonucu, Motor } from "../src/motor.js";
import { adrCikar, adrDosyaAdi, adrMarkdown } from "../src/plan.js";
import { BetikMotor, bekle, bekliyor, dosya, geciciKok, KOK, kovanOlustur, ORNEK_MINI, SahteMotor } from "./yardimci/ortam.js";

const ADR = (id: string, alan: string, karar = "Batch job") => `  - id: ${id}
    baslik: Gün sonu batch job olarak çalışır
    alan: ${alan}
    baglam: Tek giriş noktası, zamanlayıcının çağırdığı prosedür.
    secenekler:
      - ad: Batch job
        arti: Yeniden başlatma hazır
        eksi: Anlık sorgu yok
      - ad: REST endpoint
        arti: Anlık çağrı
        eksi: Uzun iş zaman aşımına takılır
    karar: ${karar}
    gerekce: 20M satır tek istekte işlenemez.
    sonuclar: Domain saf kalır.
    kurallar: [e1, P2]`;
const belge = (...adrler: string[]) => "# Teknik plan\n\n```kovan-adr\nadrler:\n" + adrler.join("\n") + "\n```\n";

describe("kovan-adr bloğu", () => {
  it("geçerli ADR'leri okur; id'yi ve kural kimliklerini düzeltir", () => {
    const r = adrCikar(belge(ADR("adr-001", "calisma_bicimi"), ADR("ADR-2", "veri", "rest endpoint")), { en_az: 2, zorunlu: ["calisma_bicimi"] });
    expect(r.hatalar).toBeUndefined();
    expect(r.adrler!.map((a) => [a.id, a.alan, a.karar])).toEqual([["ADR-1", "calisma_bicimi", "Batch job"], ["ADR-2", "veri", "rest endpoint"]]);
    expect(r.adrler![0].kurallar).toEqual(["E1", "P2"]);
    expect(r.adrler![0].secenekler).toHaveLength(2);
  });

  it("hataları mimarın düzeltebileceği dille yazar", () => {
    expect(adrCikar("# Plan").hatalar![0]).toMatch(/kovan-adr bloğu yok/);
    const tekSecenek = `  - id: ADR-1\n    baslik: A\n    alan: hiz\n    baglam: b\n    secenekler:\n      - ad: Tek\n        arti: x\n    karar: Başka\n    gerekce: g\n    sonuclar: s`;
    const h = adrCikar(belge(tekSecenek), { en_az: 2, zorunlu: ["calisma_bicimi"] }).hatalar!.join(" | ");
    expect(h).toContain("En az 2 ADR olmalı");
    expect(h).toContain("alan şunlardan biri olmalı");
    expect(h).toContain("en az iki seçenek olmalı");
    expect(h).toContain("1. seçenekte ad, arti ve eksi zorunlu");
    expect(h).toContain("'calisma_bicimi' alanında bir ADR yok");
    expect(adrCikar(belge(ADR("ADR-1", "veri", "Kuyruk"))).hatalar!.join(" ")).toContain("karar ('Kuyruk') seçeneklerden birinin adıyla aynı olmalı");
    expect(adrCikar(belge(ADR("ADR-1", "veri"), ADR("ADR-1", "test"))).hatalar!.join(" ")).toContain("aynı id iki kez");
  });

  it("Markdown dosyası: seçilen seçenek işaretli, dosya adı Türkçe karaktersiz", () => {
    const a = adrCikar(belge(ADR("ADR-1", "calisma_bicimi"))).adrler![0];
    expect(adrDosyaAdi(a)).toBe("ADR-001-gun-sonu-batch-job-olarak-calisir.md");
    const md = adrMarkdown(a, "2026-11-19");
    expect(md).toContain("# ADR-1: Gün sonu batch job olarak çalışır");
    expect(md).toContain("### Batch job (seçildi)");
    expect(md).toContain("### REST endpoint\n");
    expect(md).toContain("- Durum: Kabul edildi (2026-11-19)");
  });

  it("akış dosyası bilinmeyen zorunlu alanı reddeder; gerçek akışlarda teknik plan ADR ister, replatform çalışma biçimini", () => {
    const kok = geciciKok({ bozuk: "ad: B\naciklama: b\nasamalar:\n  - id: t\n    ad: T\n    ajan: mimar\n    gorev: g\n    girdiler: [fikir]\n    cikti: t\n    dogrulama:\n      - adr: { zorunlu: [hiz] }\n" });
    expect(() => akislariYukle(path.join(kok, "akislar"), kartlariYukle(path.join(kok, "ajanlar")))).toThrow(/bilinmeyen alan 'hiz'/);
    const akislar = akislariYukle(path.join(KOK, "akislar"), kartlariYukle(path.join(KOK, "ajanlar")));
    const adr = (id: string) => akislar.get(id)!.asamalar.find((a) => a.id === "teknik-plan")?.dogrulama.find((v) => v.tip === "adr");
    expect(adr("replatform")).toMatchObject({ adr_en_az: 2, adr_zorunlu: ["calisma_bicimi"] });
    expect(adr("standart")).toMatchObject({ adr_en_az: 1, adr_zorunlu: [] });
    expect(adr("tam-yigin")).toMatchObject({ adr_en_az: 1 });
    expect(adr("mini")).toBeUndefined();
  });
});

const AKIS = `ad: ADR denemesi
aciklama: Test için teknik plan ve kod.
fikir_butcesi_usd: 5
asamalar:
  - id: teknik-plan
    ad: Teknik plan
    ajan: mimar
    gorev: Plan yaz.
    girdiler: [fikir]
    cikti: teknik-plan
    dogrulama:
      - ad: ADR biçimi
        adr: { en_az: 1, zorunlu: [calisma_bicimi] }
  - id: kod
    ad: Kod
    ajan: be-yazilimci
    calisma_dizini: kod
    gorev: Kod yaz.
    girdiler: [teknik-plan]
    cikti: kod
    yazabilir: [backend]
  - id: kabul
    ad: Kabul
    tur: insan
    soru: Tamam mı?
`;

describe("ADR aşaması", () => {
  it("bozuk ADR onay kuruluna gitmeden mimara döner; onaydan sonra adr/ altına yazılır, kilitlenir ve yazılımcıya gösterilir", async () => {
    const cagrilar: AjanCagrisi[] = [];
    const betik = (c: AjanCagrisi): Partial<AjanSonucu> | null => {
      if (c.gorev_turu !== "uret") return null;
      cagrilar.push(c);
      if (c.rol === "mimar") return { metin: c.istem.includes("ADR biçimi: GEÇERSİZ") ? belge(ADR("ADR-1", "calisma_bicimi")) : belge(ADR("ADR-1", "veri")) };
      // Yazılımcı kilitli ADR'yi değiştirmeye çalışır: sistem geri alır
      fs.writeFileSync(path.join(c.cwd, "adr", "README.md"), "bozuldu");
      return { metin: "Kod yazıldı." };
    };
    const motorlar = new Map<string, Motor>([["deneme", new BetikMotor("deneme", betik)], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]);
    const k = await kovanOlustur({ kok: geciciKok({ "adr-denemesi": AKIS }), motorlar });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "adr-denemesi", "deneme");
    await bekle(k, fid, bekliyor("insan"));
    const d = k.ork.fikirDetayi(fid);

    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => `${a.ajan_ad}:${a.durum}`)).toEqual(["ADR biçimi:kirmizi", "ADR biçimi:yesil"]);
    const mimar = cagrilar.filter((c) => c.rol === "mimar");
    expect(mimar).toHaveLength(2);
    expect(mimar[1].istem).toContain("'calisma_bicimi' alanında bir ADR yok");

    expect(d.adrler.map((a) => [a.id, a.karar])).toEqual([["ADR-1", "Batch job"]]);
    expect(d.asamalar.find((a) => a.id === "teknik-plan")!.onaylar).toEqual([expect.objectContaining({ kisa: "ADR", durum: "yesil" })]);
    expect(dosya(k, fid, "kod/adr/ADR-001-gun-sonu-batch-job-olarak-calisir.md")).toContain("### Batch job (seçildi)");
    expect(dosya(k, fid, "kod/adr/README.md")).toContain("| [ADR-1](ADR-001-gun-sonu-batch-job-olarak-calisir.md)");
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toContain("adr");

    const yazilimci = cagrilar.find((c) => c.rol === "be-yazilimci")!;
    expect(yazilimci.istem).toContain("MİMARİ KARARLAR `adr/` altında (ADR-1)");
    // Kilitli ADR'ye yazma geri alındı
    expect(dosya(k, fid, "kod/adr/README.md")).toContain("# Mimari karar kayıtları");
  });

  it("tur sınırında 'devam' ile geçilen aşamanın ADR'leri de yazılır; eksik kalmışsa açılışta tamamlanır", async () => {
    const AKIS_DUZELT = AKIS.replace("        adr: { en_az: 1, zorunlu: [calisma_bicimi] }", "        adr: { en_az: 1, zorunlu: [calisma_bicimi] }\n      - ad: Analist onayı\n        inceleyen: analist").replace("    girdiler: [fikir]\n    cikti: teknik-plan", "    girdiler: [fikir]\n    cikti: teknik-plan\n    en_fazla_tur: 1");
    const betik = (c: AjanCagrisi): Partial<AjanSonucu> | null => {
      if (c.gorev_turu === "inceleme") return { yapisal: { karar: "DUZELT", gerekce: "-", bulgular: ["eksik"], sorular: [] }, metin: "" };
      if (c.gorev_turu !== "uret") return null;
      return { metin: c.rol === "mimar" ? belge(ADR("ADR-1", "calisma_bicimi")) : "Kod yazıldı." };
    };
    const motorlar = () => new Map<string, Motor>([["deneme", new BetikMotor("deneme", betik)], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]);
    const kok = geciciKok({ "adr-denemesi": AKIS_DUZELT });
    const k = await kovanOlustur({ kok, motorlar: motorlar() });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "adr-denemesi", "deneme");
    await bekle(k, fid, bekliyor("tur_siniri"));
    k.ork.kararVer(fid, "devam");
    await bekle(k, fid, bekliyor("insan"));
    expect(k.ork.fikirDetayi(fid).adrler.map((a) => a.id)).toEqual(["ADR-1"]);
    expect(dosya(k, fid, "kod/adr/ADR-001-gun-sonu-batch-job-olarak-calisir.md")).toContain("(seçildi)");

    // Eski sürümde yazılmamış gibi: kayıt ve dosyalar silinir, Kovan yeniden açılınca tamamlanır
    fs.rmSync(path.join(k.calisma, fid, "kod", "adr"), { recursive: true, force: true });
    fs.rmSync(path.join(k.calisma, fid, ".kovan", "adr.json"));
    const k2 = await kovanOlustur({ kok, motorlar: motorlar() });
    expect(k2.ork.fikirDetayi(fid).adrler.map((a) => a.id)).toEqual(["ADR-1"]);
    expect(dosya(k2, fid, "kod/adr/README.md")).toContain("ADR-1");
  });
});
