// Revizyon turunda belge kısmen ya da baştan yazılırsa (önceki turların kuralları kaybolursa) sistem onay kuruluna
// gitmeden yazara geri çevirir.
import { describe, expect, it } from "vitest";
import type { AjanCagrisi, AjanSonucu, Motor } from "../src/motor.js";
import { belgeButunlugu, kimlikler } from "../src/plan.js";
import { BetikMotor, bekle, bekliyor, geciciKok, istemi, kovanOlustur, ORNEK_MINI, SahteMotor } from "./yardimci/ortam.js";

const TAM = "# Analiz\n\n### E1. Gün esası\n365 gün.\n\n### E2. Yuvarlama\nKuruşa.\n\n### E3. Kapsam\nAktif kartlar.\n\n## Hesaplamalar\n### H1: Faiz\nbakiye × oran / 365\n";

describe("Belge bütünlüğü", () => {
  it("kimlikleri bulur; kayıp ya da yarıdan fazla kısalma hatadır, Kaldırılanlar'da anılan kimlik kayıp sayılmaz", () => {
    expect([...kimlikler("E1, E21 ve H3; FARK-2, ŞÜPHE-6, ADR-1, P2, K4. KE1 ve E1a değil, S12 değil")].sort())
      .toEqual(["ADR-1", "E1", "E21", "FARK-2", "H3", "K4", "P2", "ŞÜPHE-6"]);
    expect(belgeButunlugu(TAM, TAM + "\nEk.").hatalar).toEqual([]);
    const kismi = belgeButunlugu(TAM, "# Analiz (güncelleme)\n\n### E2. Yuvarlama\nKuruşa, yarım yukarı.\n");
    expect(kismi.hatalar[0]).toMatch(/^Önceki sürümde olan 3 kimlik bu sürümde yok: E1, E3, H1\./);
    expect(kismi.hatalar[1]).toMatch(/yarısından kısa/);
    const bilerek = TAM.replace("### E3. Kapsam\nAktif kartlar.\n", "") + "\n## Kaldırılanlar\n- E3: kapsam brife taşındı.\n";
    expect(belgeButunlugu(TAM, bilerek).hatalar).toEqual([]);
  });

  it("revizyonda kısmi belge onay kuruluna gitmeden geri döner; tam belge geçer", async () => {
    const uretimler: string[] = [];
    const incelemeler: string[] = [];
    const betik = (c: AjanCagrisi): Partial<AjanSonucu> | null => {
      if (c.gorev_turu === "uret") {
        const tur = uretimler.length + 1;
        uretimler.push(c.istem);
        // 1: tam taslak · 2: yalnızca düzeltilen bölüm (eski hata) · 3: tam belge, düzeltmeyle
        return { metin: tur === 2 ? "# Analiz (güncelleme)\n\n### E2. Yuvarlama\nKuruşa, yarım yukarı.\n" : tur === 3 ? TAM.replace("Kuruşa.", "Kuruşa, yarım yukarı.") : TAM };
      }
      if (c.gorev_turu !== "inceleme") return null;
      incelemeler.push(/\(tur (\d+)\)/.exec(c.istem)![1]);
      const duzelt = incelemeler.length === 1;
      return { yapisal: { karar: duzelt ? "DUZELT" : "ONAY", gerekce: "-", bulgular: duzelt ? ["E2: yuvarlama modu yazılmamış"] : [], sorular: [] }, metin: "" };
    };
    const AKIS = `ad: Tek onaycı\naciklama: Test.\nfikir_butcesi_usd: 5\nasamalar:\n  - id: analiz\n    ad: Analiz\n    ajan: analist\n    gorev: Analiz yaz.\n    girdiler: [fikir]\n    cikti: analiz\n    dogrulama:\n      - ad: Test\n        inceleyen: test-analisti\n    en_fazla_tur: 4\n  - id: kabul\n    ad: Kabul\n    tur: insan\n    soru: Tamam mı?\n`;
    const motorlar = new Map<string, Motor>([["deneme", new BetikMotor("deneme", betik)], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]);
    const k = await kovanOlustur({ kok: geciciKok({ "tek-onayci": AKIS }), motorlar, ayar: { ajan_sorulari: false } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "tek-onayci", "deneme");
    await bekle(k, fid, bekliyor("insan"));
    const d = k.ork.fikirDetayi(fid);

    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => `${a.tur}:${a.ajan_ad}:${a.durum}`)).toEqual([
      "2:Belge bütünlüğü:kirmizi",                      // geçtiğinde (3. tur) zaman çizelgesine yazılmaz
    ]);
    expect(incelemeler).toEqual(["1", "3"]);            // kısmi belge (tur 2) onay kuruluna gitmedi
    expect(uretimler[2]).toContain("### Belge bütünlüğü: GEÇERSİZ");
    expect(uretimler[2]).toContain("Önceki sürümde olan 3 kimlik bu sürümde yok: E1, E3, H1.");
    // Kısmi belge yürürlükte kalmadı: 3. turda ajana giden "önceki çıktı" tam sürüm
    const ucuncu = istemi(k, fid, d.adimlar.filter((a) => a.tip === "uret")[2].id);
    expect(ucuncu).toContain("## Önceki çıktın");
    expect(ucuncu.split("## Önceki çıktın")[1]).toContain("### E3. Kapsam");
    expect(ucuncu).toContain("Önceki sürüm yeniden yürürlüğe kondu");
  });
});
