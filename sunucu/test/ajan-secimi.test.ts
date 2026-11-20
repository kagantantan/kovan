// Ajanlar ekranı: her ajanın motoru ve modeli kullanıcı tarafından seçilir; Hibrit modda ajan çağrıları bu seçimle yapılır.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bekle, geciciKok, kovanOlustur, ORNEK_MINI } from "./yardimci/ortam.js";

const HOST = { host: "127.0.0.1:8765" };

describe("Ajan başına motor ve model", () => {
  it("seçim kaydedilir, dosyaya yazılır, Hibrit modda kullanılır; varsayılana dönülebilir", async () => {
    const dosya = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kovan-secim-")), "ajan-secimleri.json");
    const k = await kovanOlustur({ ajan_secimleri: dosya, ayar: { ajan_sorulari: false } });
    const post = (url: string, payload: object = {}) => k.app.inject({ method: "POST", url, headers: HOST, payload });
    const ajan = async (id: string) => (await k.app.inject({ url: "/api/ajanlar", headers: HOST })).json().find((a: { id: string }) => a.id === id);

    expect((await ajan("urun-sahibi")).secim).toBeNull();
    // Ürün Sahibi yerel motorda, belirli bir modelle
    expect((await post("/api/ajanlar/urun-sahibi/secim", { motor: "qwen-yerel", model: "qwen3:8b" })).statusCode).toBe(200);
    expect(await ajan("urun-sahibi")).toMatchObject({ motor: "qwen-yerel", secim: { motor: "qwen-yerel", model: "qwen3:8b" }, motor_yerel: true });
    // Mimar Claude'da opus ile
    await post("/api/ajanlar/mimar/secim", { motor: "claude", model: "opus" });
    expect(await ajan("mimar")).toMatchObject({ motor: "claude", model: "opus" });
    expect(JSON.parse(fs.readFileSync(dosya, "utf8"))).toEqual({
      "urun-sahibi": { motor: "qwen-yerel", model: "qwen3:8b" }, mimar: { motor: "claude", model: "opus" },
    });

    // Hibrit modda Ürün Sahibi'nin çağrısı seçilen motor ve modelle yapılır
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "hibrit");
    await bekle(k, fid, (f) => f.durum === "bekliyor" || f.durum === "tamamlandi");
    const po = k.ork.fikirDetayi(fid).adimlar.find((a) => a.ajan === "urun-sahibi" && a.tip === "uret")!;
    expect([po.motor, po.model]).toEqual(["qwen-yerel", "qwen3:8b"]);

    // Geçersiz seçimler
    expect((await post("/api/ajanlar/mimar/secim", { motor: "yok", model: "x" })).json().detail).toMatch(/'yok' diye bir motor yok/);
    expect((await post("/api/ajanlar/mimar/secim", { motor: "deneme", model: "x" })).statusCode).toBe(400);
    expect((await post("/api/ajanlar/mimar/secim", { motor: "claude", model: "a b; rm" })).json().detail).toMatch(/Geçersiz model adı/);
    expect((await post("/api/ajanlar/yok/secim", { motor: "claude", model: "opus" })).statusCode).toBe(404);
    expect((await k.app.inject({ method: "POST", url: "/api/ajanlar/mimar/secim", headers: { ...HOST, origin: "https://kotu.example" }, payload: { motor: "claude", model: "opus" } })).statusCode).toBe(403);

    // Varsayılana dön: kartın değerleri geri gelir
    await post("/api/ajanlar/urun-sahibi/secim-sil");
    expect(await ajan("urun-sahibi")).toMatchObject({ motor: "claude", secim: null });
    expect(Object.keys(JSON.parse(fs.readFileSync(dosya, "utf8")))).toEqual(["mimar"]);

    // Yeniden açılışta dosyadan okunur
    const k2 = await kovanOlustur({ ajan_secimleri: dosya });
    const mimar = (await k2.app.inject({ url: "/api/ajanlar", headers: HOST })).json().find((a: { id: string }) => a.id === "mimar");
    expect(mimar).toMatchObject({ motor: "claude", model: "opus", secim: { motor: "claude", model: "opus" } });
  });

  it("model önerileri: Claude takma adları ve yerel motor", async () => {
    const k = await kovanOlustur();
    const r = (await k.app.inject({ url: "/api/motorlar/modeller", headers: HOST })).json();
    expect(r.claude).toEqual(["sonnet", "opus", "haiku"]);
    expect(Object.keys(r)).not.toContain("deneme");
  });

  it("durmuş fikrin modu değiştirilir; çalışırken değiştirilemez; kapalı mod reddedilir", async () => {
    const k = await kovanOlustur({ ayar: { ajan_sorulari: false } });
    const post = (url: string, payload: object = {}) => k.app.inject({ method: "POST", url, headers: HOST, payload });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    expect((await post(`/api/fikirler/${fid}/mod`, { mod: "yerel" })).statusCode).toBe(409);
    await bekle(k, fid, (f) => f.durum === "bekliyor");
    expect((await post(`/api/fikirler/${fid}/mod`, { mod: "uydurma" })).statusCode).toBe(400);
    expect((await post(`/api/fikirler/${fid}/mod`, { mod: "yerel" })).statusCode).toBe(200);
    expect(k.depo.fikir(fid)!.motor).toBe("yerel");
    expect(k.ork.fikirDetayi(fid).adimlar.at(-1)).toMatchObject({ ajan_ad: "Mod değişti", ozet: "deneme → yerel. Sonraki ajan çağrıları yeni modda." });
    const kapali = await kovanOlustur({ ayar: { modlar: ["claude", "deneme"] } });
    const f2 = await kapali.ork.yeniFikir("", ORNEK_MINI, "mini", "deneme");
    await bekle(kapali, f2, (f) => f.durum === "bekliyor");
    expect(() => kapali.ork.modDegistir(f2, "yerel")).toThrow(/'yerel' modu bu kurulumda kapalı/);
  });

  it("inceleme ve oylar Claude'da ayrı (ucuz) modelle; üretim ajanın kendi modelinde kalır; seçim dosyaya yazılır", async () => {
    const dosya = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kovan-secim-")), "ajan-secimleri.json");
    const AKIS = "ad: Kısa\naciklama: Test.\nfikir_butcesi_usd: 5\nasamalar:\n  - id: analiz\n    ad: Analiz\n    ajan: analist\n    gorev: Analiz yaz.\n" +
      "    girdiler: [fikir]\n    cikti: analiz\n    dogrulama:\n      - ad: Mimari\n        inceleyen: mimar\n  - id: kabul\n    ad: Kabul\n    tur: insan\n    soru: Tamam mı?\n";
    const k = await kovanOlustur({ ajan_secimleri: dosya, kok: geciciKok({ kisa: AKIS }), ayar: { ajan_sorulari: false } });
    const post = (url: string, payload: object = {}) => k.app.inject({ method: "POST", url, headers: HOST, payload });
    expect((await post("/api/inceleme-modeli", { model: "a b" })).statusCode).toBe(400);
    expect((await post("/api/inceleme-modeli", { model: "haiku" })).json()).toEqual({ ok: true, model: "haiku" });
    expect((await k.app.inject({ url: "/api/durum", headers: HOST })).json().claude_inceleme_modeli).toBe("haiku");
    expect(JSON.parse(fs.readFileSync(dosya, "utf8"))._genel).toEqual({ motor: "claude", model: "haiku" });
    expect((await k.app.inject({ url: "/api/ajanlar", headers: HOST })).json().map((a: { id: string }) => a.id)).not.toContain("_genel");

    // Hepsi Claude: analizi Analist kendi modeliyle (sonnet) yazar, Mimar haiku ile inceler
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa", "claude");
    await bekle(k, fid, (f) => f.durum === "bekliyor");
    const adimlar = k.ork.fikirDetayi(fid).adimlar.filter((a) => a.motor === "claude");
    expect(new Set(adimlar.filter((a) => a.tip === "uret").map((a) => a.model))).toEqual(new Set(["sonnet"]));
    const incelemeler = adimlar.filter((a) => a.tip === "inceleme");
    expect(incelemeler.length).toBeGreaterThan(0);
    expect(new Set(incelemeler.map((a) => `${a.ajan}:${a.model}`))).toEqual(new Set(["mimar:haiku"]));

    // Yeniden açılışta dosyadan; boş seçim kapatır
    const k2 = await kovanOlustur({ ajan_secimleri: dosya });
    expect((await k2.app.inject({ url: "/api/durum", headers: HOST })).json().claude_inceleme_modeli).toBe("haiku");
    await k2.app.inject({ method: "POST", url: "/api/inceleme-modeli", headers: HOST, payload: { model: "" } });
    expect(JSON.parse(fs.readFileSync(dosya, "utf8"))._genel).toBeUndefined();
  });
});
