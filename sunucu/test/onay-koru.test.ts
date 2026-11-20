// Token tasarrufu: revizyon turunda, önceki turda ONAY veren onaycı yeniden bakmaz (onayi_koru).
import { describe, expect, it } from "vitest";
import type { AjanCagrisi, AjanSonucu, Motor } from "../src/motor.js";
import { BetikMotor, bekle, bekliyor, geciciKok, kovanOlustur, ORNEK_MINI, SahteMotor } from "./yardimci/ortam.js";

const AKIS = `ad: İki onaycı
aciklama: Test için analiz, iki onaycı ve kabul.
fikir_butcesi_usd: 5
asamalar:
  - id: analiz
    ad: Analiz
    ajan: analist
    gorev: Analiz yaz.
    girdiler: [fikir]
    cikti: analiz
    dogrulama:
      - ad: Mimari
        inceleyen: mimar
      - ad: Test
        inceleyen: test-analisti
    en_fazla_tur: 3
  - id: kabul
    ad: Kabul
    tur: insan
    soru: Tamam mı?
`;

const karar = (k: "ONAY" | "DUZELT") => ({ yapisal: { karar: k, gerekce: k, bulgular: k === "DUZELT" ? ["E1 eksik"] : [], sorular: [] }, metin: "" });

/** Mimar ilk turda onaylar; Test Analisti ilk turda düzeltme ister, ikinci turda onaylar. */
async function kos(onayi_koru: boolean) {
  const incelemeler: string[] = [];
  const betik = (c: AjanCagrisi): Partial<AjanSonucu> | null => {
    if (c.gorev_turu === "uret") return { metin: c.istem.includes("## Düzeltme istekleri") ? "# Analiz\nE1 eklendi." : "# Analiz\nTaslak." };
    if (c.gorev_turu !== "inceleme") return null;
    const tur = /\(tur (\d+)\)/.exec(c.istem)![1];
    incelemeler.push(`${tur}:${c.rol}`);
    return karar(c.rol === "test-analisti" && tur === "1" ? "DUZELT" : "ONAY");
  };
  const motorlar = new Map<string, Motor>([["deneme", new BetikMotor("deneme", betik)], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]);
  const k = await kovanOlustur({ kok: geciciKok({ "iki-onayci": AKIS }), motorlar, ayar: { onayi_koru, ajan_sorulari: false } });
  const fid = await k.ork.yeniFikir("", ORNEK_MINI, "iki-onayci", "deneme");
  await bekle(k, fid, bekliyor("insan"));
  return { k, fid, incelemeler: incelemeler.sort() };
}

describe("Onay korunur", () => {
  it("revizyon turunda yalnızca düzeltme isteyen yeniden bakar; rozet önceki onayı gösterir", async () => {
    const { k, fid, incelemeler } = await kos(true);
    expect(incelemeler).toEqual(["1:mimar", "1:test-analisti", "2:test-analisti"]);
    const d = k.ork.fikirDetayi(fid);
    expect(d.adimlar.filter((a) => a.ajan_ad === "Onay korundu").map((a) => a.ozet)).toEqual(["Ana Mimar: önceki turda onayladı; bu turda yeniden bakmıyor."]);
    expect(d.asamalar[0].onaylar.map((o) => `${o.kisa}:${o.durum}`)).toEqual(["TKM:onay", "KTST:onay"]);
    // Aşama geçince sonraki aşama için onay listesi boşalır
    expect(k.depo.fikir(fid)!.onaylayanlar).toEqual([]);
  });

  it("onayi_koru: false ise herkes her turda yeniden bakar", async () => {
    const { incelemeler } = await kos(false);
    expect(incelemeler).toEqual(["1:mimar", "1:test-analisti", "2:mimar", "2:test-analisti"]);
  });

  it("karar verirken yazılan not karar defterine girer; onaycı onu 'Alınan kararlar'da görür", async () => {
    const istemler: string[] = [];
    const betik = (c: AjanCagrisi): Partial<AjanSonucu> | null => {
      if (c.gorev_turu === "uret") return { metin: "# Analiz\nE1: tutarlar karşılaştırılır." };
      if (c.gorev_turu !== "inceleme") return null;
      istemler.push(c.istem);
      return karar(c.rol === "test-analisti" && istemler.length <= 2 ? "DUZELT" : "ONAY");
    };
    const motorlar = new Map<string, Motor>([["deneme", new BetikMotor("deneme", betik)], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]);
    const k = await kovanOlustur({ kok: geciciKok({ "iki-onayci": AKIS.replace("en_fazla_tur: 3", "en_fazla_tur: 1") }), motorlar, ayar: { ajan_sorulari: false } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "iki-onayci", "deneme");
    await bekle(k, fid, bekliyor("tur_siniri"));
    k.ork.kararVer(fid, "bir_tur_daha", "Eşdeğerlik değer eşitliğiyle karşılaştırılır; scale farkı sayılmaz.");
    await bekle(k, fid, bekliyor("insan"));
    expect(k.ork.kararlar(fid).at(-1)).toMatchObject({ baslik: "Projenin sahibinin notu", cevap: "Eşdeğerlik değer eşitliğiyle karşılaştırılır; scale farkı sayılmaz.", karar_veren: "insan", asama_id: "analiz" });
    const sonInceleme = istemler.at(-1)!;
    expect(sonInceleme).toContain("## Alınan kararlar");
    expect(sonInceleme).toContain("Eşdeğerlik değer eşitliğiyle karşılaştırılır; scale farkı sayılmaz.");
  });
});
