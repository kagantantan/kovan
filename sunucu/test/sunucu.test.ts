// HTTP katmanı: host ve köken denetimi, hata kodları, dosya erişim sınırları, önizleme yalıtımı,
// karar ve cevap uç noktaları; karar ve cevap doğrulamaları.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { KOK, bekle, bekliyor, kovanOlustur, ORNEK_MINI } from "./yardimci/ortam.js";

const HOST = { host: "127.0.0.1:8765" };

describe("HTTP sunucusu", () => {
  it("yalnızca kendi adresinden gelen isteği kabul eder", async () => {
    const { app } = await kovanOlustur();
    expect((await app.inject({ url: "/api/durum", headers: HOST })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/durum", headers: { host: "localhost:8765" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/durum", headers: { host: "kotu.example:8765" } })).statusCode).toBe(403);   // DNS rebinding

    const govde = { metin: ORNEK_MINI, profil: "mini", motor: "deneme" };
    for (const origin of ["https://kotu.example", "null", "http://127.0.0.1:5173"]) {
      const r = await app.inject({ method: "POST", url: "/api/fikirler", headers: { ...HOST, origin }, payload: govde });
      expect(r.statusCode, origin).toBe(403);
    }
    const ok = await app.inject({ method: "POST", url: "/api/fikirler", headers: { ...HOST, origin: "http://127.0.0.1:8765" }, payload: govde });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe("F-001");
  });

  it("fikir silinir: klasörü çöp kutusuna taşınır, numarası yeniden kullanılmaz; çalışan fikir silinmez", async () => {
    const acilan: string[] = [];
    const k = await kovanOlustur({ ayar: { ajan_sorulari: false }, klasorAcici: (y) => acilan.push(y) });
    const post = (url: string, payload: object = {}) => k.app.inject({ method: "POST", url, headers: HOST, payload });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    // Çalışırken silinmez
    expect((await post(`/api/fikirler/${fid}/sil`)).statusCode).toBe(409);
    await bekle(k, fid, bekliyor("insan"));

    // Klasör: detayda yol var; kod/ dosya yöneticisinde açılır, yalnızca izinli alt klasör
    const d = (await k.app.inject({ url: `/api/fikirler/${fid}`, headers: HOST })).json();
    expect(d.klasor).toBe(path.join(k.kok, "calisma", fid));
    expect((await post(`/api/fikirler/${fid}/klasor-ac`, { alt: "kod" })).json().yol).toBe(path.join(k.kok, "calisma", fid, "kod"));
    expect(acilan).toEqual([path.join(k.kok, "calisma", fid, "kod")]);
    expect((await post(`/api/fikirler/${fid}/klasor-ac`, { alt: "../.." })).statusCode).toBe(400);
    expect((await post("/api/fikirler/F-999/klasor-ac")).statusCode).toBe(404);
    // Başka kökenden silinemez
    expect((await k.app.inject({ method: "POST", url: `/api/fikirler/${fid}/sil`, headers: { ...HOST, origin: "https://kotu.example" } })).statusCode).toBe(403);

    const r = await post(`/api/fikirler/${fid}/sil`);
    expect(r.statusCode).toBe(200);
    expect(r.json().cop).toMatch(new RegExp(`calisma/\\.cop/${fid}-\\d{14}$`));
    expect(fs.existsSync(path.join(r.json().cop, ".kovan", "fikir.json"))).toBe(true);
    expect(fs.existsSync(path.join(k.kok, "calisma", fid))).toBe(false);
    expect((await k.app.inject({ url: "/api/fikirler", headers: HOST })).json()).toEqual([]);
    expect((await k.app.inject({ url: `/api/fikirler/${fid}`, headers: HOST })).statusCode).toBe(404);
    expect((await post(`/api/fikirler/${fid}/sil`)).statusCode).toBe(404);
    // Yeni fikir silinenin numarasını almaz
    expect(await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme")).toBe("F-002");
  });

  it("kaynak yolu seçim penceresinden gelir; iptal boş liste, başka kökenden istek reddedilir", async () => {
    const istenen: string[] = [];
    let cevap: string[] | null = ["/Users/sen/eski/gunsonu", "/Users/sen/analiz.docx"];
    const k = await kovanOlustur({ yolSecici: async (tur) => { istenen.push(tur); return cevap; } });
    const sec = (payload: object, origin?: string) => k.app.inject({ method: "POST", url: "/api/yol-sec", headers: { ...HOST, ...(origin ? { origin } : {}) }, payload });
    expect((await sec({ tur: "klasor" })).json()).toEqual({ yollar: ["/Users/sen/eski/gunsonu", "/Users/sen/analiz.docx"] });
    cevap = null;
    expect((await sec({ tur: "dosya" })).json()).toEqual({ yollar: [] });
    expect((await sec({ tur: "uydurma" })).statusCode).toBe(200);
    expect(istenen).toEqual(["klasor", "dosya", "klasor"]);
    expect((await sec({ tur: "klasor" }, "https://kotu.example")).statusCode).toBe(403);
    expect(istenen).toHaveLength(3);
  });

  it("anlaşılır 400/404 hataları döner", async () => {
    const { app } = await kovanOlustur();
    const bos = await app.inject({ method: "POST", url: "/api/fikirler", headers: HOST, payload: { metin: "  ", profil: "mini", motor: "deneme" } });
    expect(bos.statusCode).toBe(400);
    expect(bos.json().detail).toBe("Fikir metni boş olamaz.");
    const akis = await app.inject({ method: "POST", url: "/api/fikirler", headers: HOST, payload: { metin: "x", profil: "yok", motor: "deneme" } });
    expect(akis.json().detail).toMatch(/Bilinmeyen akış/);
    expect((await app.inject({ url: "/api/fikirler/F-999", headers: HOST })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/yok", headers: HOST })).statusCode).toBe(404);
  });

  it("dosya ve önizleme fikrin klasöründen çıkamaz; önizleme sandbox'ta açılır", async () => {
    const k = await kovanOlustur({ ayar: { ajan_sorulari: false } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    await bekle(k, fid, bekliyor("insan"));
    const al = (url: string, ek: Record<string, string> = {}) => k.app.inject({ url, headers: { ...HOST, ...ek } });

    const fikir = await al(`/api/fikirler/${fid}/dosya?yol=belgeler/fikir.md`);
    expect(fikir.json().icerik).toContain("Flora AI");
    expect((await al(`/api/fikirler/${fid}/dosya?yol=../../package.json`)).statusCode).toBe(403);
    expect((await al(`/api/fikirler/${fid}/dosya?yol=belgeler/yok.md`)).statusCode).toBe(404);
    expect((await al(`/onizle/${fid}/belgeler/fikir.md`)).statusCode).toBe(403);           // yalnızca kod/
    expect((await al(`/onizle/${fid}/kod/../belgeler/fikir.md`)).statusCode).toBe(403);

    const betik = await al(`/onizle/${fid}/kod/testler/be/sulama.test.mjs`);
    expect(betik.statusCode).toBe(200);
    expect(betik.headers["content-security-policy"]).toMatch(/^sandbox allow-scripts/);
    expect(betik.headers["content-type"]).toMatch(/text\/javascript/);
    expect(betik.headers["access-control-allow-origin"]).toBeUndefined();
    // Sandbox'taki sayfanın modül betikleri (köken "null") yüklenebilsin; başka hiçbir istek için izin yok
    const modul = await al(`/onizle/${fid}/kod/testler/be/sulama.test.mjs`, { origin: "null", "sec-fetch-dest": "script" });
    expect(modul.headers["access-control-allow-origin"]).toBe("null");
    const fetchIle = await al(`/onizle/${fid}/kod/testler/be/sulama.test.mjs`, { origin: "null", "sec-fetch-dest": "empty" });
    expect(fetchIle.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("arayüz derlenmemişse yol gösterir; güvenlik başlıkları vardır", async () => {
    const { app } = await kovanOlustur();
    const r = await app.inject({ url: "/", headers: HOST });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("npm run build");
    expect(r.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
  });

  it("soruyu ve kararı HTTP üzerinden alır", async () => {
    const k = await kovanOlustur();
    const post = (url: string, payload: unknown) => k.app.inject({ method: "POST", url, headers: { ...HOST, origin: "http://127.0.0.1:8765" }, payload: payload as object });
    const fid = (await post("/api/fikirler", { metin: ORNEK_MINI, profil: "mini", motor: "deneme" })).json().id;
    await bekle(k, fid, bekliyor("ajan_sorusu"));

    const detay = (await k.app.inject({ url: `/api/fikirler/${fid}`, headers: HOST })).json();
    expect(detay.bekleme.sorular[0].baslik).toBe("Arayüz dili");
    expect((await post(`/api/fikirler/${fid}/cevap`, {})).statusCode).toBe(400);
    expect((await post(`/api/fikirler/${fid}/karar`, { secim: "kabul" })).json().detail).toMatch(/ajan sorusu/);
    expect((await post(`/api/fikirler/${fid}/cevap`, { cevaplar: [{ secilenler: ["İngilizce"] }] })).statusCode).toBe(200);
    await bekle(k, fid, bekliyor("insan"));
    expect((await post(`/api/fikirler/${fid}/karar`, { secim: "uydurma" })).statusCode).toBe(400);
    expect((await post(`/api/fikirler/${fid}/karar`, { secim: "kabul", not: "tamam" })).statusCode).toBe(200);
    await bekle(k, fid, (f) => f.durum === "tamamlandi");
    const liste = (await k.app.inject({ url: "/api/fikirler", headers: HOST })).json();
    expect(liste[0]).toMatchObject({ id: fid, durum: "tamamlandi", akis_ad: "Mini" });
  });
});

describe("Replatform uç noktaları", () => {
  it("kaynakları satır satır alır; örnek kaynağı ve hedef yığınları bildirir; kaynak dosyaları okunur", async () => {
    const k = await kovanOlustur();
    const post = (payload: object) => k.app.inject({ method: "POST", url: "/api/fikirler", headers: HOST, payload });
    const durum = (await k.app.inject({ url: "/api/durum", headers: HOST })).json();
    expect(durum.hedef_yiginlar.map((h: { id: string }) => h.id)).toEqual(["node-ts", "java21-spring-maven", "java25-spring-maven", "java21-temporal", "java17-spring-batch", "java17-spring-rest"]);
    expect(durum.yerel_motor).toBe("qwen-yerel");
    expect(durum.ornek_kaynak).toBeNull();                        // geçici kökte ornekler/ yok
    const akislar = (await k.app.inject({ url: "/api/akislar", headers: HOST })).json();
    expect(akislar.map((a: { id: string }) => a.id).at(-1)).toBe("replatform");
    const ilkAsama = akislar.at(-1).asamalar[0];
    expect([ilkAsama.salt_okunur, ilkAsama.dogrulama.map((d: { tip: string }) => d.tip)]).toEqual([true, ["atif", "ajan", "ajan", "ajan"]]);

    const ornek = path.join(KOK, "ornekler", "reeskont-eski");
    const yanlis = await post({ metin: ORNEK_MINI, profil: "mini", motor: "deneme", kaynaklar: ornek });
    expect(yanlis.statusCode).toBe(400);
    expect(yanlis.json().detail).toMatch(/mevcut sistem kaynağı almaz/);
    const r = await post({ metin: "Kart reeskont gün sonunu yeniden yaz.", profil: "replatform", motor: "deneme",
      kaynaklar: `\n${ornek}\n  \n`, hedef_yigin: "java21-spring-maven" });
    expect(r.statusCode).toBe(200);
    const fid = r.json().id;
    const detay = (await k.app.inject({ url: `/api/fikirler/${fid}`, headers: HOST })).json();
    expect(detay.fikir.kaynak.yollar).toEqual([ornek]);
    expect(detay.kararlar[0].cevap).toMatch(/^Java 21 \+ Spring Boot \(Maven\)/);
    const pkb = await k.app.inject({ url: `/api/fikirler/${fid}/dosya?yol=kod/kaynak/reeskont-eski/KART_REESKONT_GUNSONU.pkb`, headers: HOST });
    expect(pkb.json().icerik).toContain("c_gun_esasi    CONSTANT NUMBER       := 365;");
    const docx = await k.app.inject({ url: `/api/fikirler/${fid}/dosya?yol=kod/kaynak/reeskont-eski/analiz.docx`, headers: HOST });
    expect(docx.json().icerik).toBe("(ikili dosya, gösterilemiyor)");
    const onizleme = await k.app.inject({ url: `/onizle/${fid}/kod/kaynak/reeskont-eski/analiz.docx.html`, headers: HOST });
    expect(onizleme.headers["content-security-policy"]).toMatch(/^sandbox/);
    await k.ork.kapat();
  });
});

describe("Cevap doğrulama", () => {
  it("her soru cevaplanmalı; tek seçimlik soruda tek seçenek; cevap yokken hata", async () => {
    const k = await kovanOlustur();
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    expect(() => k.ork.cevapla(fid, [{ secilenler: ["Türkçe"] }])).toThrow(/sorusu beklemiyor/);
    await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(() => k.ork.cevapla(fid, [])).toThrow(/Her soruya/);
    expect(() => k.ork.cevapla(fid, [{ secilenler: [], serbest: "  " }])).toThrow(/sorusunu cevapla/);
    expect(() => k.ork.cevapla(fid, [{ secilenler: ["Türkçe", "İngilizce"] }])).toThrow(/tek seçenek/);
    k.ork.cevapla(fid, [{ secilenler: ["Türkçe (Önerilen)"] }]);   // işaret temizlenir
    await bekle(k, fid, bekliyor("insan"));
    expect(k.ork.kararlar(fid)[0].cevap).toBe("Türkçe");
  });

  it("soru hakkı dolunca ajana varsayımla devam etmesi söylenir", async () => {
    const k = await kovanOlustur({ ayar: { en_fazla_soru_turu: 0 } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    await bekle(k, fid, bekliyor("insan"));            // PO sormadı
    const ilk = k.ork.fikirDetayi(fid).adimlar.find((a) => a.tip === "uret")!;
    expect(ilk.durum).toBe("tamam");
    const gunluk = (await import("node:fs")).readFileSync(`${k.calisma}/${fid}/gunluk/adim-${ilk.id}.json`, "utf8");
    expect(JSON.parse(gunluk).sistem).toContain("soru hakkın doldu");
  });
});
