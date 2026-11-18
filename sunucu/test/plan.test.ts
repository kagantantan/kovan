// Teslim planı ve gelişim blokları, kalem şablonu, akış denetimi ve bozuk planın üreticiye geri dönmesi.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { akislariYukle } from "../src/akislar.js";
import { kartlariYukle } from "../src/kartlar.js";
import type { Motor } from "../src/motor.js";
import { gelisimCikar, kalemleriGenislet, planCikar } from "../src/plan.js";
import { BetikMotor, bekle, bekliyor, geciciKok, istemi, KOK, kovanOlustur, ORNEK_MINI, SahteMotor } from "./yardimci/ortam.js";

const GEL = ["be-yazilimci", "fe-yazilimci"];
const blok = (govde: string) => "# Plan\n\n```kovan-plan\n" + govde + "\n```\n";

describe("kovan-plan bloğu", () => {
  it("geçerli planı okur ve bağımlılık sırasına dizer", () => {
    const p = planCikar(blok(`- id: P2\n  baslik: Liste\n  gelistirici: be-yazilimci\n  bagimli: [P1]\n  kapsam: liste\n` +
      `- id: p1\n  baslik: Hesap\n  gelistirici: be-yazilimci\n  kabul: K1, K2\n  kapsam: [hesap, doğrulama]`), GEL);
    expect(p.hatalar).toBeUndefined();
    expect(p.kalemler!.map((k) => k.id)).toEqual(["P1", "P2"]);
    expect(p.kalemler![0]).toMatchObject({ kabul: ["K1", "K2"], kapsam: "hesap; doğrulama", bagimli: [] });
  });

  it("JSON da kabul eder", () => {
    const p = planCikar(blok('{"kalemler": [{"id": "P1", "baslik": "A", "gelistirici": "fe-yazilimci", "kapsam": "a"}]}'), GEL);
    expect(p.kalemler!.map((k) => k.gelistirici)).toEqual(["fe-yazilimci"]);
  });

  it("hataları üreticinin düzeltebileceği dille yazar", () => {
    expect(planCikar("# Plan yok", GEL).hatalar![0]).toMatch(/kovan-plan bloğu yok/);
    const h = planCikar(blok(`- id: X1\n  baslik: ""\n  gelistirici: mimar\n  bagimli: [P9]\n  kapsam: a`), GEL).hatalar!.join(" | ");
    expect(h).toContain("X1: id P1, P2 biçiminde olmalı.");
    expect(h).toContain("baslik boş");
    expect(h).toContain("gelistirici şunlardan biri olmalı: be-yazilimci, fe-yazilimci ('mimar' yazılmış)");
    expect(h).toContain("'P9' diye bir kalem yok");
    const dongu = planCikar(blok(`- {id: P1, baslik: A, gelistirici: be-yazilimci, bagimli: [P2], kapsam: a}\n- {id: P2, baslik: B, gelistirici: be-yazilimci, bagimli: [P1], kapsam: b}`), GEL);
    expect(dongu.hatalar).toEqual(["Bağımlılıklarda döngü var; kalemler bir sıraya dizilemiyor."]);
    const cok = Array.from({ length: 9 }, (_, i) => `- {id: P${i + 1}, baslik: K, gelistirici: be-yazilimci, kapsam: k}`).join("\n");
    expect(planCikar(blok(cok), GEL).hatalar![0]).toMatch(/En fazla 8 kalem/);
  });
});

describe("Kalem şablonu", () => {
  it("yer tutucuları doldurur, taraf koşullu onaycıyı yalnızca o taraftaki kalemde tutar", () => {
    const akis = akislariYukle(path.join(KOK, "akislar"), kartlariYukle(path.join(KOK, "ajanlar"))).get("tam-yigin")!;
    const sablon = akis.asamalar.find((a) => a.tur === "kalemler")!;
    const kalemler = planCikar(blok(`- {id: P1, baslik: Hesap, gelistirici: be-yazilimci, kapsam: hesap}\n` +
      `- {id: P2, baslik: Ekran, gelistirici: fe-yazilimci, bagimli: [P1], kapsam: ekran}`), GEL).kalemler!;
    const a = kalemleriGenislet(sablon, kalemler);
    expect(a.map((x) => x.id)).toEqual(["p1-kabul-testi", "p1-is-kalemi", "p2-kabul-testi", "p2-is-kalemi"]);
    const fe = a[3];
    expect(fe).toMatchObject({ ad: "P2 İş kalemi", ajan: "fe-yazilimci", yazabilir: ["frontend"], cikti: "p2-is-notu", kalem: { id: "P2", baslik: "Ekran" } });
    expect(fe.girdiler).toContain("p2-kabul-testi");
    expect(fe.dogrulama.map((v) => v.komut ?? v.inceleyen)).toEqual(["bash test-fe.sh", "analist", "mimar", "test-analisti", "guvenlik", "ux-tasarimci"]);
    expect(a[1].dogrulama.map((v) => v.inceleyen).filter(Boolean)).not.toContain("ux-tasarimci");
    expect(a[2]).toMatchObject({ yazabilir: ["testler/fe/p2"], kilitle: ["testler/fe/p2"] });
    expect(a[2].gorev).toContain("P2 (Ekran) için kabul testlerini yaz");
    expect(kalemleriGenislet(sablon, kalemler, 2)[0].id).toBe("v2-p1-kabul-testi");
  });
});

describe("kovan-gelisim bloğu", () => {
  it("önerileri okur; eforu ve önceliği normalleştirir", () => {
    const g = gelisimCikar("```kovan-gelisim\n- {id: g1, baslik: A, aciklama: a, efor: büyük, oncelik: Yüksek}\n- {baslik: B, aciklama: b}\n```");
    expect(g.oneriler!.map((o) => `${o.id}:${o.efor}:${o.oncelik}`)).toEqual(["G1:L:yuksek", "G2:M:orta"]);
    expect(gelisimCikar("öneri yok").hatalar![0]).toMatch(/kovan-gelisim bloğu yok/);
  });
});

describe("Akış denetimi", () => {
  const yukle = (yaml: string) => {
    const kok = geciciKok({ bozuk: yaml });
    return () => akislariYukle(path.join(kok, "akislar"), kartlariYukle(path.join(kok, "ajanlar")));
  };
  const BAS = `ad: Bozuk\naciklama: test\nasamalar:\n  - {id: plan, ad: Plan, ajan: proje-yoneticisi, girdiler: [fikir], cikti: plan}\n`;

  it("kalemler aşamasında planı, yazılımcıları ve şablon girdilerini denetler", () => {
    expect(yukle(BAS + "  - {id: k, ad: K, tur: kalemler, plan: yok, gelistiriciler: {be-yazilimci: {alan: backend, taraf: be}}, adimlar: [{id: a, ajan: be-yazilimci, cikti: x}]}"))
      .toThrow(/'plan' daha önceki bir aşamanın/);
    expect(yukle(BAS + "  - {id: k, ad: K, tur: kalemler, plan: plan, gelistiriciler: {hayali: {alan: a, taraf: b}}, adimlar: [{id: a, ajan: be-yazilimci, cikti: x}]}"))
      .toThrow(/gelistiriciler: 'hayali' için kart yok/);
    expect(yukle(BAS + "  - {id: k, ad: K, tur: kalemler, plan: plan, gelistiriciler: {be-yazilimci: {alan: backend, taraf: be}}, adimlar: [{id: a, ajan: '{gelistirici}', girdiler: ['{kalem_kucuk}-yok'], cikti: x}]}"))
      .toThrow(/girdi '\{kalem_kucuk\}-yok' daha önceki bir aşamada üretilmiyor/);
    expect(yukle(BAS.replace("cikti: plan}", "cikti: plan, dogrulama: [{plan: true}]}")))
      .toThrow(/plan denetimi var ama bu belgeyi açan/);
    expect(yukle(BAS.replace("cikti: plan}", "cikti: plan, dogrulama: [{inceleyen: mimar, taraf: fe}]}")))
      .toThrow(/'taraf' koşulu yalnızca kalem adımlarında/);
  });
});

describe("Bozuk plan ve gelişim", () => {
  const PLANLI = `ad: Planlı
aciklama: test
asamalar:
  - id: teslim-plani
    ad: Teslim planı
    ajan: proje-yoneticisi
    girdiler: [fikir]
    cikti: teslim-plani
    dogrulama: [{ad: Plan biçimi, plan: true}]
  - id: kalemler
    ad: İş kalemleri
    tur: kalemler
    plan: teslim-plani
    gelistiriciler: {be-yazilimci: {alan: backend, taraf: be}}
    adimlar:
      - {id: is-kalemi, ad: İş kalemi, ajan: "{gelistirici}", calisma_dizini: kod, girdiler: [teslim-plani], cikti: "{kalem_kucuk}-notu", yazabilir: ["{alan}"]}
  - id: gelisim
    ad: Gelişim önerileri
    tur: gelisim
    ajan: urun-sahibi
    girdiler: [teslim-plani, gelisim-defteri]
    cikti: gelisim-onerileri
`;

  it("plan bloğu bozuksa onay kurulu harcanmaz, bulgu üreticiye döner; gelişim kartları 'atla' ile geçilebilir", async () => {
    let ilk = true;
    let gelisimIlk = true;
    const motorlar = new Map<string, Motor>([
      ["deneme", new BetikMotor("deneme", (c) => {
        if (c.rol === "proje-yoneticisi" && ilk) { ilk = false; return { metin: "# Plan\n\nKalemler: P1, P2 (blok unutuldu)" }; }
        if (c.rol === "urun-sahibi" && c.asama_id === "gelisim" && gelisimIlk) { gelisimIlk = false; return { metin: "# Öneriler\n\n- daha iyi olsun" }; }
        return null;
      })],
      ["claude", new SahteMotor("claude")],
      ["qwen-yerel", new SahteMotor("qwen-yerel", true)],
    ]);
    const k = await kovanOlustur({ kok: geciciKok({ planli: PLANLI }), motorlar });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "planli", "deneme");
    const f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.kaynak).toBe("gelisim");
    const d = k.ork.fikirDetayi(fid);
    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => `${a.ajan_ad}:${a.durum}`)).toEqual([
      "Plan biçimi:kirmizi", "Plan biçimi:yesil", "Öneri biçimi:kirmizi", "Öneri biçimi:yesil",
    ]);
    const ikinci = d.adimlar.filter((a) => a.asama_id === "teslim-plani" && a.tip === "uret")[1];
    expect(istemi(k, fid, ikinci.id)).toContain("### Plan biçimi: GEÇERSİZ\n- Belgede ```kovan-plan bloğu yok.");
    expect(d.asamalar.map((a) => a.id)).toEqual(["teslim-plani", "p1-is-kalemi", "p2-is-kalemi", "p3-is-kalemi", "gelisim"]);

    expect(() => k.ork.kararVer(fid, "kabul")).toThrow(/ajan sorusu/);
    k.ork.kararVer(fid, "atla");
    await bekle(k, fid, (x) => x.durum === "tamamlandi");
    const son = k.ork.fikirDetayi(fid);
    expect(son.gelisim).toEqual([]);
    expect(son.sonraki_surum_metni).toBeNull();
    expect(fs.existsSync(path.join(k.calisma, fid, "belgeler", "gelisim-defteri.md"))).toBe(false);
  });
});
