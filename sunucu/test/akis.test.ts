// Uçtan uca akışlar (deneme motoru): sorular, karar defteri, test döngüsü, onay kurulu, teslim ve geri gönderme.
import { describe, expect, it } from "vitest";
import { bekle, bekliyor, dosya, istemi, kovanOlustur, ORNEK_MINI, ORNEK_PANEL } from "./yardimci/ortam.js";

describe("Mini akış", () => {
  it("PO sorar, cevap karar defterine girer, testler kırmızıdan yeşile döner, teslim kabul edilir", async () => {
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("Flora AI analiz kredisi", ORNEK_MINI, "mini", "deneme");

    let f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    const soru = f.bekleme!.sorular![0];
    expect(f.bekleme!.kaynak).toBe("uret");
    expect(soru.baslik).toBe("Arayüz dili");
    expect(soru.soran_ad).toBe("Ürün Sahibi");
    expect(soru.secenekler.length).toBeGreaterThanOrEqual(2);
    expect(soru.secenekler[0].etiket).toMatch(/\(Önerilen\)$/);

    k.ork.cevapla(fid, [{ secilenler: ["Türkçe"], serbest: "Tarihler gg.aa.yyyy" }]);
    f = await bekle(k, fid, bekliyor("insan"));

    const d = k.ork.fikirDetayi(fid);
    expect(d.ajan_cagrisi).toBe(5);
    expect(d.kararlar).toHaveLength(1);
    expect(d.kararlar[0]).toMatchObject({ baslik: "Arayüz dili", cevap: "Türkçe · Not: Tarihler gg.aa.yyyy", soran: "Ürün Sahibi" });
    expect(dosya(k, fid, "belgeler/kararlar.md")).toContain("**Cevap: Türkçe · Not: Tarihler gg.aa.yyyy**");

    // Soru adımı "soru", ardından PO kararı bilerek yazdı
    const brifAdimlari = d.adimlar.filter((a) => a.asama_id === "brif" && a.tip === "uret");
    expect(brifAdimlari.map((a) => a.durum)).toEqual(["soru", "tamam"]);
    const brifIstemi = istemi(k, fid, brifAdimlari[1].id);
    expect(brifIstemi).toContain("## İnsan kararları");
    expect(brifIstemi).toContain("Cevap: Türkçe · Not: Tarihler gg.aa.yyyy");
    // Sonraki aşamaların ajanları da kararı görür
    const beIlk = d.adimlar.find((a) => a.asama_id === "be-gelistirme" && a.tip === "uret")!;
    expect(istemi(k, fid, beIlk.id)).toContain("### Arayüz dili");

    // Gerçek test komutu koştu: önce kırmızı, sonra yeşil
    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => a.durum)).toEqual(["kirmizi", "yesil"]);
    // Testler kilitlendi
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toEqual(["test-be.sh", "testler"]);
    // Teslim özeti senin kararlarını da içerir
    expect(f.bekleme!.detay).toContain("Senin kararların:");
    expect(f.bekleme!.secenekler.map((s) => s.anahtar)).toEqual(["kabul", "geri_gonder", "durdur"]);
    expect(f.bekleme!.secenekler[0].onerilen).toBe(true);
    expect(f.bekleme!.geri_hedefler!.map((h) => h.id)).toEqual(["brif", "otomatik-testler", "be-gelistirme"]);
    expect(f.bekleme!.varsayilan_hedef).toBe("be-gelistirme");

    k.ork.kararVer(fid, "kabul", "Güzel olmuş");
    f = await bekle(k, fid, (x) => x.durum === "tamamlandi");
    expect(k.ork.fikirDetayi(fid).asamalar.every((a) => a.durum === "tamam")).toBe(true);
  });

  it("notla geri gönderilen aşama notu görür; sonraki aşamalar yeniden yazılmaz, yeniden doğrulanır", async () => {
    const k = await kovanOlustur();
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
    // Testler ve backend yeniden yazılmadı, yalnızca yeniden doğrulandı
    expect(d.adimlar.filter((a) => a.asama_id === "otomatik-testler" && a.tip === "uret")).toHaveLength(1);
    expect(d.adimlar.filter((a) => a.ajan_ad === "Yeniden doğrulama").map((a) => a.asama_id)).toEqual(["otomatik-testler", "be-gelistirme"]);
    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => a.durum)).toEqual(["kirmizi", "yesil", "yesil"]);
  });
});

describe("Standart akış", () => {
  it("onaycı sorusu: cevaptan sonra yazar kararı ve aynı turdaki bulguları tek turda işler", async () => {
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("Flora AI hatırlatma servisi", ORNEK_MINI, "standart", "deneme");
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.ork.cevapla(fid, [{ secilenler: ["İngilizce"] }]);

    const f = await bekle(k, fid, (x) => bekliyor("ajan_sorusu")(x) && x.bekleme?.asama_id === "analiz");
    expect(f.bekleme!.kaynak).toBe("inceleme");
    expect(f.bekleme!.sorular!.map((s) => [s.baslik, s.soran])).toEqual([["Kişisel veri", "mevzuat"]]);
    expect(f.bekleme!.detay).toContain("DÜZELT");                          // diğer onaycıların bulguları da görünür
    expect(f.bekleme!.bekleyen_geri_bildirim).toContain("Mevzuat onayı (Mevzuat ve Uyum): SORU");
    expect(f.tur).toBe(1);

    k.ork.cevapla(fid, [{ secilenler: ["Evet, e-posta ile giriş"], serbest: "Şifresiz, tek kullanımlık bağlantı" }]);
    await bekle(k, fid, bekliyor("insan"));

    const d = k.ork.fikirDetayi(fid);
    const analiz = d.adimlar.filter((a) => a.asama_id === "analiz" && a.tip !== "sistem");
    expect(analiz.map((a) => `${a.tur}:${a.tip}:${a.durum}`)).toEqual([
      "1:uret:tamam", "1:inceleme:duzelt", "1:inceleme:duzelt", "1:inceleme:soru",
      "2:uret:tamam", "2:inceleme:onay", "2:inceleme:onay", "2:inceleme:onay",
    ]);
    const ikinciTur = istemi(k, fid, analiz[4].id);
    expect(ikinciTur).toContain("## Düzeltme istekleri");
    expect(ikinciTur).toContain("SORU");
    expect(ikinciTur).toContain("Cevap: Evet, e-posta ile giriş · Not: Şifresiz, tek kullanımlık bağlantı");
    expect(d.kararlar.map((x) => x.soran)).toEqual(["Ürün Sahibi", "Mevzuat ve Uyum"]);
    expect(d.ajan_cagrisi).toBe(28);
  });
});

describe("Tam yığın akış", () => {
  it("UX, BE ve FE aşamalarını geçer; tasarım ve testler kilitlenir; teslimde önizlemeler hazır", async () => {
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("Flora AI bakım paneli", ORNEK_PANEL, "tam-yigin", "deneme");
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    k.ork.cevapla(fid, [{ secilenler: ["Türkçe"] }]);
    await bekle(k, fid, (x) => bekliyor("ajan_sorusu")(x) && x.bekleme?.asama_id === "analiz");
    k.ork.cevapla(fid, [{ secilenler: ["Hayır, anonim kullanım"] }]);
    await bekle(k, fid, bekliyor("insan"), 60_000);

    const d = k.ork.fikirDetayi(fid);
    expect(d.ajan_cagrisi).toBe(39);
    expect(JSON.parse(dosya(k, fid, ".kovan/kilitler.json")).yollar).toEqual(["tasarim", "test-be.sh", "test-fe.sh", "testler"]);
    expect(d.onizlemeler.map((o) => o.yol)).toEqual(["kod/tasarim/prototip.html", "kod/frontend/index.html"]);
    expect(d.adimlar.filter((a) => a.tip === "kontrol").map((a) => `${a.ajan_ad}:${a.durum}`)).toEqual([
      "BE testleri:kirmizi", "BE testleri:yesil", "BE testleri:yesil", "FE testleri:kirmizi", "FE testleri:yesil",
    ]);
    // Onay rozetleri: FE geliştirmenin kurulu (test + 5 onaycı) yeşil
    const fe = d.asamalar.find((a) => a.id === "fe-gelistirme")!;
    expect(fe.onaylar.map((o) => o.durum)).toEqual(["yesil", "onay", "onay", "onay", "onay", "onay"]);
  });
});
