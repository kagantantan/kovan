// Mevcut proje üzerinde iş: proje içe alma (birebir kopya, atlananlar, sınırlar), test komutu saptama, yama üretimi;
// iş önerisi bloğu, koşullu aşamalar; uçtan uca küçük, orta ve büyük yol, öneri kartı, baz çizgisi, önce kırmızı, sınırlar.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { akislariYukle, bosAsama } from "../src/akislar.js";
import { kartlariYukle } from "../src/kartlar.js";
import type { Motor } from "../src/motor.js";
import { isCikar, isUygula, kosulTutar } from "../src/plan.js";
import { projeEnvanteri, projeIceAl, sirDosyasiMi, testKomutuSapta, yamaOkuBeni, yamaUret, yamaYaz } from "../src/proje.js";
import type { IsKaydi } from "../src/tipler.js";
import { BetikMotor, KOK, SahteMotor, bekle, bekliyor, dosya, geciciKok, istemi, kovanOlustur, varMi, type TestKovani } from "./yardimci/ortam.js";

const gecici = () => fs.mkdtempSync(path.join(os.tmpdir(), "kovan-proje-test-"));
const yaz = (kok: string, rel: string, icerik: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(kok, rel)), { recursive: true });
  fs.writeFileSync(path.join(kok, rel), icerik);
};
const oku = (kok: string, rel: string) => fs.readFileSync(path.join(kok, rel));
const ozet = (yol: string) => crypto.createHash("sha256").update(fs.readFileSync(yol)).digest("hex");
const gitVar = spawnSync("git", ["--version"]).status === 0;

function ornekProje(): string {
  const p = path.join(gecici(), "hesap");
  yaz(p, "package.json", JSON.stringify({ name: "hesap", scripts: { test: "node test.mjs" } }));
  yaz(p, "src/faiz.mjs", "export function faiz(tutar, oran) {\n  return tutar * oran;\n}\n");
  yaz(p, "src/eski.mjs", "export const eski = 1;\n");
  yaz(p, "test.mjs", "console.log('tamam');\n");
  return p;
}

describe("Proje içe alma", () => {
  it("birebir kopyalar: kodlama çevrilmez, asıl kopya ayrıca saklanır, verilen klasör değişmez", () => {
    const p = ornekProje();
    const turkce = Buffer.from([0x2f, 0x2f, 0x20, 0xfd, 0xfe, 0xf0, 0x0a]);   // Windows-1254: "// ışğ"
    yaz(p, "src/Eski.java", turkce);
    yaz(p, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const once = ozet(path.join(p, "src/Eski.java"));
    const d = gecici();
    const o = projeIceAl(p, path.join(d, "proje"), path.join(d, "asil"));
    expect(oku(path.join(d, "proje"), "src/Eski.java").equals(turkce)).toBe(true);
    expect(oku(path.join(d, "asil"), "src/Eski.java").equals(turkce)).toBe(true);
    expect(fs.existsSync(path.join(d, "proje", "logo.png"))).toBe(true);
    expect(ozet(path.join(p, "src/Eski.java"))).toBe(once);
    expect(o.utf8_olmayan).toEqual(["src/Eski.java"]);
    expect(o.dosya_sayisi).toBe(6);
    expect(o.test_komutu).toBe("npm test");
    const env = projeEnvanteri(o);
    expect(env).toContain("proje/src/");
    expect(env).toContain("UTF-8 olmayan dosyalar");
  });

  it("sürüm kontrolü, bağımlılık ve derleme klasörlerini, sembolik bağları ve sır dosyalarını almaz", () => {
    const p = ornekProje();
    yaz(p, ".git/config", "[core]\n");
    yaz(p, "node_modules/x/index.js", "1\n");
    yaz(p, "target/classes/A.class", Buffer.from([0xca, 0xfe]));
    yaz(p, ".env", "PAROLA=gizli\n");
    yaz(p, ".env.example", "PAROLA=\n");
    yaz(p, "sertifika/sunucu.pem", "-----BEGIN-----\n");
    fs.symlinkSync(path.join(p, "src"), path.join(p, "bag"));
    const d = gecici();
    const o = projeIceAl(p, path.join(d, "proje"), path.join(d, "asil"));
    for (const rel of [".git", "node_modules", "target", ".env", "sertifika/sunucu.pem", "bag"]) expect(fs.existsSync(path.join(d, "proje", rel))).toBe(false);
    expect(fs.existsSync(path.join(d, "proje", ".env.example"))).toBe(true);
    expect(o.atlanan.map((a) => a.yol).sort()).toEqual([".env", ".git/", "bag", "node_modules/", "sertifika/sunucu.pem", "target/"]);
    expect(sirDosyasiMi(".env.production")).toBe(true);
    expect(sirDosyasiMi("anahtar.JKS")).toBe(true);
    expect(sirDosyasiMi("env.ts")).toBe(false);
  });

  it("klasör olmayan, bulunmayan ya da boş yolu anlaşılır hatayla reddeder ve geride bir şey bırakmaz", () => {
    const d = gecici();
    const hedef = path.join(d, "proje");
    expect(() => projeIceAl("", hedef, path.join(d, "asil"))).toThrow(/klasörünü yaz/);
    expect(() => projeIceAl(path.join(d, "yok"), hedef, path.join(d, "asil"))).toThrow(/bulunamadı/);
    const dosya = path.join(d, "tek.txt");
    fs.writeFileSync(dosya, "x");
    expect(() => projeIceAl(dosya, hedef, path.join(d, "asil"))).toThrow(/klasör olmalı/);
    const bos = path.join(d, "bos");
    fs.mkdirSync(bos);
    expect(() => projeIceAl(bos, hedef, path.join(d, "asil"))).toThrow(/dosya bulunamadı/);
    expect(fs.existsSync(hedef)).toBe(false);
    expect(fs.existsSync(path.join(d, "asil"))).toBe(false);
  });

  it("Kovan'ın çalışma klasörünü içeren proje yolunu reddeder", () => {
    const p = ornekProje();
    expect(() => projeIceAl(p, path.join(p, "calisma", "F-1", "kod", "proje"), path.join(p, "calisma", "F-1", "asil"))).toThrow(/çalışma klasörünü içeriyor/);
  });
});

describe("Test komutu saptama", () => {
  it("Maven, Gradle ve npm projelerini tanır; sarmalayıcı varsa onu önerir", () => {
    const kur = (dosyalar: Record<string, string>) => { const k = gecici(); for (const [a, i] of Object.entries(dosyalar)) yaz(k, a, i); return k; };
    expect(testKomutuSapta(kur({ "pom.xml": "<project/>" }))).toBe("mvn -q test");
    expect(testKomutuSapta(kur({ "pom.xml": "<project/>", mvnw: "#!/bin/sh\n" }))).toBe("./mvnw -q test");
    expect(testKomutuSapta(kur({ "build.gradle.kts": "" }))).toBe("gradle test");
    expect(testKomutuSapta(kur({ "build.gradle": "", gradlew: "" }))).toBe("./gradlew test");
    expect(testKomutuSapta(kur({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) }))).toBe("npm test");
    expect(testKomutuSapta(kur({ "package.json": JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }) }))).toBeNull();
    expect(testKomutuSapta(kur({ "package.json": "{bozuk" }))).toBeNull();
    expect(testKomutuSapta(kur({ "README.md": "x" }))).toBeNull();
  });
});

describe("Yama", () => {
  const hazirla = () => {
    const p = ornekProje();
    const d = gecici();
    projeIceAl(p, path.join(d, "proje"), path.join(d, "asil"));
    return { p, calisan: path.join(d, "proje"), asil: path.join(d, "asil"), cikti: path.join(d, "cikti") };
  };

  it("değişen, eklenen ve silinen dosyaları birleşik diff olarak verir; derleme çıktıları farka girmez", () => {
    const { calisan, asil } = hazirla();
    yaz(calisan, "src/faiz.mjs", "export function faiz(tutar, oran) {\n  return Math.round(tutar * oran * 100) / 100;\n}\n");
    yaz(calisan, "src/yeni/gun.mjs", "export const GUN = 365;\n");
    fs.rmSync(path.join(calisan, "src/eski.mjs"));
    yaz(calisan, "node_modules/y/index.js", "1\n");
    yaz(calisan, "target/rapor.txt", "x\n");
    const y = yamaUret(asil, calisan);
    expect(y.dosyalar).toEqual([
      { yol: "src/eski.mjs", durum: "silindi", ayri: false },
      { yol: "src/faiz.mjs", durum: "degisti", ayri: false },
      { yol: "src/yeni/gun.mjs", durum: "eklendi", ayri: false },
    ]);
    expect(y.yama).toContain("diff --git a/src/faiz.mjs b/src/faiz.mjs");
    expect(y.yama).toContain("-  return tutar * oran;");
    expect(y.yama).toContain("+  return Math.round(tutar * oran * 100) / 100;");
    expect(y.yama).toContain("new file mode 100644\n--- /dev/null\n+++ b/src/yeni/gun.mjs\n@@ -0,0 +1,1 @@\n+export const GUN = 365;");
    expect(y.yama).toContain("deleted file mode 100644\n--- a/src/eski.mjs\n+++ /dev/null\n@@ -1,1 +0,0 @@");
    expect(y.yama).not.toContain("node_modules");
    expect(y.yama).not.toContain("target/");
  });

  it("değişiklik yoksa yama boştur", () => {
    const { calisan, asil } = hazirla();
    expect(yamaUret(asil, calisan)).toEqual({ yama: "", dosyalar: [] });
  });

  it("ikili ve UTF-8 olmayan dosyalar yamaya girmez; yeni halleri dosyalar/ altına kopyalanır", () => {
    const { p, calisan, asil, cikti } = hazirla();
    yaz(asil, "src/Eski.java", Buffer.from([0x2f, 0x2f, 0x20, 0xfd, 0x0a]));
    yaz(calisan, "src/Eski.java", Buffer.from([0x2f, 0x2f, 0x20, 0xfd, 0xfe, 0x0a]));
    yaz(calisan, "logo.png", Buffer.from([0x89, 0x50, 0, 1]));
    const y = yamaYaz(asil, calisan, cikti);
    expect(y.dosyalar).toEqual([{ yol: "logo.png", durum: "eklendi", ayri: true }, { yol: "src/Eski.java", durum: "degisti", ayri: true }]);
    expect(y.yama).toBe("");
    expect(oku(cikti, "dosyalar/src/Eski.java").equals(oku(calisan, "src/Eski.java"))).toBe(true);
    expect(fs.existsSync(path.join(cikti, "dosyalar/logo.png"))).toBe(true);
    const beni = yamaOkuBeni(y, p);
    expect(beni).toContain("git apply degisiklik.patch");
    expect(beni).toContain("Yamaya girmeyenler");
  });

  it.runIf(gitVar)("üretilen yama asıl projeye git apply ile uygulanır ve çalışma kopyasıyla aynı sonucu verir", () => {
    const { p, calisan, asil, cikti } = hazirla();
    yaz(calisan, "src/faiz.mjs", "export function faiz(tutar, oran) {\n  return Math.round(tutar * oran * 100) / 100;\n}\n");
    yaz(calisan, "src/yeni/gun.mjs", "export const GUN = 365;\nexport const AY = 12;");   // sonda satır sonu yok
    yaz(calisan, "bos.txt", "");
    fs.rmSync(path.join(calisan, "src/eski.mjs"));
    yaz(calisan, "test.mjs", "console.log('tamam');\r\nconsole.log('iki');\r\n");          // CRLF
    yamaYaz(asil, calisan, cikti);
    execFileSync("git", ["apply", "--check", path.join(cikti, "degisiklik.patch")], { cwd: p });
    execFileSync("git", ["apply", path.join(cikti, "degisiklik.patch")], { cwd: p });
    for (const rel of ["src/faiz.mjs", "src/yeni/gun.mjs", "test.mjs", "bos.txt"]) expect(oku(p, rel).equals(oku(calisan, rel))).toBe(true);
    expect(fs.existsSync(path.join(p, "src/eski.mjs"))).toBe(false);
  });
});

// ------------------------------ iş önerisi bloğu ve koşullu aşamalar ------------------------------
const blok = (govde: string) => "# Keşif\n\n```kovan-is\n" + govde + "\n```\n";
const GECERLI = "tur: hata\nboyut: kucuk\ngerekce: Tek dosya.\ntaraflar:\n  be:\n    yazma_alani: [proje/src]\n    test_alani: proje/test/kovan";

describe("İş önerisi (kovan-is)", () => {
  it("geçerli bloğu okur; Türkçe yazımı ve sondaki eğik çizgiyi düzeltir", () => {
    expect(isCikar(blok(GECERLI)).is).toEqual({ tur: "hata", boyut: "kucuk", gerekce: "Tek dosya.", taraflar: { be: { yazma_alani: ["proje/src"], test_alani: "proje/test/kovan" } } });
    const r = isCikar(blok("tur: Özellik\nboyut: Büyük\ngerekce: Yeni modül.\ntaraflar:\n  BE:\n    yazma_alani: [./proje/src/, proje/src]\n    test_alani: proje/test/\n  fe:\n    yazma_alani: proje/web\n    test_alani: proje/web/test"));
    expect(r.is).toMatchObject({ tur: "ozellik", boyut: "buyuk" });
    expect(r.is!.taraflar.be).toEqual({ yazma_alani: ["proje/src"], test_alani: "proje/test" });
    expect(r.is!.taraflar.fe.yazma_alani).toEqual(["proje/web"]);
  });

  it("eksik bloğu, bilinmeyen tür ve boyutu, boş gerekçeyi ve tarafsız öneriyi insan diliyle reddeder", () => {
    expect(isCikar("# Keşif").hatalar![0]).toMatch(/kovan-is bloğu yok/);
    const r = isCikar(blok("tur: bakim\nboyut: dev\ntaraflar: {}")).hatalar!.join(" ");
    expect(r).toMatch(/tur şunlardan biri/);
    expect(r).toMatch(/boyut şunlardan biri/);
    expect(r).toMatch(/gerekce boş/);
    expect(isCikar(blok("tur: hata\nboyut: orta\ngerekce: x\ntaraflar: {}")).hatalar![0]).toMatch(/En az bir taraf/);
    expect(isCikar(blok(GECERLI.replace("be:", "mobil:"))).hatalar![0]).toMatch(/'mobil' diye bir taraf yok/);
  });

  it("proje dışına, üst klasöre, mutlak yola, jokere ve projenin tamamına yazma alanı vermez", () => {
    const dene = (yol: string) => isCikar(blok(GECERLI.replace("[proje/src]", `["${yol}"]`))).hatalar?.join(" ") ?? "";
    expect(dene("backend/src")).toMatch(/proje\/ altında olmalı/);
    expect(dene("kaynak/ek")).toMatch(/proje\/ altında olmalı/);
    expect(dene("proje/../../etc")).toMatch(/geçersiz yol/);
    expect(dene("../proje/src")).toMatch(/geçersiz yol/);
    expect(dene("/etc/passwd")).toMatch(/proje\/ altında olmalı/);
    expect(dene("proje/src/**")).toMatch(/joker/);
    expect(dene("proje")).toMatch(/projenin tamamı verilemez/);
    expect(isCikar(blok(GECERLI.replace("proje/test/kovan", "testler/be"))).hatalar![0]).toMatch(/test_alani: 'testler\/be' proje\/ altında/);
  });

  it("küçük iş iki tarafta olamaz", () => {
    const r = isCikar(blok(GECERLI + "\n  fe:\n    yazma_alani: [proje/web]\n    test_alani: proje/web/test"));
    expect(r.hatalar![0]).toMatch(/Küçük iş tek tarafta/);
  });
});

describe("Koşullu aşamalar ve yer tutucular", () => {
  const is: IsKaydi = { tur: "ozellik", boyut: "orta", gerekce: "x", test_komutu: "npm test",
    taraflar: { be: { yazma_alani: ["proje/src/a", "proje/src/b.mjs"], test_alani: "proje/test/kovan" }, fe: { yazma_alani: ["proje/web"], test_alani: "proje/web/test" } } };

  it("koşul boyuta ve tarafa bakar; koşulsuz aşama her işte koşar", () => {
    expect(kosulTutar(null, is)).toBe(true);
    expect(kosulTutar({ boyut: ["orta", "buyuk"] }, is)).toBe(true);
    expect(kosulTutar({ boyut: ["kucuk"] }, is)).toBe(false);
    expect(kosulTutar({ boyut: ["orta"], taraf: ["fe"] }, is)).toBe(true);
    expect(kosulTutar({ taraf: ["fe"] }, { ...is, taraflar: { be: is.taraflar.be } })).toBe(false);
  });

  it("yer tutucular öneri kartından dolar; yazma ve test alanı liste olarak açılır, kalemin tarafına göre daralır", () => {
    const a = { ...bosAsama("x", "X"), ajan: "test-otomasyon", gorev: "Koş: {test_komutu}; tür: {is_turu}", yazabilir: ["{yazma_alani}", "tasarim"], kilitle: ["{test_alani}/p1"] };
    const hepsi = isUygula(a, is);
    expect(hepsi.gorev).toBe("Koş: npm test; tür: Yeni özellik");
    expect(hepsi.yazabilir).toEqual(["proje/src/a", "proje/src/b.mjs", "proje/web", "tasarim"]);
    expect(hepsi.kilitle).toEqual(["proje/test/kovan/p1", "proje/web/test/p1"]);
    const fe = isUygula({ ...a, taraf: "fe" }, is);
    expect(fe.yazabilir).toEqual(["proje/web", "tasarim"]);
    expect(fe.kilitle).toEqual(["proje/web/test/p1"]);
  });

  it("kalem dışındaki {gelistirici} işin tarafından seçilir", () => {
    const a = { ...bosAsama("duzeltme", "Düzeltme"), ajan: "{gelistirici}", yazabilir: ["{yazma_alani}"],
      gelistiriciler: { "be-yazilimci": { alan: "", taraf: "be" }, "fe-yazilimci": { alan: "", taraf: "fe" } } };
    const r = isUygula(a, { ...is, boyut: "kucuk", taraflar: { fe: is.taraflar.fe } });
    expect(r.ajan).toBe("fe-yazilimci");
    expect(r.taraf).toBe("fe");
    expect(r.yazabilir).toEqual(["proje/web"]);
  });
});

describe("Akış şeması (kaynak: proje)", () => {
  const yukle = (yaml: string) => {
    const kok = geciciKok({ deneme: yaml });
    return akislariYukle(path.join(kok, "akislar"), kartlariYukle(path.join(kok, "ajanlar")));
  };
  const KESIF = "  - id: kesif\n    tur: kesif\n    ajan: mevcut-sistem-analisti\n    calisma_dizini: kod\n    salt_okunur: true\n    girdiler: [fikir]\n    cikti: kesif\n";

  it("hazır proje akışı yüklenir: keşifle başlar, baz çizgisi ajansızdır, yeni testler kırmızı beklenir", () => {
    const a = yukle("ad: x\nasamalar:\n  - id: brif\n    ajan: urun-sahibi\n    girdiler: [fikir]\n    cikti: brif\n").get("proje")!;
    expect(a.kaynak).toBe("proje");
    expect(a.asamalar[0]).toMatchObject({ id: "kesif", tur: "kesif", salt_okunur: true, kosul: null });
    expect(a.asamalar[1]).toMatchObject({ id: "baz-cizgisi", tur: "kontrol", ajan: null });
    expect(a.asamalar[1].dogrulama[0]).toMatchObject({ komut: "{test_komutu}", dizin: "proje", beklenen: "yesil" });
    const kiran = a.asamalar.find((x) => x.id === "kiran-test")!;
    expect(kiran.kosul).toEqual({ boyut: ["kucuk"] });
    expect(kiran.dogrulama[0]).toMatchObject({ beklenen: "kirmizi", dizin: "proje" });
    expect(a.asamalar.find((x) => x.id === "ux-tasarim")!.kosul).toEqual({ boyut: ["buyuk"], taraf: ["fe"] });
  });

  it("keşif, kontrol ve koşul yalnızca proje akışında; proje akışı keşifle başlar ve yazma alanı açık yazılır", () => {
    expect(() => yukle("ad: x\nasamalar:\n" + KESIF)).toThrow(/yalnızca 'kaynak: proje'/);
    expect(() => yukle("ad: x\nasamalar:\n  - id: brif\n    ajan: urun-sahibi\n    kosul: { boyut: [orta] }\n    girdiler: [fikir]\n    cikti: brif\n")).toThrow(/yalnızca 'kaynak: proje'/);
    expect(() => yukle("ad: x\nkaynak: proje\nasamalar:\n  - id: brif\n    ajan: urun-sahibi\n    girdiler: [fikir]\n    cikti: brif\n")).toThrow(/'tur: kesif' aşamasıyla başlamalı/);
    expect(() => yukle("ad: x\nkaynak: proje\nasamalar:\n" + KESIF.replace("    salt_okunur: true\n", ""))).toThrow(/salt_okunur olmalı/);
    expect(() => yukle("ad: x\nkaynak: proje\nasamalar:\n" + KESIF + "  - id: kod\n    ajan: be-yazilimci\n    calisma_dizini: kod\n    girdiler: [kesif]\n    cikti: not\n")).toThrow(/'yazabilir' zorunlu/);
    expect(() => yukle("ad: x\nkaynak: proje\nasamalar:\n" + KESIF + "  - id: b\n    ajan: analist\n    kosul: { boyut: [dev] }\n    girdiler: [kesif]\n    cikti: b\n")).toThrow(/kosul.boyut/);
    expect(() => yukle("ad: x\nkaynak: proje\nasamalar:\n" + KESIF + "  - id: t\n    ajan: test-otomasyon\n    calisma_dizini: kod\n    yazabilir: [proje/test]\n    girdiler: [kesif]\n    cikti: t\n    dogrulama:\n      - komut: npm test\n        beklenen: mavi\n"))
      .toThrow(/beklenen 'yesil' ya da 'kirmizi'/);
    expect(() => yukle("ad: x\nkaynak: proje\nasamalar:\n" + KESIF + "  - id: baz\n    tur: kontrol\n")).toThrow(/yalnızca 'komut' doğrulayıcıları/);
  });
});

// ------------------------------------ uçtan uca ------------------------------------
const ORNEK_PROJE = path.join(KOK, "ornekler", "proje-ornek");
const HATA = "100,00 TL 3 taksite bölününce taksitlerin toplamı 99,99 TL ediyor; kalan kuruş kayboluyor. Düzelt.";
const OZELLIK = "Kalan kuruş hatasını düzelt ve taksit özeti ekle: taksit sayısı, taksit tutarı, son taksit ve toplam.";
const projeKopyasi = () => {
  const p = path.join(gecici(), "taksit-hesap");
  fs.cpSync(ORNEK_PROJE, p, { recursive: true });
  return p;
};
const kart = (tur = "Hata düzeltme", boyut = "Küçük", komut: { secilenler: string[]; serbest?: string } = { secilenler: ["npm test"] }) =>
  [{ secilenler: [tur] }, { secilenler: [boyut] }, komut, { secilenler: ["Onayla"] }];
const kosanAsamalar = (k: TestKovani, fid: string) => [...new Set(k.depo.adimlar(fid).map((s) => s.asama_id).filter((x) => x !== "-"))];
const agacOzeti = (kok: string) => {
  const h = crypto.createHash("sha256");
  const gez = (d: string) => {
    for (const g of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      h.update(g.name);
      if (g.isDirectory()) gez(path.join(d, g.name)); else h.update(fs.readFileSync(path.join(d, g.name)));
    }
  };
  gez(kok);
  return h.digest("hex");
};

describe("Mevcut proje üzerinde iş: küçük yol", () => {
  it("keşif önerir, kartı sen onaylarsın; baz yeşil, test önce kırmızı, düzeltme yeşil; yama asıl projeye uygulanır", async () => {
    const proje = projeKopyasi();
    const ekler = gecici();
    yaz(ekler, "hata-bildirimi.md", "# Hata\nTutar: 100,00 TL, taksit: 3. Beklenen toplam 100,00; gerçekleşen 99,99.\n");
    const once = agacOzeti(proje);
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("Kalan kuruş", HATA, "proje", "deneme", { proje, kaynaklar: [path.join(ekler, "hata-bildirimi.md")] });

    // Öneri kartı: tür, boyut, test komutu, yazma alanı
    let f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.kaynak).toBe("kesif");
    expect(f.proje).toMatchObject({ yol: proje, test_komutu: "npm test" });
    const [tur, boyut, komut, alan] = f.bekleme!.sorular!;
    expect(tur.secenekler.map((o) => o.etiket)).toEqual(["Hata düzeltme (Önerilen)", "Yeni özellik", "Entegrasyon"]);
    expect(boyut.secenekler[0].etiket).toBe("Küçük (Önerilen)");
    expect(komut.secenekler[0].etiket).toBe("npm test (Önerilen)");
    expect(alan.soru).toContain("`proje/src`");
    expect(alan.soru).toContain("`proje/test/kovan`");
    // Keşif salt okunur çalıştı, atıfları denetlendi, projeyi ve eki gördü
    const kesif = dosya(k, fid, "belgeler/kesif.md");
    expect(kesif).toMatch(/proje\/src\/taksit\.mjs:\d+/);
    expect(kesif).toContain("kaynak/hata-bildirimi.md:1");
    const atif = k.depo.adimlar(fid).find((s) => s.ajan_ad === "Kod atıfları")!;
    expect(atif.durum).toBe("yesil");
    const kesifIstemi = istemi(k, fid, k.depo.adimlar(fid).find((s) => s.asama_id === "kesif" && s.tip === "uret")!.id);
    expect(kesifIstemi).toContain("## Mevcut proje");
    expect(kesifIstemi).toContain("### proje-envanteri");
    expect(kesifIstemi).toContain("BU AŞAMA SALT OKUNUR");
    expect(kesifIstemi).not.toContain("Bu iş bir replatform");
    expect(dosya(k, fid, "belgeler/kaynak-envanteri.md")).toContain("Bu iş için verilen ekler");
    // Kart onaylanmadan sonraki aşamalar görünür ama süzülmemiştir; keşif atlanamaz
    expect(k.ork.fikirDetayi(fid).is).toBeNull();
    expect(() => k.ork.kararVer(fid, "atla")).toThrow(/ajan sorusu/);

    expect(() => k.ork.cevapla(fid, [{ secilenler: [], serbest: "bilmem" }, { secilenler: ["Küçük"] }, { secilenler: ["npm test"] }, { secilenler: ["Onayla"] }])).toThrow(/"İş türü" için seçeneklerden birini seç/);
    k.ork.cevapla(fid, kart());
    f = await bekle(k, fid, bekliyor("insan"), 60_000);

    // Yalnızca küçük yolun aşamaları koştu
    expect(kosanAsamalar(k, fid)).toEqual(["kesif", "baz-cizgisi", "kiran-test", "duzeltme", "degisiklik-notu", "kabul"]);
    const d = k.ork.fikirDetayi(fid);
    expect(d.asamalar.map((a) => a.id)).toEqual(["kesif", "baz-cizgisi", "kiran-test", "duzeltme", "degisiklik-notu", "kabul"]);
    expect(d.is).toMatchObject({ tur: "hata", boyut: "kucuk", test_komutu: "npm test" });
    expect(d.asamalar.find((a) => a.id === "duzeltme")).toMatchObject({ ajan: "BCKD", yazabilir: ["proje/src"] });
    expect(d.asamalar.find((a) => a.id === "kiran-test")).toMatchObject({ yazabilir: ["proje/test/kovan"], kilitle: ["proje/test/kovan"] });
    // Baz çizgisi yeşil; yeni test koddan önce kırmızıydı ve bu geçme sayıldı; düzeltmeden sonra bütün testler yeşil
    const kontrol = (asama: string) => d.adimlar.filter((s) => s.asama_id === asama && s.tip === "kontrol");
    expect(kontrol("baz-cizgisi")[0]).toMatchObject({ ajan_ad: "Projenin testleri", durum: "yesil" });
    expect(kontrol("kiran-test")[0]).toMatchObject({ ajan_ad: "Önce kırmızı", durum: "yesil" });
    expect(kontrol("kiran-test")[0].ozet).toMatch(/^Beklendiği gibi kırmızı/);
    expect(kontrol("duzeltme")[0]).toMatchObject({ ajan_ad: "Bütün testler", durum: "yesil" });
    // Onay kurulu test çıktısını görür: doğru sebeple mi kırmızı
    const inceleme = d.adimlar.find((s) => s.asama_id === "kiran-test" && s.tip === "inceleme")!;
    expect(istemi(k, fid, inceleme.id)).toContain("### Test çıktısı (kod yazılmadan önce; kırmızı olması bekleniyor)");
    // Yazılımcı işin türünü, proje kurallarını ve test komutunu görür; kararlar deftere girdi
    const duzeltme = istemi(k, fid, d.adimlar.find((s) => s.asama_id === "duzeltme" && s.tip === "uret")!.id);
    expect(duzeltme).toContain("İş: Hata düzeltme (küçük). Bu bir hata düzeltmesi");
    expect(duzeltme).toContain("YAZMA ALANIN");
    expect(duzeltme).toContain("`proje/src/`");
    expect(duzeltme).toContain("KİLİTLİ");
    expect(duzeltme).toContain("npm --prefix proje");
    expect(duzeltme).toContain("### Test komutu");
    expect(duzeltme).not.toContain("(bu belge henüz yok)");
    expect(d.kararlar.map((x) => `${x.baslik}: ${x.cevap}`)).toEqual(["İş türü: Hata düzeltme", "Boyut: Küçük", "Test komutu: npm test", "Yazma alanı: Onayla"]);
    // Yeni testler kilitli
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toEqual(["kaynak", "proje/test/kovan"]);

    // Yama: asıl klasöre dokunulmadı; yama asıl projeye uygulanınca testler yeşil
    expect(agacOzeti(proje)).toBe(once);
    expect(d.yama!.dosyalar).toEqual([{ yol: "src/taksit.mjs", durum: "degisti", ayri: false }, { yol: "test/kovan/kalan-kurus.test.mjs", durum: "eklendi", ayri: false }]);
    expect(d.dosyalar.cikti.map((x) => x.yol)).toEqual(["cikti/degisiklik-notu.md", "cikti/degisiklik.patch", "cikti/OKU.md"].sort((a, b) => a.localeCompare(b)));
    expect(d.dosyalar.proje.some((x) => x.yol === "kod/proje/src/taksit.mjs")).toBe(true);
    expect(d.dosyalar.kod.some((x) => x.yol.startsWith("kod/proje/"))).toBe(false);
    expect(f.bekleme!.detay).toContain("Yama (cikti/degisiklik.patch): src/taksit.mjs (değişti)");
    expect(f.bekleme!.varsayilan_hedef).toBe("duzeltme");
    const yama = dosya(k, fid, "cikti/degisiklik.patch");
    expect(yama).toContain("+  const kalan = toplamKurus - taksit * adet;");
    expect(yama).not.toContain("kaynak/");
    if (gitVar) {
      execFileSync("git", ["apply", path.join(k.calisma, fid, "cikti", "degisiklik.patch")], { cwd: proje });
      execFileSync("node", ["--test"], { cwd: proje, stdio: "pipe" });   // kırmızıysa fırlatır
      expect(fs.readFileSync(path.join(proje, "src/taksit.mjs"), "utf8")).toBe(dosya(k, fid, "kod/proje/src/taksit.mjs"));
    }

    k.ork.kararVer(fid, "kabul");
    f = await bekle(k, fid, (x) => x.durum === "tamamlandi");
    expect(varMi(k, fid, "cikti/degisiklik.patch")).toBe(true);
    await expect(k.ork.yeniSurum(fid, "bir şey daha")).rejects.toThrow(/Mevcut proje işinde yeni sürüm yok/);
  });

  it("kod yazıldıktan sonra teste geri dönülürse kırmızı beklenmez; düzeltme yeniden doğrulanır ve yama yenilenir", async () => {
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("", HATA, "proje", "deneme", { proje: projeKopyasi() });
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.ork.cevapla(fid, kart());
    let f = await bekle(k, fid, bekliyor("insan"), 60_000);
    const ilkKabul = f.bekleme!.adim_id;
    expect(f.bekleme!.geri_hedefler!.map((h) => h.id)).toEqual(["kesif", "kiran-test", "duzeltme", "degisiklik-notu"]);
    k.ork.kararVer(fid, "geri_gonder", "Test 7 taksitli bir örneği de sınasın", "kiran-test");
    f = await bekle(k, fid, (x) => x.durum === "bekliyor" && x.bekleme?.adim_id !== ilkKabul, 60_000);
    expect(f.bekleme!.sebep).toBe("insan");
    const adimlar = k.depo.adimlar(fid);
    const kiran = adimlar.filter((s) => s.asama_id === "kiran-test");
    expect(kiran.filter((s) => s.tip === "kontrol")).toHaveLength(1);                     // ikinci kez kırmızı beklenmedi
    expect(kiran.some((s) => s.ajan_ad === "Önce kırmızı" && s.durum === "atlandi-denetim")).toBe(true);
    expect(adimlar.filter((s) => s.asama_id === "duzeltme" && s.tip === "kontrol").map((s) => s.durum)).toEqual(["yesil", "yesil"]);
    expect(adimlar.filter((s) => s.asama_id === "duzeltme" && s.tip === "uret")).toHaveLength(1);   // kod yeniden yazılmadı, yeniden doğrulandı
    expect(adimlar.filter((s) => s.ajan_ad === "Yama")).toHaveLength(2);
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toEqual(["proje/test/kovan"]);
  });

  it("yazma alanı dışındaki proje dosyası ve kilitli test geri alınır; yamaya girmez", async () => {
    process.env.KOVAN_DENEME_IHLAL = "1";
    try {
      const proje = projeKopyasi();
      const k = await kovanOlustur();
      const fid = await k.ork.yeniFikir("", HATA, "proje", "deneme", { proje });
      await bekle(k, fid, bekliyor("ajan_sorusu"));
      k.ork.cevapla(fid, kart());
      await bekle(k, fid, bekliyor("insan"), 60_000);
      const d = k.ork.fikirDetayi(fid);
      const ihlal = d.adimlar.filter((s) => s.ajan_ad === "Sınır ihlali");
      expect(ihlal).toHaveLength(1);
      expect(ihlal[0].ozet).toContain("proje/README.md (alan dışı)");
      expect(ihlal[0].ozet).toContain("proje/test/kovan/kalan-kurus.test.mjs (kilitli)");
      expect(dosya(k, fid, "kod/proje/README.md")).not.toContain("alan dışı değişiklik");
      expect(dosya(k, fid, "kod/proje/test/kovan/kalan-kurus.test.mjs")).not.toContain("testi gevşettim");
      expect(d.yama!.dosyalar.map((x) => x.yol)).toEqual(["src/taksit.mjs", "test/kovan/kalan-kurus.test.mjs"]);
    } finally {
      delete process.env.KOVAN_DENEME_IHLAL;
    }
  });

  it("yazma alanı onaylanmazsa keşif notunla yeniden çalışır; test komutunu kendin yazabilirsin", async () => {
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("", HATA, "proje", "deneme", { proje: projeKopyasi() });
    let f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    const ilkAdim = f.bekleme!.adim_id;
    k.ork.cevapla(fid, [{ secilenler: ["Hata düzeltme"] }, { secilenler: ["Küçük"] }, { secilenler: ["npm test"] }, { secilenler: [], serbest: "Yalnızca taksit.mjs değişsin" }]);
    f = await bekle(k, fid, (x) => x.durum === "bekliyor" && x.bekleme?.sebep === "ajan_sorusu" && x.bekleme.adim_id !== ilkAdim);
    expect(varMi(k, fid, ".kovan/is.json")).toBe(false);
    const turlar = k.depo.adimlar(fid).filter((s) => s.asama_id === "kesif" && s.tip === "uret");
    expect(turlar).toHaveLength(2);
    expect(istemi(k, fid, turlar[1].id)).toContain("### İnsanın notu (iş önerisi)\nYalnızca taksit.mjs değişsin");

    expect(() => k.ork.cevapla(fid, kart("Hata düzeltme", "Küçük", { secilenler: [], serbest: "node --test\nrm -rf x" }))).toThrow(/tek satır/);
    k.ork.cevapla(fid, kart("Hata düzeltme", "Küçük", { secilenler: [], serbest: "node --test" }));
    await bekle(k, fid, bekliyor("insan"), 60_000);
    expect(k.ork.fikirDetayi(fid).is!.test_komutu).toBe("node --test");
    expect(k.ork.fikirDetayi(fid).adimlar.find((s) => s.asama_id === "baz-cizgisi" && s.tip === "kontrol")!.durum).toBe("yesil");
  });

  it("uydurma yazma yolu ve eksik iş önerisi onay kuruluna gitmeden keşfe geri döner", async () => {
    let n = 0;
    const betik = new BetikMotor("deneme", (c) => {
      if (c.asama_id !== "kesif" || c.gorev_turu !== "uret") return null;
      n++;
      if (n === 1) return { metin: "# Keşif\nİş burada (proje/src/taksit.mjs:1)." };
      if (n === 2) return { metin: "# Keşif\nİş burada (proje/src/taksit.mjs:1).\n\n```kovan-is\ntur: hata\nboyut: kucuk\ngerekce: x\ntaraflar:\n  be:\n    yazma_alani: [proje/yok/klasor/hesap.mjs]\n    test_alani: proje/test/kovan\n```" };
      return null;
    });
    const k = await kovanOlustur({ motorlar: new Map<string, Motor>([["deneme", betik], ["claude", new SahteMotor("claude")], ["qwen-yerel", new SahteMotor("qwen-yerel", true)]]) });
    const fid = await k.ork.yeniFikir("", HATA, "proje", "deneme", { proje: projeKopyasi() });
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    const adimlar = k.depo.adimlar(fid);
    const oneri = adimlar.filter((s) => s.ajan_ad === "İş önerisi");
    expect(oneri.map((s) => s.durum)).toEqual(["kirmizi", "kirmizi", "yesil"]);
    expect(oneri[0].ozet).toContain("kovan-is bloğu yok");
    expect(oneri[1].ozet).toContain("`proje/yok/klasor/hesap.mjs` projede yok");
    expect(adimlar.filter((s) => s.asama_id === "kesif" && s.tip === "inceleme" && s.tur < 3)).toHaveLength(0);
  });

  it("baz çizgisi kırmızıysa iş başlamaz; komut değişince sürer. Yeni test yeşilse 'önce kırmızı' bulgu döndürür", async () => {
    const proje = projeKopyasi();
    yaz(proje, "test/bozuk.test.mjs", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("zaten kırık", () => assert.equal(1, 2));\n');
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("", HATA, "proje", "deneme", { proje });
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.ork.cevapla(fid, kart());
    let f = await bekle(k, fid, bekliyor("hata"), 60_000);
    expect(f.bekleme!.asama_id).toBe("baz-cizgisi");
    expect(f.bekleme!.mesaj).toContain("işe başlamadan kırmızı (`npm test`)");
    expect(f.bekleme!.secenekler.map((s) => s.anahtar)).toEqual(["komut_degistir", "tekrar_dene", "durdur"]);
    expect(f.bekleme!.detay).toContain("zaten kırık");
    expect(kosanAsamalar(k, fid)).toEqual(["kesif", "baz-cizgisi"]);
    expect(() => k.ork.kararVer(fid, "komut_degistir")).toThrow(/Yeni test komutunu not olarak yaz/);

    // Daraltılmış komut yalnızca eski test dosyasını koşar: baz yeşil olur, ama yeni test bu komutla hiç koşmaz
    k.ork.kararVer(fid, "komut_degistir", "node --test test/taksit.test.mjs");
    f = await bekle(k, fid, bekliyor("tur_siniri"), 60_000);
    expect(k.ork.fikirDetayi(fid).is!.test_komutu).toBe("node --test test/taksit.test.mjs");
    expect(f.bekleme!.asama_id).toBe("kiran-test");
    expect(f.bekleme!.detay).toContain("Önce kırmızı: YEŞİL (kırmızı bekleniyordu)");
    expect(f.bekleme!.detay).toContain("yeni test isteneni (ya da hatayı) yakalamıyor");
    const kirmizi = k.depo.adimlar(fid).filter((s) => s.asama_id === "kiran-test" && s.tip === "kontrol");
    expect(kirmizi.every((s) => s.durum === "kirmizi" && s.ozet.startsWith("Yeşil; kırmızı bekleniyordu"))).toBe(true);
    expect(k.depo.adimlar(fid).some((s) => s.asama_id === "kiran-test" && s.tip === "inceleme")).toBe(false);   // onay kurulu harcanmadı
  });
});

describe("Mevcut proje üzerinde iş: orta ve büyük yol", () => {
  it("orta: fark analizi, teslim planı ve kalemler; her kalemin testi kendi klasöründe önce kırmızı, sonra kilitli", async () => {
    const proje = projeKopyasi();
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("Taksit özeti", OZELLIK, "proje", "deneme", { proje });
    let f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.sorular![0].secenekler[1].etiket).toBe("Yeni özellik (Önerilen)");
    expect(f.bekleme!.sorular![1].secenekler[1].etiket).toBe("Orta (Önerilen)");
    k.ork.cevapla(fid, kart("Yeni özellik", "Orta"));
    f = await bekle(k, fid, bekliyor("insan"), 90_000);

    expect(kosanAsamalar(k, fid)).toEqual(["kesif", "baz-cizgisi", "fark-analizi", "teslim-plani", "kalemler",
      "p1-kabul-testi", "p1-is-kalemi", "p2-kabul-testi", "p2-is-kalemi", "birlestirme", "degisiklik-notu", "kabul"]);
    const d = k.ork.fikirDetayi(fid);
    expect(d.plan!.map((p) => `${p.id} ${p.durum}`)).toEqual(["P1 tamam", "P2 tamam"]);
    expect(d.asamalar.find((a) => a.id === "p2-kabul-testi")).toMatchObject({ yazabilir: ["proje/test/kovan/p2"], kilitle: ["proje/test/kovan/p2"] });
    expect(d.asamalar.find((a) => a.id === "p2-is-kalemi")).toMatchObject({ ajan: "BCKD", yazabilir: ["proje/src"] });
    for (const kalem of ["p1", "p2"]) {
      const kirmizi = d.adimlar.find((s) => s.asama_id === `${kalem}-kabul-testi` && s.tip === "kontrol")!;
      expect(kirmizi.ozet).toMatch(/^Beklendiği gibi kırmızı/);
      expect(d.adimlar.find((s) => s.asama_id === `${kalem}-is-kalemi` && s.tip === "kontrol")!.durum).toBe("yesil");
    }
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toEqual(["proje/test/kovan/entegrasyon", "proje/test/kovan/p1", "proje/test/kovan/p2"]);
    expect(d.yama!.dosyalar.map((x) => `${x.yol} ${x.durum}`)).toEqual(["src/ozet.mjs eklendi", "src/taksit.mjs degisti",
      "test/kovan/entegrasyon/akis.test.mjs eklendi", "test/kovan/p1/kalan-kurus.test.mjs eklendi", "test/kovan/p2/ozet.test.mjs eklendi"]);
    // Değişiklik notu küçük yolun belgelerini beklemez; fark analizini ve kalemleri görür
    const not = istemi(k, fid, d.adimlar.find((s) => s.asama_id === "degisiklik-notu" && s.tip === "uret")!.id);
    expect(not).toContain("### analiz");
    expect(not).toContain("### kalemler");
    expect(not).not.toContain("### kiran-test");
    expect(not).not.toContain("### teknik-plan");
    expect(f.bekleme!.varsayilan_hedef).toBe("p2-is-kalemi");
    if (gitVar) {
      execFileSync("git", ["apply", path.join(k.calisma, fid, "cikti", "degisiklik.patch")], { cwd: proje });
      execFileSync("node", ["--test"], { cwd: proje, stdio: "pipe" });
    }
  });

  it("büyük: teknik plan ve ADR eklenir; arayüz tarafı yoksa UX koşmaz. Keşfe geri gönderilirse kart yeniden onaylanır", async () => {
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("", OZELLIK, "proje", "deneme", { proje: projeKopyasi() });
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.ork.cevapla(fid, kart("Entegrasyon", "Büyük"));
    expect(k.ork.fikirDetayi(fid).asamalar.map((a) => a.id)).toEqual(["kesif", "baz-cizgisi", "fark-analizi", "teknik-plan", "teslim-plani", "kalemler", "birlestirme", "degisiklik-notu", "kabul"]);
    let f = await bekle(k, fid, bekliyor("insan"), 90_000);
    expect(kosanAsamalar(k, fid)).toContain("teknik-plan");
    expect(kosanAsamalar(k, fid)).not.toContain("ux-tasarim");
    expect(k.ork.fikirDetayi(fid).adrler.length).toBeGreaterThan(0);
    const plan = istemi(k, fid, k.depo.adimlar(fid).find((s) => s.asama_id === "teknik-plan" && s.tip === "uret")!.id);
    expect(plan).toContain("İş: Entegrasyon (büyük). Bu bir entegrasyon");
    expect(plan).toContain("Gerçek ağa çıkma");
    // ADR'ler projenin dışında (kod/adr); yamaya girmez
    expect(k.ork.fikirDetayi(fid).yama!.dosyalar.some((x) => x.yol.includes("adr"))).toBe(false);

    // Kabulden keşfe geri gönder: eski kart ve plan düşer, yeni kart gelir
    expect(f.bekleme!.geri_hedefler!.map((h) => h.id)).toContain("kesif");
    k.ork.kararVer(fid, "geri_gonder", "İşi küçült: yalnızca hata düzeltilsin", "kesif");
    f = await bekle(k, fid, bekliyor("ajan_sorusu"), 60_000);
    expect(f.bekleme!.kaynak).toBe("kesif");
    expect(varMi(k, fid, ".kovan/is.json")).toBe(false);
    expect(varMi(k, fid, ".kovan/plan.json")).toBe(false);
  });
});

describe("Mevcut proje üzerinde iş: başlangıç ve API", () => {
  it("proje akışı proje yolu ister; diğer akışlar proje yolu almaz; yanlış yol geride fikir bırakmaz", async () => {
    const k = await kovanOlustur();
    await expect(k.ork.yeniFikir("", HATA, "proje", "deneme")).rejects.toThrow(/projenin klasörüyle başlar/);
    await expect(k.ork.yeniFikir("", HATA, "mini", "deneme", { proje: projeKopyasi() })).rejects.toThrow(/proje yolu almaz/);
    await expect(k.ork.yeniFikir("", HATA, "proje", "deneme", { proje: path.join(gecici(), "yok") })).rejects.toThrow(/Proje klasörü bulunamadı/);
    expect(k.ork.fikirListesi()).toHaveLength(0);
    expect(fs.existsSync(k.calisma) ? fs.readdirSync(k.calisma).filter((x) => x.startsWith("F-")) : []).toHaveLength(0);
  });

  it("API: fikir proje yoluyla başlar; akış listesi koşulları, detay iş önerisini ve yamayı verir", async () => {
    const k = await kovanOlustur();
    const HOST = { host: "127.0.0.1:8765" };
    const akislar = (await k.app.inject({ url: "/api/akislar", headers: HOST })).json() as { id: string; kaynak: string; asamalar: { id: string; kosul: unknown; dogrulama: { beklenen: string }[] }[] }[];
    expect(akislar.map((a) => a.id).slice(-2)).toEqual(["proje", "replatform"]);
    const proje = akislar.find((a) => a.id === "proje")!;
    expect(proje.kaynak).toBe("proje");
    expect(proje.asamalar.find((a) => a.id === "kiran-test")).toMatchObject({ kosul: { boyut: ["kucuk"] } });
    expect(proje.asamalar.find((a) => a.id === "kiran-test")!.dogrulama[0].beklenen).toBe("kirmizi");
    expect(((await k.app.inject({ url: "/api/durum", headers: HOST })).json() as { ornek_proje: string | null }).ornek_proje).toBeNull();

    const eksik = await k.app.inject({ method: "POST", url: "/api/fikirler", headers: HOST, payload: { metin: HATA, profil: "proje", motor: "deneme" } });
    expect(eksik.statusCode).toBe(400);
    expect(eksik.json().hata ?? eksik.json().message ?? JSON.stringify(eksik.json())).toMatch(/projenin klasörüyle başlar/);
    const r = await k.app.inject({ method: "POST", url: "/api/fikirler", headers: HOST, payload: { metin: HATA, profil: "proje", motor: "deneme", proje: projeKopyasi() } });
    expect(r.statusCode).toBe(200);
    const fid = (r.json() as { id: string }).id;
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    const c = await k.app.inject({ method: "POST", url: `/api/fikirler/${fid}/cevap`, headers: HOST, payload: { cevaplar: kart() } });
    expect(c.statusCode).toBe(200);
    await bekle(k, fid, bekliyor("insan"), 60_000);
    const d = (await k.app.inject({ url: `/api/fikirler/${fid}`, headers: HOST })).json() as { is: { boyut: string }; yama: { dosya: string }; dosyalar: { cikti: { yol: string }[] } };
    expect(d.is.boyut).toBe("kucuk");
    expect(d.yama.dosya).toBe("cikti/degisiklik.patch");
    const yama = await k.app.inject({ url: `/api/fikirler/${fid}/dosya?yol=cikti/degisiklik.patch`, headers: HOST });
    expect((yama.json() as { icerik: string }).icerik).toContain("diff --git a/src/taksit.mjs b/src/taksit.mjs");
  });
});
