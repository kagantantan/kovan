// Analiz aşamalarında insan döngüsü: iş kuralı soruları ekibe uğramadan sana gelir (is_kurali_sana);
// ajan belgeyi yazmadan önce açık sorularını ve varsayımlarını sana getirir (once_soru).
import path from "node:path";
import { describe, expect, it } from "vitest";
import { akislariYukle } from "../src/akislar.js";
import { kartlariYukle } from "../src/kartlar.js";
import type { AjanCagrisi, AjanSonucu, Motor } from "../src/motor.js";
import { BetikMotor, bekle, bekliyor, dosya, geciciKok, KOK, kovanOlustur, oyCevabi, ORNEK_MINI, SahteMotor, soruBlogu } from "./yardimci/ortam.js";

type Betik = (c: AjanCagrisi) => Partial<AjanSonucu> | null;

const AKIS = (bayraklar: string) => `ad: Kısa analiz
aciklama: Test için analiz ve kabul.
fikir_butcesi_usd: 5
asamalar:
  - id: analiz
    ad: Analiz
    ajan: analist
${bayraklar}    gorev: Analiz yaz.
    girdiler: [fikir]
    cikti: analiz
  - id: kabul
    ad: Kabul
    tur: insan
    soru: Tamam mı?
`;

async function kur(bayraklar: string, betik: Betik) {
  const motorlar = new Map<string, Motor>([
    ["deneme", new BetikMotor("deneme", betik)],
    ["claude", new SahteMotor("claude")],
    ["qwen-yerel", new SahteMotor("qwen-yerel", true)],
  ]);
  return kovanOlustur({ kok: geciciKok({ "kisa-analiz": AKIS(bayraklar) }), motorlar });
}

const secenekler = [{ etiket: "Koddaki gibi 365 (Önerilen)", aciklama: "Üretimdeki sonuç korunur" }, { etiket: "Dokümandaki gibi 360", aciklama: "Doküman esas" }];
const soru = (baslik: string, konu?: string) => ({ baslik, soru: `${baslik}?`, secenekler, ...(konu ? { konu } : {}) });
/** Analist ilk üretimde verilen soruları sorar, cevaptan sonra belgeyi yazar. Oylarda herkes 1'i seçer. */
const analistBetigi = (sorular: object[]): Betik => (c) => {
  if (c.gorev_turu === "karar") return oyCevabi(...sorular.map(() => 1));
  if (c.rol !== "analist" || c.gorev_turu !== "uret") return null;
  if (c.istem.includes("## Alınan kararlar")) return { metin: "# Analiz\nKararlara göre yazıldı." };
  return soruBlogu(sorular);
};
const ISIM = "    is_kurali_sana: true\n";
const ONCE = "    once_soru: true\n";

describe("Analiz aşamalarında insan döngüsü", () => {
  it("is_kurali_sana: iş kuralı (ya da konusu yazılmamış) soru ekibe uğramadan sana gelir; teknik soru ekipte oylanır", async () => {
    const k = await kur(ISIM, analistBetigi([soru("Gün esası", "is_kurali"), soru("Yuvarlama"), soru("Paket yapısı", "teknik")]));
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-analiz", "deneme");
    const f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.sorular!.map((s) => [s.baslik, s.oylar === undefined, s.neden])).toEqual([
      ["Gün esası", true, "İş kuralı sorusu: bu aşamada iş kuralı soruları ekibe uğramadan sana gelir."],
      ["Yuvarlama", true, "İş kuralı sorusu: bu aşamada iş kuralı soruları ekibe uğramadan sana gelir."],
    ]);
    const d = k.ork.fikirDetayi(fid);
    expect(d.kararlar).toEqual([expect.objectContaining({ baslik: "Paket yapısı", karar_veren: "ekip" })]);
    // Oy istemine yalnızca teknik soru gitti
    const oyGunlugu = JSON.parse(dosya(k, fid, `gunluk/adim-${d.adimlar.find((a) => a.tip === "oy")!.id}.json`));
    expect(oyGunlugu.istem).toContain("Paket yapısı");
    expect(oyGunlugu.istem).not.toContain("Gün esası");
    // Soru kuralı ajana konu alanını anlattı
    const uretGunlugu = JSON.parse(dosya(k, fid, `gunluk/adim-${d.adimlar.find((a) => a.tip === "uret")!.id}.json`));
    expect(uretGunlugu.sistem).toContain('Her soruya "konu" yaz: "is_kurali" ya da "teknik"');

    k.ork.cevapla(fid, [{ secilenler: ["Koddaki gibi 365"] }, { secilenler: ["Dokümandaki gibi 360"] }]);
    await bekle(k, fid, bekliyor("insan"));
    expect(k.ork.fikirDetayi(fid).kararlar.map((x) => `${x.baslik}=${x.cevap}:${x.karar_veren}`)).toEqual([
      "Paket yapısı=Koddaki gibi 365:ekip", "Gün esası=Koddaki gibi 365:insan", "Yuvarlama=Dokümandaki gibi 360:insan",
    ]);
  });

  it("once_soru: ilk üretim yalnızca soru turu; sorular (insan: false dese bile) oylanmadan sana gelir, cevaptan sonra belge yazılır", async () => {
    const k = await kur(ONCE, analistBetigi([soru("Gün esası", "teknik")]));
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-analiz", "deneme");
    const f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.sorular![0]).toMatchObject({ baslik: "Gün esası", insan: true, neden: "Kontrol noktası: İş Analisti belgeyi yazmadan önce açık sorularını ve varsayımlarını sana getirdi." });
    let d = k.ork.fikirDetayi(fid);
    expect(d.adimlar.some((a) => a.tip === "oy")).toBe(false);
    const ilk = JSON.parse(dosya(k, fid, `gunluk/adim-${d.adimlar.find((a) => a.tip === "uret")!.id}.json`));
    expect(ilk.sistem).toContain("# Önce soru (kontrol noktası)");

    k.ork.cevapla(fid, [{ secilenler: ["Koddaki gibi 365"] }]);
    await bekle(k, fid, bekliyor("insan"));
    d = k.ork.fikirDetayi(fid);
    const uretler = d.adimlar.filter((a) => a.tip === "uret");
    expect(uretler.map((a) => a.durum)).toEqual(["soru", "tamam"]);
    const ikinci = JSON.parse(dosya(k, fid, `gunluk/adim-${uretler[1].id}.json`));
    expect(ikinci.sistem).not.toContain("# Önce soru");                       // ikinci üretimde normal soru kuralları
    expect(ikinci.istem).toContain("Koddaki gibi 365");
    expect(dosya(k, fid, "belgeler/analiz.md")).toContain("Kararlara göre yazıldı.");
  });

  it("once_soru: ajan soru sormazsa belge yazılır, zaman çizelgesine not düşer; bayraksız aşamada kontrol noktası yok", async () => {
    const yazar: Betik = (c) => {
      if (c.rol !== "analist" || c.gorev_turu !== "uret") return null;
      return { metin: "# Analiz\nSoru sormadan yazıldı." };
    };
    const k = await kur(ONCE, yazar);
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-analiz", "deneme");
    await bekle(k, fid, bekliyor("insan"));
    expect(k.ork.fikirDetayi(fid).adimlar.filter((a) => a.asama_id === "analiz").map((a) => `${a.tip}:${a.durum}:${a.ajan_ad}`).slice(0, 2))
      .toEqual(["uret:tamam:İş Analisti", "sistem:uyari:Kontrol noktası"]);

    const k2 = await kur("", yazar);
    const fid2 = await k2.ork.yeniFikir("", ORNEK_MINI, "kisa-analiz", "deneme");
    await bekle(k2, fid2, bekliyor("insan"));
    const d2 = k2.ork.fikirDetayi(fid2);
    expect(d2.adimlar.some((a) => a.ajan_ad === "Kontrol noktası")).toBe(false);
    expect(JSON.parse(dosya(k2, fid2, `gunluk/adim-${d2.adimlar.find((a) => a.tip === "uret")!.id}.json`)).sistem).not.toContain('Her soruya "konu" yaz');
  });

  it("gerçek akışlarda analiz aşamaları açık, sonrakiler kapalı; Mini'de yok", () => {
    const akislar = akislariYukle(path.join(KOK, "akislar"), kartlariYukle(path.join(KOK, "ajanlar")));
    const acik = (id: string) => akislar.get(id)!.asamalar.filter((a) => a.is_kurali_sana && a.once_soru).map((a) => a.id);
    expect(acik("replatform")).toEqual(["mevcut-sistem", "brif", "hedef-analiz"]);
    expect(acik("standart")).toEqual(["brif", "analiz"]);
    expect(acik("tam-yigin")).toEqual(["brif", "analiz"]);
    expect(acik("mini")).toEqual([]);
  });
});
