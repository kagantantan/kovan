// Replatform: mevcut sistemin kaynaklarını içe alma (kopya, atlananlar, Word, kodlama, zip, sınırlar),
// kod atıfları denetimi, salt okunur aşama, uçtan uca replatform akışı, hedef yığın ve "Hepsi yerel" modu.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { atiflariDenetle, envanterBelgesi, kaynakIceAl } from "../src/kaynak.js";
import { DenemeMotoru, type Motor } from "../src/motor.js";
import { BetikMotor, KOK, SahteMotor, bekle, bekliyor, dosya, geciciKok, istemi, kovanOlustur, ORNEK_MINI, varMi } from "./yardimci/ortam.js";

const ORNEK = path.join(KOK, "ornekler", "reeskont-eski");
const PKB = "kaynak/reeskont-eski/KART_REESKONT_GUNSONU.pkb";
const FIKIR = "Kredi kartı gün sonunda kartın reeskont bakiyesini hesaplayan işi temiz bir mimariyle yeniden yaz; kod benim sistemime entegre edilecek.";
const gecici = () => fs.mkdtempSync(path.join(os.tmpdir(), "kovan-kaynak-test-"));
const yaz = (kok: string, rel: string, icerik: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(kok, rel)), { recursive: true });
  fs.writeFileSync(path.join(kok, rel), icerik);
};
const ozet = (yol: string) => crypto.createHash("sha256").update(fs.readFileSync(yol)).digest("hex");
const motorlar = (deneme: Motor = new DenemeMotoru(0), claude = new SahteMotor("claude"), yerel: Motor | null = new SahteMotor("qwen-yerel", true)) =>
  new Map<string, Motor>([["deneme", deneme], ["claude", claude], ...(yerel ? [["qwen-yerel", yerel] as [string, Motor]] : [])]);

describe("Kaynak içe alma", () => {
  it("klasörü kopyalar; sürüm kontrolü, bağımlılık ve ikili dosyaları almaz; Word'ü satır satır HTML'e çevirir", async () => {
    const kaynak = path.join(gecici(), "gunsonu");
    yaz(kaynak, "paket/GUNSONU.pkb", "BEGIN\n  NULL;\nEND;\n");
    yaz(kaynak, ".git/config", "[core]\n");
    yaz(kaynak, "node_modules/x/index.js", "module.exports = 1;\n");
    yaz(kaynak, "target/App.class", Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    yaz(kaynak, "lib/eski.jar", "PK");
    yaz(kaynak, "eski-analiz.doc", "eski word");
    fs.copyFileSync(path.join(ORNEK, "analiz.docx"), path.join(kaynak, "analiz.docx"));
    const hedef = path.join(gecici(), "kaynak");

    const o = await kaynakIceAl([kaynak], hedef);
    expect(o.dosyalar.map((d) => d.yol)).toEqual([
      "kaynak/gunsonu/analiz.docx", "kaynak/gunsonu/analiz.docx.html", "kaynak/gunsonu/eski-analiz.doc", "kaynak/gunsonu/paket/GUNSONU.pkb",
    ]);
    expect(o.dosyalar.find((d) => d.yol.endsWith(".pkb"))).toMatchObject({ tur: "PL/SQL", satir: 3 });
    expect(o.atlanan.map((a) => a.yol)).toEqual([
      "kaynak/gunsonu/.git/", "kaynak/gunsonu/lib/eski.jar", "kaynak/gunsonu/node_modules/", "kaynak/gunsonu/target/", "kaynak/gunsonu/eski-analiz.doc",
    ]);
    expect(o.atlanan.at(-1)!.neden).toMatch(/eski Office biçimi/);
    expect(fs.existsSync(path.join(hedef, "gunsonu", ".git"))).toBe(false);

    // Word tablosu korunur, her blok ayrı satırda: belgeye de satır atfı verilebilir
    const html = fs.readFileSync(path.join(hedef, "gunsonu", "analiz.docx.html"), "utf8").split("\n");
    const satir = html.findIndex((s) => s.includes("Gün esası") && s.includes("<td>")) + 1;
    expect(html[satir - 1]).toContain("360");
    expect(atiflariDenetle(`Doküman: kaynak/gunsonu/analiz.docx.html:${satir}`, path.dirname(hedef))).toEqual({ gecerli: 1, hatalar: [] });

    const envanter = envanterBelgesi(o);
    expect(envanter).toContain("| PL/SQL | 1 | 3 |");
    expect(envanter).toContain("- kaynak/gunsonu/analiz.docx → kaynak/gunsonu/analiz.docx.html");
    expect(envanter).toContain("## Alınmayanlar");
  });

  it("Türkçe Windows-1254 ve UTF-16 dosyaları UTF-8'e çevirir; satırlar ve atıflar aynı kalır", async () => {
    const kaynak = path.join(gecici(), "eski");
    // "-- Müşteri ödemesi" Windows-1254 ile: ü=FC ş=FE ö=F6
    yaz(kaynak, "odeme.pkb", Buffer.concat([Buffer.from("-- M"), Buffer.from([0xfc, 0xfe]), Buffer.from("teri "), Buffer.from([0xf6]),
      Buffer.from("demesi\nBEGIN\n  NULL;\nEND;\n")]));
    yaz(kaynak, "rapor.sql", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("SELECT 'ğ' FROM dual;\nSELECT 2 FROM dual;\n", "utf16le")]));
    yaz(kaynak, "zaten.sql", "SELECT 'ç' FROM dual;\n");
    const hedef = path.join(gecici(), "kaynak");

    const o = await kaynakIceAl([kaynak], hedef);
    expect(o.kodlama).toEqual([{ yol: "kaynak/eski/odeme.pkb", kodlama: "windows-1254" }, { yol: "kaynak/eski/rapor.sql", kodlama: "utf-16le" }]);
    expect(fs.readFileSync(path.join(hedef, "eski", "odeme.pkb"), "utf8").split("\n")[0]).toBe("-- Müşteri ödemesi");
    expect(fs.readFileSync(path.join(hedef, "eski", "rapor.sql"), "utf8")).toBe("SELECT 'ğ' FROM dual;\nSELECT 2 FROM dual;\n");
    expect(o.dosyalar.map((d) => [d.yol, d.satir])).toEqual([["kaynak/eski/odeme.pkb", 4], ["kaynak/eski/rapor.sql", 2], ["kaynak/eski/zaten.sql", 1]]);
    expect(atiflariDenetle("kaynak/eski/rapor.sql:2", path.dirname(hedef)).gecerli).toBe(1);
    expect(envanterBelgesi(o)).toContain("- kaynak/eski/odeme.pkb (windows-1254)");
  });

  it("tek dosya ve zip alır; yanlış yolda, boş kaynakta ve kendini içeren kaynakta hiçbir şey bırakmadan hata verir", async () => {
    const kok = gecici();
    yaz(kok, "tek/GUNSONU.pkb", "BEGIN\n  NULL;\nEND;\n");
    yaz(kok, "arsiv/paket/A.sql", "SELECT 1 FROM dual;\n");
    execFileSync("zip", ["-qr", path.join(kok, "eski-sistem.zip"), "."], { cwd: path.join(kok, "arsiv") });

    const hedef = path.join(gecici(), "kaynak");
    const o = await kaynakIceAl([path.join(kok, "tek", "GUNSONU.pkb"), path.join(kok, "eski-sistem.zip")], hedef);
    expect(o.dosyalar.map((d) => d.yol)).toEqual(["kaynak/eski-sistem/paket/A.sql", "kaynak/GUNSONU.pkb"]);

    await expect(kaynakIceAl([], path.join(gecici(), "k"))).rejects.toThrow(/kaynak klasörünü ya da dosyasını yaz/);
    await expect(kaynakIceAl([path.join(kok, "yok")], path.join(gecici(), "k"))).rejects.toThrow(/Kaynak bulunamadı/);
    const yalnizBagimlilik = path.join(gecici(), "bos");
    yaz(yalnizBagimlilik, "node_modules/x.js", "1");
    const h2 = path.join(gecici(), "kaynak");
    await expect(kaynakIceAl([yalnizBagimlilik], h2)).rejects.toThrow(/okunabilir dosya bulunamadı/);
    expect(fs.existsSync(h2)).toBe(false);
    // Kovan kökünü kaynak vermek kendi çalışma klasörünü kopyalamaya çalışmak olurdu
    const kovanKoku = gecici();
    fs.mkdirSync(path.join(kovanKoku, "calisma", "F-001", "kod"), { recursive: true });
    await expect(kaynakIceAl([kovanKoku], path.join(kovanKoku, "calisma", "F-001", "kod", "kaynak"))).rejects.toThrow(/çalışma klasörünü içeriyor/);
  });
});

describe("Kod atıfları denetimi", () => {
  it("her atfın gerçek bir dosya ve satıra gitmesini ister; atıfsız belgeyi geri çevirir", () => {
    const kod = gecici();
    yaz(kod, "kaynak/a/x.pkb", Array.from({ length: 10 }, (_, i) => `-- satır ${i + 1}`).join("\n") + "\n");
    expect(atiflariDenetle("E1: kaynak/a/x.pkb:3 ve `kaynak/a/x.pkb:5-7` (kaynak/a/x.pkb:3)", kod)).toEqual({ gecerli: 2, hatalar: [] });
    const r = atiflariDenetle("kaynak/a/y.pkb:1, kaynak/a/x.pkb:11, kaynak/a/x.pkb:7-5, kaynak/../gizli.txt:1, kaynak/a/x.pkb:2", kod);
    expect(r.gecerli).toBe(1);
    expect(r.hatalar).toEqual([
      "kaynak/a/y.pkb:1: böyle bir dosya yok", "kaynak/a/x.pkb:11: dosya 10 satır; bu satırlar yok",
      "kaynak/a/x.pkb:7-5: dosya 10 satır; bu satırlar yok", "kaynak/../gizli.txt:1: böyle bir dosya yok",
    ]);
    expect(atiflariDenetle("Bu sistem faiz hesaplıyor.", kod).hatalar[0]).toMatch(/hiç kod atfı yok/);
  });
});

describe("Replatform akışı", () => {
  it("önce eski sistem koda atıflarla anlaşılır, doküman-kod farkı sana sorulur; yeni kod kalem kalem yazılır ve eski çıktıyla karşılaştırılır", async () => {
    const k = await kovanOlustur();
    await expect(k.ork.yeniFikir("", FIKIR, "replatform", "deneme")).rejects.toThrow(/mevcut sistemin kaynaklarıyla başlar/);
    await expect(k.ork.yeniFikir("", FIKIR, "replatform", "deneme", { kaynaklar: ["/yok/boyle/bir/klasor"] })).rejects.toThrow(/Kaynak bulunamadı/);
    expect(fs.existsSync(k.calisma) ? fs.readdirSync(k.calisma).filter((x) => x.startsWith("F-")) : []).toEqual([]);   // yarım fikir kalmaz
    await expect(k.ork.yeniFikir("", FIKIR, "replatform", "deneme", { kaynaklar: [ORNEK], hedef_yigin: "Go" })).rejects.toThrow(/birkaç kelimeyle/);

    const fid = await k.ork.yeniFikir("Kart reeskont gün sonu", FIKIR, "replatform", "deneme", { kaynaklar: [ORNEK], hedef_yigin: "node-ts" });
    let f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    let d = k.ork.fikirDetayi(fid);

    // Kaynak kopyalandı, kilitlendi; kod listesinde değil, kendi sekmesinde
    expect(d.adimlar[0]).toMatchObject({ tip: "sistem", ajan_ad: "Kaynak", durum: "kilit" });
    expect(d.adimlar[0].ozet).toMatch(/^Mevcut sistem alındı ve kilitlendi: 5 dosya, .* 1 Word belgesi HTML'e çevrildi/);
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toEqual(["kaynak"]);
    expect(d.dosyalar.kaynak.map((x) => x.yol)).toContain(`kod/${PKB}`);
    expect(d.dosyalar.kaynak.map((x) => x.yol)).toContain("kod/kaynak/reeskont-eski/analiz.docx.html");
    expect(d.dosyalar.kod.filter((x) => x.yol.includes("kaynak/"))).toEqual([]);
    expect(dosya(k, fid, "belgeler/kaynak-envanteri.md")).toContain(`| ${PKB} | PL/SQL | 48 |`);
    expect(d.fikir.kaynak).toMatchObject({ dosya_sayisi: 5, donusturulen: 1 });
    expect(d.kararlar[0]).toMatchObject({ baslik: "Hedef yığın", soran: "Kovan", karar_veren: "insan" });
    expect(d.kararlar[0].cevap).toMatch(/^Node\.js \+ TypeScript/);

    // Mevcut sistem: salt okunur aşama, atıflar sistemce doğrulandı, üç onaycı
    const ms = d.adimlar.filter((a) => a.asama_id === "mevcut-sistem");
    expect(ms.map((a) => `${a.tip}:${a.durum}:${a.ajan_ad}`)).toEqual([
      "uret:tamam:Mevcut Sistem Analisti", "kontrol:yesil:Kaynak atıfları", "inceleme:onay:İş Analisti", "inceleme:onay:Ana Mimar", "inceleme:onay:Test Analisti",
    ]);
    expect(ms[1].ozet).toMatch(/atıf, hepsi gerçek dosya ve satırlara gidiyor/);
    expect(d.asamalar[0].onaylar.map((o) => `${o.kisa}:${o.durum}`)).toEqual(["ATIF:yesil", "ANLZ:onay", "TKM:onay", "KTST:onay"]);
    const msIstem = istemi(k, fid, ms[0].id);
    expect(msIstem).toContain("## Mevcut sistem\nBu iş bir replatform");
    expect(msIstem).toContain("`kaynak/` altında (5 dosya): salt okunur ve kilitli");
    expect(msIstem).toContain("BU AŞAMA SALT OKUNUR");
    const analiz = dosya(k, fid, "belgeler/mevcut-sistem.md");
    expect(analiz).toContain(`FARK: Gün esası: doküman 360 diyor, kod 365 kullanıyor. ${PKB}:5`);
    expect(analiz).toContain(`E2: Sıfır ya da alacaklı bakiyeye faiz işlemez. ${PKB}:10-12`);

    // Brif soru sormadı (arayüz yok); doküman-kod farkını analist sordu, ekip bölündü
    expect(d.adimlar.filter((a) => a.asama_id === "brif").map((a) => `${a.tip}:${a.durum}`)).toEqual(["uret:tamam"]);
    expect(f.bekleme!.asama_id).toBe("hedef-analiz");
    const soru = f.bekleme!.sorular![0];
    expect([soru.baslik, soru.soran]).toEqual(["Gün esası", "analist"]);
    expect(soru.oylar!.map((o) => `${o.kisa}:${o.secim.join("+")}`)).toEqual(["ANLZ:Koddaki gibi 365", "PO:Koddaki gibi 365", "TKM:Dokümandaki gibi 360"]);

    k.ork.cevapla(fid, [{ secilenler: ["Koddaki gibi 365"] }]);
    f = await bekle(k, fid, bekliyor("insan"));
    expect(f.bekleme!.asama_id).toBe("kabul");
    d = k.ork.fikirDetayi(fid);
    expect(d.kararlar.map((x) => `${x.baslik}=${x.cevap}:${x.karar_veren}`)).toEqual([expect.stringMatching(/^Hedef yığın=/), "Gün esası=Koddaki gibi 365:insan"]);

    // Eşdeğerlik onaycısı (MSA) hedef analizde açık kalan şüpheyi bir kez geri gönderdi
    const ha = d.adimlar.filter((a) => a.asama_id === "hedef-analiz" && a.ajan === "mevcut-sistem-analisti");
    expect(ha.map((a) => `${a.tur}:${a.durum}`)).toEqual(["1:duzelt", "2:onay"]);
    expect(istemi(k, fid, d.adimlar.find((a) => a.asama_id === "hedef-analiz" && a.tip === "uret" && a.tur === 2)!.id)).toContain("ŞÜPHE-1");
    // Belge aşamasında da eşdeğerlik onaycısı eski kodu okuyabilir (yalnızca okuma araçlarıyla); araçsız onaycılar belgeyle yetinir
    const gunluk = (adim: number) => JSON.parse(dosya(k, fid, `gunluk/adim-${adim}.json`));
    const msaGunluk = gunluk(ha[0].id);
    expect([msaGunluk.araclar, path.basename(msaGunluk.cwd)]).toEqual([["Read", "Glob", "Grep"], "kod"]);
    expect(msaGunluk.istem).toContain("Eski sistemin kodu `kaynak/` altında");
    const mimarGunluk = gunluk(d.adimlar.find((a) => a.asama_id === "hedef-analiz" && a.ajan === "mimar")!.id);
    expect([mimarGunluk.araclar, path.basename(mimarGunluk.cwd)]).toEqual([[], "belgeler"]);
    expect(dosya(k, fid, "belgeler/analiz.md")).toContain("| ŞÜPHE-1: yeniden çalıştırmada çift kayıt | DÜZELT |");

    // Plan saf hesaptan portlara; kod istemleri replatform notunu taşır
    expect(d.plan!.map((p) => `${p.id}:${p.baslik}:${p.gelistirici_kisa}:${p.bagimli.join("+") || "-"}`)).toEqual([
      "P1:Günlük faiz hesabı:BCKD:-", "P2:Reeskont hesaplama:BCKD:P1", "P3:Gün sonu akışı ve portlar:BCKD:P2",
    ]);
    const p1Istem = istemi(k, fid, d.adimlar.find((a) => a.asama_id === "p1-is-kalemi" && a.tip === "uret")!.id);
    expect(p1Istem).toContain("## Mevcut sistem\nBu iş bir replatform");
    expect(p1Istem).toContain("Karar (projenin sahibi): Koddaki gibi 365");
    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => `${a.asama_id}:${a.durum}`)).toEqual([
      "mevcut-sistem:yesil", "teslim-plani:yesil", "test-altyapisi:yesil", "p1-is-kalemi:kirmizi", "p1-is-kalemi:yesil", "p1-is-kalemi:yesil",
      "p2-is-kalemi:yesil", "p3-is-kalemi:yesil", "birlestirme:yesil",
    ]);
    // İlk turdaki kırmızı: yazılımcı dokümandaki 360'ı kullandı, kilitli test 365 bekliyordu
    expect(d.adimlar.find((a) => a.asama_id === "p1-is-kalemi" && a.durum === "kirmizi")!.ozet).toMatch(/# fail 1/);
    expect(d.adimlar.find((a) => a.asama_id === "birlestirme" && a.tip === "kontrol")!.ozet).toMatch(/# tests 6 · # pass 6/);
    expect(dosya(k, fid, "kod/backend/src/faiz.mjs")).toContain("export const GUN_ESASI = 365;");
    expect(varMi(k, fid, "kod/testler/be/entegrasyon/altin.test.mjs")).toBe(true);
    expect(ozet(path.join(k.calisma, fid, "kod", PKB))).toBe(ozet(path.join(ORNEK, "KART_REESKONT_GUNSONU.pkb")));   // kaynak el değmeden durur
    expect(dosya(k, fid, "belgeler/entegrasyon.md")).toContain("## Paralel koşum planı");
    expect(f.bekleme!.detay).toContain("Gün esası: Koddaki gibi 365");

    // Kabul: PO gelişim önerileri getirir
    k.ork.kararVer(fid, "kabul");
    f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.sorular!.map((s) => s.baslik)).toEqual(["Kesintide kaldığı yerden devam", "Kart bazında mutabakat raporu", "Gün esası ürün parametresi"]);
  });

  it("salt okunur aşamada yazılan her şey geri alınır; kaynağa dokunmak kilit ihlalidir", async () => {
    const betik = new BetikMotor("deneme", (c) => {
      if (c.asama_id === "mevcut-sistem" && c.gorev_turu === "uret" && !c.istem.includes("## Düzeltme istekleri")) {
        fs.writeFileSync(path.join(c.cwd, "notlar.md"), "taslak");
        fs.appendFileSync(path.join(c.cwd, PKB), "-- düzelttim\n");
      }
      return null;
    });
    const k = await kovanOlustur({ motorlar: motorlar(betik) });
    const fid = await k.ork.yeniFikir("", FIKIR, "replatform", "deneme", { kaynaklar: [ORNEK] });
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    const ihlaller = k.ork.fikirDetayi(fid).adimlar.filter((a) => a.durum === "ihlal").map((a) => a.ozet);
    expect(ihlaller).toEqual([
      expect.stringMatching(/sınır dışına yazdı: notlar\.md \(salt okunur aşama\)/),
      expect.stringMatching(/kilitli dosyalara dokundu: kaynak\/reeskont-eski\/KART_REESKONT_GUNSONU\.pkb/),
    ]);
    expect(varMi(k, fid, "kod/notlar.md")).toBe(false);
    expect(ozet(path.join(k.calisma, fid, "kod", PKB))).toBe(ozet(path.join(ORNEK, "KART_REESKONT_GUNSONU.pkb")));
  });

  it("uydurma atıflı analiz onay kuruluna gitmeden geri döner", async () => {
    const betik = new BetikMotor("deneme", (c) =>
      c.asama_id === "mevcut-sistem" && c.gorev_turu === "uret" && !c.istem.includes("## Düzeltme istekleri")
        ? { metin: `# Mevcut sistem\n\n- E1: faiz ${PKB}:999\n- E2: sabitler kaynak/reeskont-eski/YOK.pkb:3\n` }
        : null);
    const k = await kovanOlustur({ motorlar: motorlar(betik) });
    const fid = await k.ork.yeniFikir("", FIKIR, "replatform", "deneme", { kaynaklar: [ORNEK] });
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    const d = k.ork.fikirDetayi(fid);
    const ms = d.adimlar.filter((a) => a.asama_id === "mevcut-sistem");
    expect(ms.map((a) => `${a.tur}:${a.tip}:${a.durum}`)).toEqual([
      "1:uret:tamam", "1:kontrol:kirmizi", "2:uret:tamam", "2:kontrol:yesil", "2:inceleme:onay", "2:inceleme:onay", "2:inceleme:onay",
    ]);
    const ikinci = istemi(k, fid, ms[2].id);
    expect(ikinci).toContain("### Kaynak atıfları: GEÇERSİZ");
    expect(ikinci).toContain(`${PKB}:999: dosya 48 satır; bu satırlar yok`);
    expect(ikinci).toContain("kaynak/reeskont-eski/YOK.pkb:3: böyle bir dosya yok");
  });
});

describe("Hedef yığın ve Hepsi yerel", () => {
  it("hazır yığın ve serbest metin karar defterine girer; bütün aşamalar onu görür", async () => {
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme", { hedef_yigin: "java21-temporal" });
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    const karar = k.ork.fikirDetayi(fid).kararlar[0];
    expect(karar).toMatchObject({ baslik: "Hedef yığın", soru: "Yeni kod hangi teknolojiyle yazılsın?" });
    expect(karar.cevap).toMatch(/Temporal/);
    const brif = k.ork.fikirDetayi(fid).adimlar.find((a) => a.asama_id === "brif")!;
    expect(istemi(k, fid, brif.id)).toMatch(/## Alınan kararlar[\s\S]*Hedef yığın[\s\S]*Temporal/);

    const serbest = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme", { hedef_yigin: "Kotlin 2 + Ktor, Gradle" });
    await bekle(k, serbest, bekliyor("ajan_sorusu"));
    expect(k.ork.fikirDetayi(serbest).kararlar[0].cevap).toBe("Kotlin 2 + Ktor, Gradle");
  });

  it("Hepsi yerel: oylar ve onaylar dahil her çağrı yerel motorda; yerel motor yoksa hiçbir şey buluta gitmez", async () => {
    const claude = new SahteMotor("claude");
    const qwen = new SahteMotor("qwen-yerel", true);
    const k = await kovanOlustur({ motorlar: motorlar(undefined, claude, qwen) });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "standart", "yerel");
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.ork.cevapla(fid, [{ secilenler: ["Hayır, anonim kullanım"] }]);
    await bekle(k, fid, bekliyor("insan"));
    const d = k.ork.fikirDetayi(fid);
    expect(Object.keys(d.motor_cagrilari)).toEqual(["qwen-yerel"]);
    expect(d.adimlar.some((a) => a.tip === "oy")).toBe(true);
    expect(claude.cagrilar).toHaveLength(0);
    expect(d.asamalar.filter((a) => a.motor).every((a) => a.motor === "qwen-yerel")).toBe(true);

    qwen.hazir = false;
    qwen.hata = "Ollama çalışmıyor";
    await expect(k.ork.yeniFikir("", ORNEK_MINI, "mini", "yerel")).rejects.toThrow(/Hepsi yerel' modunda bütün ajanlar bu motorda çalışır/);
    // Yerel motoru hiç tanımlanmamış bir kurulum (kartlar da Claude'da)
    const kok = geciciKok();
    for (const kart of ["be-yazilimci", "fe-yazilimci"]) {
      const yol = path.join(kok, "ajanlar", `${kart}.md`);
      fs.writeFileSync(yol, fs.readFileSync(yol, "utf8").replace(/^motor: qwen-yerel.*$/m, "motor: claude"));
    }
    const yalnizClaude = await kovanOlustur({ kok, motorlar: motorlar(undefined, undefined, null) });
    await expect(yalnizClaude.ork.yeniFikir("", ORNEK_MINI, "mini", "yerel")).rejects.toThrow(/yerel motor/);
  });
});
