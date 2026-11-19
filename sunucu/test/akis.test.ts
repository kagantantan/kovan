// Uçtan uca akışlar (deneme motoru): sorular, ortak karar, karar defteri, iş kalemleri, test döngüsü,
// onay kurulu, mevzuat kapsamı, teslim, gelişim önerileri, yeni sürüm ve geri gönderme.
import { describe, expect, it } from "vitest";
import { bekle, bekliyor, dosya, geciciKok, istemi, kovanOlustur, ORNEK_MINI, ORNEK_PANEL, varMi } from "./yardimci/ortam.js";

// Bu dosya derin planlamayı ve ekip oylamasını sınar; analiz aşamalarının insan döngüsü (is_kurali_sana, once_soru)
// insan-dongusu.test.ts'te. Burada kapalı, yoksa PO'nun brif sorusu ekibe uğramadan sana gelir.
const kur = () => kovanOlustur({ kok: geciciKok({}, { analizKontrolleri: false }) });

describe("Mini akış (ortak karar kapalı)", () => {
  it("PO sorar, soru doğrudan sana gelir; cevap deftere girer, testler kırmızıdan yeşile döner, teslim kabul edilir", async () => {
    const k = await kur();
    const fid = await k.ork.yeniFikir("Flora AI analiz kredisi", ORNEK_MINI, "mini", "deneme");

    let f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    const soru = f.bekleme!.sorular![0];
    expect(f.bekleme!.kaynak).toBe("uret");
    expect(soru.baslik).toBe("Arayüz dili");
    expect(soru.soran_ad).toBe("Ürün Sahibi");
    expect(soru.oylar).toBeUndefined();                       // Mini'de ekip oylamaz
    expect(soru.secenekler[0].etiket).toMatch(/\(Önerilen\)$/);

    expect(() => k.ork.cevapla(fid, [{ secilenler: ["Fransızca"] }])).toThrow(/diye bir seçenek yok/);
    k.ork.cevapla(fid, [{ secilenler: ["Türkçe"], serbest: "Tarihler gg.aa.yyyy" }]);
    f = await bekle(k, fid, bekliyor("insan"));

    const d = k.ork.fikirDetayi(fid);
    expect(d.ajan_cagrisi).toBe(5);
    expect(d.kararlar).toHaveLength(1);
    expect(d.kararlar[0]).toMatchObject({ baslik: "Arayüz dili", cevap: "Türkçe · Not: Tarihler gg.aa.yyyy", soran: "Ürün Sahibi", karar_veren: "insan" });
    expect(dosya(k, fid, "belgeler/kararlar.md")).toContain("**Senin kararın: Türkçe · Not: Tarihler gg.aa.yyyy**");

    const brifAdimlari = d.adimlar.filter((a) => a.asama_id === "brif" && a.tip === "uret");
    expect(brifAdimlari.map((a) => a.durum)).toEqual(["soru", "tamam"]);
    const brifIstemi = istemi(k, fid, brifAdimlari[1].id);
    expect(brifIstemi).toContain("## Alınan kararlar");
    expect(brifIstemi).toContain("Karar (projenin sahibi): Türkçe · Not: Tarihler gg.aa.yyyy");
    const beIlk = d.adimlar.find((a) => a.asama_id === "be-gelistirme" && a.tip === "uret")!;
    expect(istemi(k, fid, beIlk.id)).toContain("### Arayüz dili");

    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => a.durum)).toEqual(["kirmizi", "yesil"]);
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toEqual(["test-be.sh", "testler"]);
    expect(f.bekleme!.detay).toContain("Senin kararların:");
    expect(f.bekleme!.secenekler.map((s) => s.anahtar)).toEqual(["kabul", "geri_gonder", "durdur"]);
    expect(f.bekleme!.geri_hedefler!.map((h) => h.id)).toEqual(["brif", "otomatik-testler", "be-gelistirme"]);
    expect(f.bekleme!.varsayilan_hedef).toBe("be-gelistirme");

    k.ork.kararVer(fid, "kabul", "Güzel olmuş");
    f = await bekle(k, fid, (x) => x.durum === "tamamlandi");
    expect(k.ork.fikirDetayi(fid).asamalar.every((a) => a.durum === "tamam")).toBe(true);
  });

  it("notla geri gönderilen aşama notu görür; sonraki aşamalar yeniden yazılmaz, yeniden doğrulanır", async () => {
    const k = await kur();
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.ork.cevapla(fid, [{ secilenler: ["Türkçe"] }]);
    await bekle(k, fid, bekliyor("insan"));

    expect(() => k.ork.kararVer(fid, "geri_gonder", "")).toThrow(/not olarak yaz/);
    k.ork.kararVer(fid, "geri_gonder", "Pazartesi sıfırlaması Türkiye saatiyle olsun", "brif");
    await bekle(k, fid, bekliyor("insan"));

    const d = k.ork.fikirDetayi(fid);
    const brifler = d.adimlar.filter((a) => a.asama_id === "brif" && a.tip === "uret" && a.durum === "tamam");
    expect(brifler).toHaveLength(2);
    expect(istemi(k, fid, brifler[1].id)).toContain("### İnsanın notu\nPazartesi sıfırlaması Türkiye saatiyle olsun");
    expect(d.adimlar.filter((a) => a.asama_id === "otomatik-testler" && a.tip === "uret")).toHaveLength(1);
    expect(d.adimlar.filter((a) => a.ajan_ad === "Yeniden doğrulama").map((a) => a.asama_id)).toEqual(["otomatik-testler", "be-gelistirme"]);
    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => a.durum)).toEqual(["kirmizi", "yesil", "yesil"]);
  });
});

describe("Standart akış: derin planlama ve iş kalemleri", () => {
  it("ekip kendi karar verir, anlaşamadığını oylarla sorar; kod ancak plandan ve kilitli testlerden sonra yazılır", async () => {
    const k = await kur();
    const fid = await k.ork.yeniFikir("Flora AI hatırlatma servisi", ORNEK_MINI, "standart", "deneme");

    // PO'nun "Arayüz dili" sorusu ekipte oybirliğiyle karara bağlandı; sana ilk gelen Mevzuat'ın sorusu.
    let f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.asama_id).toBe("analiz");
    expect(f.bekleme!.kaynak).toBe("inceleme");
    expect(f.bekleme!.mesaj).toMatch(/^Ekip anlaşamadı/);
    const soru = f.bekleme!.sorular![0];
    expect([soru.baslik, soru.soran]).toEqual(["Kişisel veri", "mevzuat"]);
    expect(soru.oylar!.map((o) => `${o.kisa}:${o.secim.join("+")}`)).toEqual([
      "UYUM:Hayır, anonim kullanım", "PO:Hayır, anonim kullanım", "TKM:Evet, e-posta ile giriş", "ANLZ:Hayır, anonim kullanım",
    ]);
    expect(soru.oylar![0].soran).toBe(true);
    expect(soru.neden).toContain("Ekip anlaşamadı");
    expect(f.bekleme!.detay).toContain("DÜZELT");                      // aynı turdaki bulgular da görünür
    expect(f.tur).toBe(1);

    let d = k.ork.fikirDetayi(fid);
    expect(d.kararlar[0]).toMatchObject({ baslik: "Arayüz dili", cevap: "Türkçe", karar_veren: "ekip", kural: "oybirligi" });
    expect(d.kararlar[0].oylar!.map((o) => o.kisa)).toEqual(["PO", "TKM", "ANLZ"]);
    const brif = d.adimlar.filter((a) => a.asama_id === "brif");
    expect(brif.map((a) => `${a.tip}:${a.durum}`)).toEqual(["uret:soru", "oy:oy", "oy:oy", "sistem:ekip", "uret:tamam"]);
    expect(istemi(k, fid, brif[4].id)).toContain("Karar (ekip, oybirliği): Türkçe");
    expect(d.plan).toBeNull();                                          // plan henüz yok: kalemler tek aşama
    expect(d.asamalar.find((a) => a.id === "kalemler")).toMatchObject({ tur: "kalemler", ajan: "PLAN", durum: "bekleyen" });

    k.ork.cevapla(fid, [{ secilenler: ["Evet, e-posta ile giriş"], serbest: "Şifresiz, tek kullanımlık bağlantı" }]);
    f = await bekle(k, fid, bekliyor("insan"));
    expect(f.bekleme!.asama_id).toBe("kabul");

    d = k.ork.fikirDetayi(fid);
    const analiz = d.adimlar.filter((a) => a.asama_id === "analiz" && (a.tip === "uret" || a.tip === "inceleme"));
    expect(analiz.map((a) => `${a.tur}:${a.tip}:${a.durum}`)).toEqual([
      "1:uret:tamam", "1:inceleme:duzelt", "1:inceleme:duzelt", "1:inceleme:onay", "1:inceleme:soru",
      "2:uret:tamam", "2:inceleme:onay", "2:inceleme:onay", "2:inceleme:onay", "2:inceleme:onay",
    ]);
    const ikinciTur = istemi(k, fid, analiz[5].id);
    expect(ikinciTur).toContain("## Düzeltme istekleri");
    expect(ikinciTur).toContain("Karar (projenin sahibi): Evet, e-posta ile giriş · Not: Şifresiz, tek kullanımlık bağlantı");
    expect(d.kararlar.map((x) => [x.soran, x.karar_veren])).toEqual([["Ürün Sahibi", "ekip"], ["Mevzuat ve Uyum", "insan"]]);
    expect(d.kararlar[1].oylar).toHaveLength(4);                       // senin kararın ekibin oylarıyla birlikte saklanır

    // Teslim planı açıldı: her kalem önce kabul testi (kilitlenir), sonra kod.
    expect(d.plan!.map((p) => `${p.id}:${p.gelistirici_kisa}:${p.bagimli.join("+") || "-"}:${p.durum}`)).toEqual([
      "P1:BCKD:-:tamam", "P2:BCKD:P1:tamam", "P3:BCKD:P2:tamam",
    ]);
    const sira = d.asamalar.map((a) => a.id);
    expect(sira.slice(sira.indexOf("test-altyapisi"), sira.indexOf("birlestirme") + 1)).toEqual([
      "test-altyapisi", "p1-kabul-testi", "p1-is-kalemi", "p2-kabul-testi", "p2-is-kalemi", "p3-kabul-testi", "p3-is-kalemi", "birlestirme",
    ]);
    expect(d.asamalar.find((a) => a.id === "p2-is-kalemi")).toMatchObject({ ad: "P2 İş kalemi", kalem: "P2", ajan: "BCKD", yazabilir: ["backend"] });
    // İlk kod satırı yazılmadan önce plan, senaryolar ve test altyapısı onaylanmıştı
    const ilkKod = d.adimlar.find((a) => a.asama_id === "p1-is-kalemi")!.id;
    for (const a of ["teknik-plan", "teslim-plani", "test-senaryolari", "test-altyapisi", "p1-kabul-testi"]) {
      expect(d.adimlar.filter((s) => s.asama_id === a && s.id < ilkKod).length, a).toBeGreaterThan(0);
    }
    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => `${a.asama_id}:${a.durum}`)).toEqual([
      "teknik-plan:yesil", "teslim-plani:yesil", "test-altyapisi:yesil", "p1-is-kalemi:kirmizi", "p1-is-kalemi:yesil", "p1-is-kalemi:yesil",
      "p2-is-kalemi:yesil", "p3-is-kalemi:yesil", "birlestirme:yesil",
    ]);
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toEqual([
      "adr", "test-be.sh", "testler/be/entegrasyon", "testler/be/p1", "testler/be/p2", "testler/be/p3", "testler/package.json",
    ]);
    // Kalemin istemi kalemin kapsamını taşır; sonraki kalemin işine girmemesi söylenir
    const p2Istem = istemi(k, fid, d.adimlar.find((a) => a.asama_id === "p2-is-kalemi" && a.tip === "uret")!.id);
    expect(p2Istem).toContain("## İş kalemi\nP2: Bugün sulanacaklar listesi");
    expect(p2Istem).toContain("Bağımlı olduğu kalemler: P1 (tamamlandı");
    // Birleştirme bütün kalemlerin özetini okur
    expect(istemi(k, fid, d.adimlar.find((a) => a.asama_id === "birlestirme" && a.tip === "uret")!.id)).toContain("## P3 'Suladım' işareti (BCKD)");
    expect(f.bekleme!.varsayilan_hedef).toBe("p3-is-kalemi");          // teslimdeki notun varsayılan hedefi son kod kalemi
    expect(f.bekleme!.detay).toContain("Ekibin kendi aldığı kararlar:\n  Arayüz dili: Türkçe");
    expect(d.ajan_cagrisi).toBe(63);
  });

  it("kabulden sonra PO gelişim önerileri getirir; kabul ettiklerinle yeni sürüm kodu ve kararları devralır", async () => {
    const k = await kur();
    const fid = await k.ork.yeniFikir("Flora AI hatırlatma servisi", ORNEK_MINI, "standart", "deneme");
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.ork.cevapla(fid, [{ secilenler: ["Hayır, anonim kullanım"] }]);
    await bekle(k, fid, bekliyor("insan"));
    await expect(k.ork.yeniSurum(fid)).rejects.toThrow(/tamamlanmış/);
    k.ork.kararVer(fid, "kabul");

    let f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.kaynak).toBe("gelisim");
    const sorular = f.bekleme!.sorular!;
    expect(sorular.map((s) => [s.oneri_id, s.baslik, s.insan])).toEqual([
      ["G1", "Fotoğraftan hastalık tespiti", true], ["G2", "Hava durumuna göre sulama", true], ["G3", "Ailece ortak bahçe", true],
    ]);
    expect(sorular[0].secenekler.map((o) => o.etiket)).toEqual(["Evet, sonraki sürüme al (Önerilen)", "Değiştirerek al", "Şimdilik hayır", "Hayır, bir daha önerme"]);
    expect(sorular[1].secenekler[0].etiket).toBe("Evet, sonraki sürüme al");   // yalnızca yüksek öncelikte öneri işareti
    expect(k.ork.fikirDetayi(fid).adimlar.some((a) => a.asama_id === "gelisim" && a.tip === "oy")).toBe(false);  // ekip oylamaz

    k.ork.cevapla(fid, [
      { secilenler: ["Evet, sonraki sürüme al"] },
      { secilenler: ["Değiştirerek al"], serbest: "Yalnızca balkon bitkileri" },
      { secilenler: ["Hayır, bir daha önerme"] },
    ]);
    f = await bekle(k, fid, (x) => x.durum === "tamamlandi");
    const d = k.ork.fikirDetayi(fid);
    expect(d.gelisim.map((g) => `${g.id}:${g.karar}`)).toEqual(["G1:al", "G2:degistir", "G3:asla"]);
    expect(dosya(k, fid, "belgeler/gelisim-defteri.md")).toContain("**Karar: Değiştirerek alındı** · Not: Yalnızca balkon bitkileri");
    expect(d.sonraki_surum_metni).toContain("Fotoğraftan hastalık tespiti");
    expect(d.sonraki_surum_metni).toContain("Değişiklik isteği: Yalnızca balkon bitkileri");
    expect(d.sonraki_surum_metni).not.toContain("Ailece ortak bahçe");

    const v2 = await k.ork.yeniSurum(fid);
    await expect(k.ork.yeniSurum(fid)).rejects.toThrow(/zaten başlatıldı/);
    expect(k.depo.fikir(fid)!.sonraki_surum).toBe(v2);
    expect(k.depo.fikir(v2)).toMatchObject({ baslik: "Flora AI hatırlatma servisi v2", surum: 2, temel_fikir: fid });
    expect(dosya(k, v2, "belgeler/fikir.md")).toContain("## Bu sürümde istenenler");
    expect(varMi(k, v2, "kod/backend/src/sulama.mjs")).toBe(true);    // önceki sürümün kodu taşındı
    expect(JSON.parse(dosya(k, v2, ".kovan/kararlar.json"))).toHaveLength(2);   // kararlar bağlayıcı olmaya devam eder
    expect(JSON.parse(dosya(k, v2, ".kovan/gelisim.json"))).toHaveLength(3);    // PO "bir daha önerme"yi bilir

    // Yeni sürüm aynı derin akıştan geçer; kalemleri önceki sürümün testleriyle çakışmasın diye v2- önekli
    const g = await bekle(k, v2, bekliyor("insan"));
    expect(g.bekleme!.asama_id).toBe("kabul");                          // kararlar devraldığı için kimse yeniden sormadı
    const dv2 = k.ork.fikirDetayi(v2);
    expect(dv2.asamalar.filter((a) => a.kalem).map((a) => a.id)).toContain("v2-p1-kabul-testi");
    expect(varMi(k, v2, "kod/testler/be/v2-p1/sulama.test.mjs")).toBe(true);
    expect(varMi(k, v2, "kod/testler/be/p1/sulama.test.mjs")).toBe(true);   // eski kalemlerin testleri regresyon olarak kalır
  });

  it("teslim planına geri gönderilince kalemler yeni plandan açılır; önceki kalemler yeniden yazılmaz, yeniden doğrulanır", async () => {
    const k = await kur();
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "standart", "deneme");
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.ork.cevapla(fid, [{ secilenler: ["Hayır, anonim kullanım"] }]);
    await bekle(k, fid, bekliyor("insan"));
    k.ork.kararVer(fid, "geri_gonder", "P3'ü daha küçük yaz", "teslim-plani");
    await bekle(k, fid, bekliyor("insan"));
    const d = k.ork.fikirDetayi(fid);
    expect(d.adimlar.filter((a) => a.ajan_ad === "Plan açıldı")).toHaveLength(2);
    expect(d.adimlar.filter((a) => a.asama_id === "p1-is-kalemi" && a.tip === "uret")).toHaveLength(3);   // ilk geçişteki üç tur
    expect(d.adimlar.filter((a) => a.ajan_ad === "Yeniden doğrulama").map((a) => a.asama_id)).toContain("p1-is-kalemi");
  });
});

describe("Tam yığın akış", () => {
  it("mevzuat konusu yoksa Mevzuat bir kez 'kapsam dışı' der ve atlanır; FE kalemine UX bakar", async () => {
    const k = await kur();
    const fid = await k.ork.yeniFikir("Flora AI bakım paneli", ORNEK_PANEL, "tam-yigin", "deneme");
    const f = await bekle(k, fid, (x) => x.durum === "bekliyor", 60_000);
    expect(f.bekleme!.sebep).toBe("insan");                             // hiçbir soru sana gelmedi: ekip karar verdi
    expect(f.kapsam_disi).toEqual(["mevzuat"]);

    const d = k.ork.fikirDetayi(fid);
    const mevzuat = d.adimlar.filter((a) => a.ajan === "mevzuat");
    expect(mevzuat.map((a) => `${a.asama_id}:${a.durum}`)).toEqual(["analiz:onay"]);
    expect(mevzuat[0].ozet).toMatch(/^Kapsam dışı/);
    expect(d.adimlar.filter((a) => a.ajan_ad === "Kapsam dışı").map((a) => a.asama_id)).toEqual(["analiz", "ux-tasarim", "teknik-plan"]);
    expect(d.asamalar.find((a) => a.id === "teknik-plan")!.onaylar.find((o) => o.kisa === "UYUM")!.durum).toBe("atlandi");
    // Onaycının atlanması aşamayı "atlandı" göstermez; aşamaların kendisi tamamlandı
    expect(d.asamalar.filter((a) => a.durum === "atlandi")).toEqual([]);

    expect(d.plan!.map((p) => `${p.id}:${p.gelistirici_kisa}`)).toEqual(["P1:BCKD", "P2:BCKD", "P3:FE"]);
    expect(d.asamalar.find((a) => a.id === "p3-is-kalemi")).toMatchObject({ ajan: "FE", yazabilir: ["frontend"] });
    expect(d.asamalar.find((a) => a.id === "p3-is-kalemi")!.onaylar.map((o) => o.kisa)).toEqual(["TEST", "ANLZ", "TKM", "KTST", "SCRT", "UX"]);
    expect(d.asamalar.find((a) => a.id === "p1-is-kalemi")!.onaylar.map((o) => o.kisa)).toEqual(["TEST", "ANLZ", "TKM", "KTST", "SCRT"]);
    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => `${a.asama_id}:${a.ajan_ad}:${a.durum}`)).toEqual([
      "teknik-plan:ADR biçimi:yesil", "teslim-plani:Plan biçimi:yesil", "test-altyapisi:Altyapı çalışıyor:yesil",
      "p1-is-kalemi:Testler:kirmizi", "p1-is-kalemi:Testler:yesil", "p1-is-kalemi:Testler:yesil", "p2-is-kalemi:Testler:yesil",
      "p3-is-kalemi:Testler:kirmizi", "p3-is-kalemi:Testler:yesil", "birlestirme:BE testleri:yesil", "birlestirme:FE testleri:yesil",
    ]);
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toEqual([
      "adr", "tasarim", "test-be.sh", "test-fe.sh", "testler/be/entegrasyon", "testler/be/p1", "testler/be/p2",
      "testler/fe/entegrasyon", "testler/fe/p3", "testler/package.json", "testler/playwright.config.ts",
    ]);
    expect(d.onizlemeler.map((o) => o.yol)).toEqual(["kod/tasarim/prototip.html", "kod/frontend/index.html"]);
    expect(d.ajan_cagrisi).toBe(63);
  });
});
