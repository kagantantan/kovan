// Motorlar: sahte `claude` komutuyla bayraklar, ortam temizliği, sonuç okuma, kalıcı/geçici hatalar,
// süre sınırı; sahte Ollama sunucusuyla yerel motorun sağlık denetimi ve ortamı; soru bloğu ayrıştırma.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClaudeMotoru, jsonCikar, KARAR_SEMASI, OllamaMotoru, soruCikar, sorulariDogrula, type AjanCagrisi } from "../src/motor.js";

const SAHTE = path.join(path.dirname(fileURLToPath(import.meta.url)), "yardimci", "sahte-claude.mjs");
const dizin = fs.mkdtempSync(path.join(os.tmpdir(), "kovan-motor-"));
const kayit = path.join(dizin, "kayit.jsonl");
fs.chmodSync(SAHTE, 0o755);

function cagri(ek: Partial<AjanCagrisi> = {}): AjanCagrisi {
  return {
    rol: "analist", asama_id: "analiz", gorev_turu: "uret", sistem: "SİSTEM İSTEMİ", istem: "SENARYO:tamam", model: "sonnet",
    araclar: [], izinli: [], cwd: dizin, sure_sn: 20, sistem_modu: "degistir", butce_usd: 1.5, sema: null, efor: null, ...ek,
  };
}

interface Kayit { args: string[]; env: Record<string, string | null>; istem: string }
const sonKayit = (): Kayit => JSON.parse(fs.readFileSync(kayit, "utf8").trim().split("\n").at(-1)!);
const sonraki = (args: string[], bayrak: string) => args[args.indexOf(bayrak) + 1];

const ESKI_ORTAM = { ...process.env };
beforeEach(() => { process.env.SAHTE_KAYIT = kayit; });
afterEach(() => {
  for (const ad of Object.keys(process.env)) if (!(ad in ESKI_ORTAM)) delete process.env[ad];
  Object.assign(process.env, ESKI_ORTAM);
});

describe("Claude motoru", () => {
  it("sürümü ve desteklenen bayrakları algılar", () => {
    const m = new ClaudeMotoru(SAHTE, true);
    expect(m.hazir).toBe(true);
    expect(m.surum).toBe("9.9.9 (Claude Code)");
    expect(m.var("--json-schema")).toBe(true);
    expect(m.var("--permission-prompts")).toBe(false);
  });

  it("bulunamayan komutta anlaşılır hata verir", () => {
    const m = new ClaudeMotoru(path.join(dizin, "yok", "claude"), true);
    expect(m.hazir).toBe(false);
    expect(m.hata).toMatch(/claude komutu bulunamadı/);
  });

  it("Claude ajanlarında yönlendirme değişkenlerini temizler (Ollama rehberlerinden kalanlar dahil)", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:11434";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "ollama";
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "qwen3-coder:30b";
    await new ClaudeMotoru(SAHTE, true).calistir(cagri());
    const temiz = sonKayit().env;
    expect([temiz.ANTHROPIC_BASE_URL, temiz.ANTHROPIC_API_KEY, temiz.ANTHROPIC_AUTH_TOKEN, temiz.ANTHROPIC_DEFAULT_SONNET_MODEL]).toEqual([null, null, null, null]);

    await new ClaudeMotoru(SAHTE, false).calistir(cagri());
    expect(sonKayit().env.ANTHROPIC_API_KEY).toBe("sk-test");          // ayar kapalıysa dokunmaz
  });

  it("inceleme: araç yok, şema var; üretim: araçlar, izinli komutlar, düzenleme izni, efor", async () => {
    const m = new ClaudeMotoru(SAHTE, true);
    await m.calistir(cagri({ gorev_turu: "inceleme", sema: KARAR_SEMASI }));
    let a = sonKayit().args;
    expect(sonraki(a, "--system-prompt")).toBe("SİSTEM İSTEMİ");
    expect(sonraki(a, "--tools")).toBe("");
    expect(JSON.parse(sonraki(a, "--json-schema")).properties.karar.enum).toEqual(["ONAY", "DUZELT", "SORU"]);
    expect(sonraki(a, "--max-budget-usd")).toBe("1.50");
    expect(a).not.toContain("--permission-mode");

    await m.calistir(cagri({
      araclar: ["Read", "Write", "Bash"], izinli: ["Bash(npm --prefix backend *)", "Bash(bash test-be.sh)"],
      sistem_modu: "ekle", efor: "high",
    }));
    a = sonKayit().args;
    expect(sonraki(a, "--append-system-prompt")).toBe("SİSTEM İSTEMİ");
    expect(sonraki(a, "--tools")).toBe("Read,Write,Bash");
    expect(a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--allowedTools") + 3)).toEqual(["Bash(npm --prefix backend *)", "Bash(bash test-be.sh)"]);
    expect(sonraki(a, "--permission-mode")).toBe("acceptEdits");
    expect(sonraki(a, "--effort")).toBe("high");
    expect(a).toContain("--no-session-persistence");
  });

  it("sonucu okur: metin, maliyet, token, tur, izin retleri", async () => {
    const s = await new ClaudeMotoru(SAHTE, true).calistir(cagri());
    expect(s).toMatchObject({ ok: true, metin: "İş tamam.", maliyet: 0.0123, girdi_token: 150, cikti_token: 20, tur_sayisi: 3 });
    expect(s.izin_retleri).toEqual(["Bash(curl https://ornek.invalid)"]);
  });

  it("yapısal çıktıyı ve metindeki JSON kararı okur", async () => {
    const s = await new ClaudeMotoru(SAHTE, true).calistir(cagri({ gorev_turu: "inceleme", sema: KARAR_SEMASI, istem: "SENARYO:yapisal" }));
    expect(s.yapisal).toMatchObject({ karar: "SORU" });
    const m = await new ClaudeMotoru(SAHTE, true).calistir(cagri({ istem: "SENARYO:metinden" }));
    expect(jsonCikar(m.metin)).toEqual({ karar: "DUZELT", gerekce: "eksik", bulgular: ["K2 yok"] });
  });

  it("oturum ve bütçe hataları kalıcı, yoğunluk geçici; bozuk çıktı açıklanır", async () => {
    const m = new ClaudeMotoru(SAHTE, true);
    const giris = await m.calistir(cagri({ istem: "SENARYO:giris" }));
    expect(giris).toMatchObject({ ok: false, kalici_hata: true });
    expect(giris.hata).toMatch(/oturumu açık değil/);
    const yogun = await m.calistir(cagri({ istem: "SENARYO:yogun" }));
    expect(yogun).toMatchObject({ ok: false, kalici_hata: false });
    expect(yogun.hata).toMatch(/yoğunluk/);
    const butce = await m.calistir(cagri({ istem: "SENARYO:butce" }));
    expect(butce).toMatchObject({ ok: false, kalici_hata: true });
    expect(butce.hata).toMatch(/Adım bütçesi/);
    const bozuk = await m.calistir(cagri({ istem: "SENARYO:bozuk" }));
    expect(bozuk.ok).toBe(false);
    expect(bozuk.hata).toMatch(/okunamadı \(çıkış kodu 2\)/);
  });

  it("süre sınırında süreci durdurur", async () => {
    const t0 = Date.now();
    const s = await new ClaudeMotoru(SAHTE, true).calistir(cagri({ istem: "SENARYO:uyku", sure_sn: 1 }));
    expect(s.zaman_asimi).toBe(true);
    expect(s.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});

describe("Yerel motor (Ollama)", () => {
  const durum = { surum: "0.15.2", modeller: ["qwen3-coder:30b"] };
  let sunucu: http.Server;
  let adres = "";
  beforeAll(async () => {
    sunucu = http.createServer((istek, yanit) => {
      yanit.setHeader("content-type", "application/json");
      if (istek.url === "/api/version") yanit.end(JSON.stringify({ version: durum.surum }));
      else if (istek.url === "/api/tags") yanit.end(JSON.stringify({ models: durum.modeller.map((name) => ({ name, model: name })) }));
      else { yanit.statusCode = 404; yanit.end("{}"); }
    });
    await new Promise<void>((r) => sunucu.listen(0, "127.0.0.1", () => r()));
    adres = `http://127.0.0.1:${(sunucu.address() as { port: number }).port}`;
  });
  afterAll(() => { sunucu.close(); });

  it("sağlık denetimi: sürüm ve model", async () => {
    const m = new OllamaMotoru("qwen-yerel", adres, "qwen3-coder:30b", SAHTE);
    expect(await m.saglik(true)).toBe(true);
    expect(m.ollamaSurum).toBe("0.15.2");

    durum.surum = "0.13.5";
    expect(await m.saglik(true)).toBe(false);
    expect(m.hata).toMatch(/eski/);

    durum.surum = "0.15.2";
    durum.modeller = ["llama3:8b"];
    expect(await m.saglik(true)).toBe(false);
    expect(m.hata).toMatch(/ollama pull qwen3-coder:30b/);
    durum.modeller = ["qwen3-coder:30b"];

    const kapali = new OllamaMotoru("qwen-yerel", "http://127.0.0.1:9", "qwen3-coder:30b", SAHTE);
    expect(await kapali.saglik(true)).toBe(false);
    expect(kapali.hata).toMatch(/ulaşılamadı/);
  });

  it("yerel çağrı Ollama'ya yönlenir; $ bütçe, efor ve şema bayrağı gönderilmez; maliyet sıfır", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-gercek";
    const m = new OllamaMotoru("qwen-yerel", adres, "qwen3-coder:30b", SAHTE);
    const s = await m.calistir(cagri({ gorev_turu: "inceleme", sema: KARAR_SEMASI, efor: "high", model: "qwen3-coder:30b" }));
    const k = sonKayit();
    expect(k.env).toMatchObject({
      ANTHROPIC_BASE_URL: adres, ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3-coder:30b", CLAUDE_CODE_SUBAGENT_MODEL: "qwen3-coder:30b",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(k.args).not.toContain("--max-budget-usd");
    expect(k.args).not.toContain("--effort");
    expect(k.args).not.toContain("--json-schema");
    expect(k.istem).toContain("Yanıtının EN SONUNA");        // şema yerine metin talimatı
    expect(s.maliyet).toBe(0);
  });
});

describe("Soru bloğu", () => {
  const blok = (v: unknown) => `Önce sormam gerek.\n\n\`\`\`kovan-soru\n${JSON.stringify(v)}\n\`\`\``;

  it("geçerli bloğu okur, başlığı kısaltır, fazla soru ve seçeneği kırpar", () => {
    const secenekler = ["A (Önerilen)", "B", "C", "D", "E"].map((etiket) => ({ etiket, aciklama: `${etiket} açıklaması` }));
    const s = soruCikar(blok({ sorular: [1, 2, 3, 4].map((i) => ({ baslik: `Çok uzun bir başlık numarası ${i}`, soru: `Soru ${i}?`, secenekler })) }));
    expect(s?.sorular).toHaveLength(3);
    expect(s!.sorular![0].baslik.length).toBeLessThanOrEqual(24);
    expect(s!.sorular![0].secenekler).toHaveLength(4);
    expect(s!.sorular![0].coklu).toBe(false);
  });

  it("blok yoksa null, bozuksa hata", () => {
    expect(soruCikar("Normal bir brif.")).toBeNull();
    expect(soruCikar("```kovan-soru\n{bozuk\n```")?.hata).toMatch(/JSON/);
    expect(soruCikar(blok({ sorular: [{ soru: "Tek seçenek?", secenekler: [{ etiket: "A" }] }] }))?.hata).toMatch(/en az 2 seçenek/);
    expect(sorulariDogrula([])).toEqual({ hata: "soru listesi boş" });
  });
});
