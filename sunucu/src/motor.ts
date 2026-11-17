// Motorlar: ajan çağrısını gerçekten çalıştıran katman.
//   ClaudeMotoru : `claude -p` (Claude Code headless), Claude aboneliğinle
//   OllamaMotoru : aynı harness, model Ollama'da (Anthropic uyumlu API, Ollama 0.14+)
//   DenemeMotoru : token harcamadan akışı gösteren sahte motor
// Yeni bir motor eklemek için Motor arayüzünü uygulamak yeter.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AjanKarti } from "./kartlar.js";
import type { MotorDurumu } from "./tipler.js";
import { bekle, kisalt } from "./ortak.js";

// ----------------------------------------------------------------------------------------
// Sözleşmeler
// ----------------------------------------------------------------------------------------
export interface AjanCagrisi {
  rol: string;
  asama_id: string;
  gorev_turu: "uret" | "inceleme";
  sistem: string;
  istem: string;
  model: string;
  araclar: string[];
  izinli: string[];
  cwd: string;
  sure_sn: number;
  sistem_modu: "degistir" | "ekle";
  butce_usd: number | null;
  sema: object | null;
  efor: string | null;
  surecCb?: (p: ChildProcess, bitti: boolean) => void;
}

export interface AjanSonucu {
  ok: boolean;
  metin: string;
  yapisal: Record<string, unknown> | null;
  maliyet: number;
  girdi_token: number;
  cikti_token: number;
  tur_sayisi: number;
  sure_sn: number;
  hata: string | null;
  zaman_asimi: boolean;
  ham: string;
  izin_retleri: string[];
  kalici_hata: boolean;   // oturum yok, limit doldu, Ollama kapalı: hemen tekrar denemenin anlamı yok
}

export function sonuc(alanlar: Partial<AjanSonucu>): AjanSonucu {
  return {
    ok: false, metin: "", yapisal: null, maliyet: 0, girdi_token: 0, cikti_token: 0, tur_sayisi: 0,
    sure_sn: 0, hata: null, zaman_asimi: false, ham: "", izin_retleri: [], kalici_hata: false, ...alanlar,
  };
}

export type { MotorDurumu };

export interface Motor {
  readonly ad: string;
  readonly tur: "claude" | "ollama" | "deneme";
  readonly yerel: boolean;
  hazir: boolean;
  hata: string | null;
  surum: string;
  saglik(zorla?: boolean): Promise<boolean>;
  modelSec(kart: AjanKarti): string;
  calistir(c: AjanCagrisi): Promise<AjanSonucu>;
  durumOzeti(): Promise<MotorDurumu>;
  komut?(c: AjanCagrisi): string[];
}

// ----------------------------------------------------------------------------------------
// Onay kararı ve insana soru şemaları
// ----------------------------------------------------------------------------------------
const SORU_OGESI = {
  type: "object",
  properties: {
    baslik: { type: "string" },
    soru: { type: "string" },
    coklu: { type: "boolean" },
    secenekler: {
      type: "array", minItems: 2, maxItems: 4,
      items: {
        type: "object",
        properties: { etiket: { type: "string" }, aciklama: { type: "string" } },
        required: ["etiket", "aciklama"], additionalProperties: false,
      },
    },
  },
  required: ["baslik", "soru", "secenekler"],
  additionalProperties: false,
};

export const KARAR_SEMASI = {
  type: "object",
  properties: {
    karar: { type: "string", enum: ["ONAY", "DUZELT", "SORU"] },
    gerekce: { type: "string" },
    bulgular: { type: "array", items: { type: "string" } },
    sorular: { type: "array", maxItems: 3, items: SORU_OGESI },
  },
  required: ["karar", "gerekce", "bulgular"],
  additionalProperties: false,
};

const YEDEK_JSON_TALIMATI =
  '\n\nYanıtının EN SONUNA yalnızca şu biçimde bir JSON bloğu koy:\n```json\n{"karar": "ONAY" | "DUZELT" | "SORU", "gerekce": "...", "bulgular": ["..."], "sorular": []}\n```';

export interface HamSoru {
  baslik: string;
  soru: string;
  coklu: boolean;
  secenekler: { etiket: string; aciklama: string }[];
}

/** Soru listesini doğrular ve normalleştirir. Geçersizse hata mesajı döner. */
export function sorulariDogrula(ham: unknown): { sorular?: HamSoru[]; hata?: string } {
  const liste = Array.isArray(ham) ? ham : (ham as { sorular?: unknown })?.sorular;
  if (!Array.isArray(liste) || !liste.length) return { hata: "soru listesi boş" };
  const sorular: HamSoru[] = [];
  for (const s of liste.slice(0, 3)) {
    const soru = String(s?.soru ?? "").trim();
    const secenekler = (Array.isArray(s?.secenekler) ? s.secenekler : [])
      .map((o: { etiket?: unknown; aciklama?: unknown }) => ({ etiket: String(o?.etiket ?? "").trim(), aciklama: String(o?.aciklama ?? "").trim() }))
      .filter((o: { etiket: string }) => o.etiket)
      .slice(0, 4);
    if (!soru || secenekler.length < 2) return { hata: "her soruda metin ve en az 2 seçenek olmalı" };
    sorular.push({ soru, baslik: kisalt(String(s?.baslik ?? "") || soru, 24), coklu: Boolean(s?.coklu), secenekler });
  }
  return { sorular };
}

/** Üretici ajanın çıktısındaki ```kovan-soru``` bloğunu bulur. Blok yoksa null. */
export function soruCikar(metin: string): { sorular?: HamSoru[]; hata?: string } | null {
  const m = /```kovan-soru\s*\n([\s\S]*?)```/.exec(metin ?? "");
  if (!m) return null;
  try {
    return sorulariDogrula(JSON.parse(m[1]));
  } catch {
    return { hata: "kovan-soru bloğu JSON olarak okunamadı" };
  }
}

/** Serbest metnin içinden 'karar' içeren son JSON nesnesini bulur. */
export function jsonCikar(metin: string): Record<string, unknown> | null {
  if (!metin) return null;
  const adaylar: string[] = [...metin.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]).reverse();
  if (!adaylar.length) {
    let derinlik = 0;
    let son: number | null = null;
    for (let i = metin.length - 1; i >= 0; i--) {
      const c = metin[i];
      if (c === "}") { if (derinlik === 0) son = i; derinlik++; }
      else if (c === "{" && derinlik) {
        derinlik--;
        if (derinlik === 0 && son !== null) { adaylar.push(metin.slice(i, son + 1)); son = null; }
      }
    }
  }
  for (const a of adaylar) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === "object" && "karar" in v) return v;
    } catch { /* sonraki aday */ }
  }
  return null;
}

/** Süreci ve açtığı alt süreçleri (aynı süreç grubu) kapatır. */
export function sureciOldur(p: ChildProcess): void {
  if (!p.pid || p.exitCode !== null) return;
  try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch { /* zaten bitmiş */ } }
  setTimeout(() => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* zaten bitmiş */ } }, 5000).unref();
}

// ----------------------------------------------------------------------------------------
// Hata sınıflandırma
// ----------------------------------------------------------------------------------------
function dostcaHata(metin: string): { mesaj: string; kalici: boolean } | null {
  const k = (metin ?? "").toLowerCase();
  if (["please run /login", "not logged in", "invalid api key", "authentication", "oauth"].some((s) => k.includes(s)))
    return { mesaj: "claude oturumu açık değil. Terminal'de bir kez `claude` yazıp giriş yap, sonra 'Tekrar dene'.", kalici: true };
  if (["usage limit", "limit reached", "credit balance"].some((s) => k.includes(s)))
    return { mesaj: "Abonelik kullanım limitine takıldı. Limit sıfırlanınca 'Tekrar dene'.", kalici: true };
  if (["rate limit", "rate_limit", "overloaded"].some((s) => k.includes(s)))
    return { mesaj: "Anlık yoğunluk/hız limiti. Kısa bir süre sonra tekrar denenecek.", kalici: false };
  return null;
}

function izinRetleri(veri: Record<string, unknown>): string[] {
  const liste = Array.isArray(veri.permission_denials) ? veri.permission_denials : [];
  return liste.map((r: unknown) => {
    if (r && typeof r === "object") {
      const o = r as { tool_name?: string; tool_input?: Record<string, unknown> };
      const g = o.tool_input ?? {};
      const ayrinti = String(g.command ?? g.file_path ?? g.path ?? "");
      return `${o.tool_name ?? "?"}${ayrinti ? `(${kisalt(ayrinti, 80)})` : ""}`;
    }
    return kisalt(String(r), 80);
  });
}

// ----------------------------------------------------------------------------------------
// Claude (abonelik)
// ----------------------------------------------------------------------------------------
const YEDEK_YOLLAR = ["~/.claude/local/claude", "~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "~/.npm-global/bin/claude"];

// Claude Code'u başka sunucuya/anahtara yönlendiren değişkenler. Ollama rehberleri bunları ~/.zshrc'ye
// yazdırır; temizlenmezse "Claude" ajanları da sessizce yerel modele ya da ücretli API'ye giderdi.
const YONLENDIRME = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
];

const evYolu = (y: string) => (y.startsWith("~") ? path.join(os.homedir(), y.slice(1)) : y);

function claudeBul(yol: string): string | null {
  if (yol.includes("/") || yol.startsWith("~")) {
    const p = evYolu(yol);
    return fs.existsSync(p) ? p : null;
  }
  for (const dizin of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dizin, yol);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* sonraki */ }
  }
  for (const aday of YEDEK_YOLLAR) if (fs.existsSync(evYolu(aday))) return evYolu(aday);
  return null;
}

export class ClaudeMotoru implements Motor {
  ad = "claude";
  readonly tur: "claude" | "ollama" = "claude";
  readonly yerel: boolean = false;
  protected yapisalDestek = true;
  yol: string | null;
  yardim = "";
  surum = "";
  hazir = false;
  hata: string | null = null;

  constructor(yol = "claude", protected apiAnahtariniYoksay = true) {
    this.yol = claudeBul(yol);
    if (!this.yol) {
      this.hata = "claude komutu bulunamadı. Claude Code kurulu mu? Kuruluysa kovan.yaml'da claude_yolu alanına tam yolunu yaz (Terminal'de: which claude).";
      return;
    }
    // Sürüm/bayrak algılama alt sınıfın ortamından bağımsız (o sırada alt sınıf alanları henüz atanmadı)
    const algilama = { ...process.env };
    for (const ad of YONLENDIRME) delete algilama[ad];
    const v = spawnSync(this.yol, ["--version"], { encoding: "utf8", timeout: 60_000, env: algilama });
    const h = spawnSync(this.yol, ["--help"], { encoding: "utf8", timeout: 60_000, env: algilama });
    if (v.error || h.error) { this.hata = `claude çalıştırılamadı: ${(v.error ?? h.error)?.message}`; return; }
    this.surum = (v.stdout ?? "").trim();
    this.yardim = h.stdout ?? "";
    this.hazir = this.yardim.includes("--print");
    if (!this.hazir) this.hata = "claude --help çıktısında --print yok; Claude Code güncel mi?";
  }

  protected ortam(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.apiAnahtariniYoksay) for (const ad of YONLENDIRME) delete env[ad];
    return env;
  }

  /** Yüklü claude sürümü bu bayrağı destekliyor mu? (--help çıktısına bakar) */
  var(bayrak: string): boolean {
    return new RegExp(bayrak.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])").test(this.yardim);
  }

  async saglik(): Promise<boolean> {
    return this.hazir;
  }

  modelSec(kart: AjanKarti): string {
    return kart.model;
  }

  async durumOzeti(): Promise<MotorDurumu> {
    return { hazir: await this.saglik(), surum: this.surum, hata: this.hata, yol: this.yol, tur: this.tur, yerel: this.yerel, model: null };
  }

  komut(c: AjanCagrisi): string[] {
    const k = ["-p", "--output-format", "json", "--model", c.model];
    if (c.sistem_modu === "degistir" && this.var("--system-prompt")) k.push("--system-prompt", c.sistem);
    else k.push("--append-system-prompt", c.sistem);
    if (this.var("--tools")) k.push("--tools", c.araclar.join(","));            // "" -> hiç araç yok
    else if (!c.araclar.length) k.push("--disallowedTools", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch");
    if (c.izinli.length) k.push("--allowedTools", ...c.izinli);
    if (c.araclar.some((a) => ["Write", "Edit", "MultiEdit"].includes(a))) k.push("--permission-mode", "acceptEdits");
    if (this.var("--permission-prompts")) k.push("--permission-prompts", "none");  // izin isteyen her şey otomatik reddedilir
    if (this.var("--no-session-persistence")) k.push("--no-session-persistence");
    if (c.butce_usd && this.var("--max-budget-usd")) k.push("--max-budget-usd", c.butce_usd.toFixed(2));
    if (c.sema && this.yapisalDestek && this.var("--json-schema")) k.push("--json-schema", JSON.stringify(c.sema));
    if (c.efor && this.var("--effort")) k.push("--effort", c.efor);
    return k;
  }

  async calistir(c: AjanCagrisi): Promise<AjanSonucu> {
    if (!(await this.saglik())) return sonuc({ hata: this.hata ?? `${this.ad} hazır değil`, kalici_hata: true });
    let istem = c.istem;
    if (c.sema && !(this.yapisalDestek && this.var("--json-schema"))) istem += YEDEK_JSON_TALIMATI;
    const t0 = Date.now();
    return new Promise<AjanSonucu>((coz) => {
      let p: ChildProcess;
      try {
        p = spawn(this.yol!, this.komut(c), { cwd: c.cwd, env: this.ortam(), detached: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        coz(sonuc({ hata: `claude başlatılamadı: ${(e as Error).message}` }));
        return;
      }
      let cikti = "";
      let hata = "";
      let zamanAsimi = false;
      let bitti = false;
      const sure = () => (Date.now() - t0) / 1000;
      const saat = setTimeout(() => { zamanAsimi = true; sureciOldur(p); }, c.sure_sn * 1000);
      const kapat = () => { clearTimeout(saat); c.surecCb?.(p, true); };
      p.stdout!.setEncoding("utf8").on("data", (d) => { cikti += d; });
      p.stderr!.setEncoding("utf8").on("data", (d) => { hata += d; });
      p.on("error", (e) => {
        if (bitti) return;
        bitti = true; kapat();
        coz(sonuc({ hata: `claude başlatılamadı: ${e.message}`, sure_sn: sure() }));
      });
      p.on("close", (kod) => {
        if (bitti) return;
        bitti = true; kapat();
        if (zamanAsimi) {
          coz(sonuc({ zaman_asimi: true, sure_sn: sure(), hata: `Süre sınırı aşıldı (${Math.round(c.sure_sn)} sn); süreç durduruldu` }));
        } else {
          coz(this.coz(cikti, hata, kod ?? -1, sure()));
        }
      });
      c.surecCb?.(p, false);
      p.stdin!.on("error", () => { /* süreç erken kapanırsa EPIPE */ });
      p.stdin!.end(istem);
    });
  }

  protected coz(cikti: string, hata: string, kod: number, sure: number): AjanSonucu {
    const s = (cikti ?? "").trim();
    let veri: unknown = null;
    if (s) {
      try { veri = JSON.parse(s); } catch {
        for (const satir of s.split("\n").reverse()) {
          try { veri = JSON.parse(satir); break; } catch { /* sonraki satır */ }
        }
      }
    }
    if (Array.isArray(veri)) veri = [...veri].reverse().find((m) => m && typeof m === "object" && m.type === "result") ?? null;
    if (!veri || typeof veri !== "object") {
      if (kod < 0) return sonuc({ sure_sn: sure, hata: "Süreç durduruldu" });
      const d = dostcaHata(hata + s);
      return sonuc({
        sure_sn: sure, ham: (s || hata).slice(-4000), kalici_hata: d?.kalici ?? false,
        hata: `claude çıktısı okunamadı (çıkış kodu ${kod}): ${d?.mesaj ?? kisalt(hata || s || "boş çıktı", 600)}`,
      });
    }
    const v = veri as Record<string, any>;
    const kullanim = v.usage ?? {};
    const girdi = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((t, k) => t + Number(kullanim[k] ?? 0), 0);
    let metin = v.result;
    if (typeof metin !== "string") metin = metin == null ? "" : JSON.stringify(metin);
    const ok = kod === 0 && !v.is_error;
    let hataMetni: string | null = null;
    let kalici = false;
    if (!ok) {
      const alt = String(v.subtype ?? "");
      if (alt === "error_max_budget_usd") { hataMetni = "Adım bütçesi aşıldı (kartta butce_usd). Kartı büyütüp 'Tekrar dene'."; kalici = true; }
      else if (alt === "error_max_turns") hataMetni = "Ajan tur sınırına takıldı";
      else {
        const d = dostcaHata(metin + hata);
        hataMetni = d?.mesaj ?? kisalt(metin || hata || alt || "hata", 600);
        kalici = d?.kalici ?? false;
      }
    }
    return sonuc({
      ok, metin, yapisal: v.structured_output && typeof v.structured_output === "object" ? v.structured_output : null,
      maliyet: Number(v.total_cost_usd ?? v.cost_usd ?? 0), girdi_token: girdi, cikti_token: Number(kullanim.output_tokens ?? 0),
      tur_sayisi: Number(v.num_turns ?? 0), sure_sn: sure, hata: hataMetni, ham: s.slice(-4000), izin_retleri: izinRetleri(v),
      kalici_hata: kalici,
    });
  }
}

// ----------------------------------------------------------------------------------------
// Yerel model: aynı claude -p harness'ı, model Ollama'da
// ----------------------------------------------------------------------------------------
const surumDizisi = (s: string) => {
  const p = (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  while (p.length < 3) p.push(0);
  return p;
};

export class OllamaMotoru extends ClaudeMotoru {
  override readonly tur = "ollama" as const;
  override readonly yerel = true;
  ollamaSurum: string | null = null;
  private sonKontrol = 0;
  private claudeHazir: boolean;
  private claudeHata: string | null;
  static EN_DUSUK = [0, 14, 0];

  constructor(ad: string, public adres: string, public model: string, claudeYolu = "claude") {
    super(claudeYolu, true);
    this.ad = ad;
    this.adres = adres.replace(/\/+$/, "");
    this.yapisalDestek = false;             // yerelde --json-schema'ya güvenmiyoruz; metinden JSON okunur
    this.claudeHazir = this.hazir;
    this.claudeHata = this.hata;
    this.hazir = false;
  }

  protected override ortam(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ANTHROPIC_BASE_URL: this.adres,
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_API_KEY: "",
      // Claude Code arka planda başka model isterse o da yerel modele gitsin
      ANTHROPIC_DEFAULT_OPUS_MODEL: this.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: this.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: this.model,
      ANTHROPIC_SMALL_FAST_MODEL: this.model,
      CLAUDE_CODE_SUBAGENT_MODEL: this.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
  }

  private async getir(yol: string): Promise<Record<string, any>> {
    const r = await fetch(this.adres + yol, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as Record<string, any>;
  }

  override async saglik(zorla = false): Promise<boolean> {
    if (!zorla && Date.now() - this.sonKontrol < 10_000) return this.hazir;
    this.sonKontrol = Date.now();
    this.hazir = false;
    this.hata = null;
    if (!this.claudeHazir) { this.hata = this.claudeHata ?? "claude komutu hazır değil"; return false; }
    try {
      this.ollamaSurum = String((await this.getir("/api/version")).version ?? "");
    } catch {
      this.hata = `Ollama'ya ulaşılamadı (${this.adres}). Ollama uygulamasını aç.`;
      return false;
    }
    const v = surumDizisi(this.ollamaSurum);
    const e = OllamaMotoru.EN_DUSUK;
    if (v[0] < e[0] || (v[0] === e[0] && (v[1] < e[1] || (v[1] === e[1] && v[2] < e[2])))) {
      this.hata = `Ollama ${this.ollamaSurum} eski. Claude Code uyumluluğu için 0.14 veya üstü gerekli; Ollama'yı güncelle.`;
      return false;
    }
    try {
      const modeller: Record<string, unknown>[] = (await this.getir("/api/tags")).models ?? [];
      const adlar = new Set(modeller.flatMap((m) => [m.name, m.model].filter(Boolean).map(String)));
      if (!adlar.has(this.model) && !adlar.has(`${this.model}:latest`)) {
        this.hata = `Model indirilmemiş: Terminal'de \`ollama pull ${this.model}\``;
        return false;
      }
    } catch (err) {
      this.hata = `Ollama model listesi alınamadı: ${(err as Error).message}`;
      return false;
    }
    this.hazir = true;
    return true;
  }

  override modelSec(kart: AjanKarti): string {
    return kart.yerel_model ?? this.model;
  }

  override komut(c: AjanCagrisi): string[] {
    return super.komut({ ...c, butce_usd: null, efor: null });   // yerelde $ bütçe ve efor anlamsız
  }

  protected override coz(cikti: string, hata: string, kod: number, sure: number): AjanSonucu {
    const s = super.coz(cikti, hata, kod, sure);
    s.maliyet = 0;                                                  // yerel çıkarım: API maliyeti yok
    if (!s.ok && s.hata) {
      const k = `${s.hata} ${hata}`.toLowerCase();
      if (["econnrefused", "connection error", "fetch failed", "unable to connect", "connection refused", "socket"].some((x) => k.includes(x))) {
        s.hata = `Ollama'ya bağlanılamadı (${this.adres}). Ollama açık mı?`;
        s.kalici_hata = true;
      } else if (k.includes("not found") && k.includes("model")) {
        s.hata = `Model bulunamadı: \`ollama pull ${this.model}\``;
        s.kalici_hata = true;
      }
    }
    return s;
  }

  override async durumOzeti(): Promise<MotorDurumu> {
    return { ...(await super.durumOzeti()), model: this.model, adres: this.adres, ollama_surum: this.ollamaSurum };
  }
}

// ----------------------------------------------------------------------------------------
// Deneme motoru: gerçek ajan çalışmaz. Döngüleri (DÜZELT, kırmızı test), insana soruları ve
// sınır ihlalini göstermek için önceden tanımlı davranır. Örnek proje: Flora AI. Maliyet temsilidir.
// ----------------------------------------------------------------------------------------
const DENEME_BE_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { sonrakiSulama } from "../../backend/src/sulama.mjs";

test("TS-BE-1: sonraki sulama tarihi", () => {
  assert.equal(sonrakiSulama("2026-11-17", 7), "2026-11-24");
});

test("TS-BE-2: geçersiz aralık reddedilir", () => {
  assert.throws(() => sonrakiSulama("2026-11-17", 0), RangeError);
});
`;

const DENEME_FE_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = () => readFileSync(new URL("../../frontend/index.html", import.meta.url), "utf8");

test("TS-FE-1: bugün sulanacaklar listesi var", () => assert.match(html(), /id="bugun-listesi"/));
test("TS-FE-2: hata mesajı alanı var", () => assert.match(html(), /id="hata"/));
`;

const deneme_sh = (dosya: string) => `#!/bin/bash\ncd "$(dirname "$0")"\nnode --test ${dosya}\n`;

const DENEME_BE_HATALI = `export function sonrakiSulama(sonSulama, aralikGun) {
  if (!(aralikGun >= 1)) throw new RangeError("Sulama aralığı en az 1 gün olmalı");
  return sonSulama; // deneme: ilk turda bilerek hatalı (aralık eklenmedi)
}
`;

const DENEME_BE_DOGRU = `/** Son sulama tarihine aralığı ekler; geçersiz aralığı reddeder. */
export function sonrakiSulama(sonSulama, aralikGun) {
  if (!(aralikGun >= 1)) throw new RangeError("Sulama aralığı en az 1 gün olmalı");
  const d = new Date(\`\${sonSulama}T00:00:00Z\`);
  d.setUTCDate(d.getUTCDate() + aralikGun);
  return d.toISOString().slice(0, 10);
}
`;

const deneme_fe = (hata: string) => `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>Flora AI · bakım paneli (deneme)</title></head>
<body>
  <main>
    <h1>Bitkilerim</h1>
    <label for="bitki-adi">Bitki adı</label> <input id="bitki-adi" type="text">
    <label for="aralik">Sulama aralığı (gün)</label> <input id="aralik" type="number" min="1">
    <button id="kaydet">Kaydet</button>
    ${hata}
    <h2>Bugün sulanacaklar</h2>
    <ul id="bugun-listesi"></ul>
  </main>
</body>
</html>
`;

const DENEME_PROTOTIP = `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>Flora AI · prototip (deneme)</title>
<style>
  body{font-family:system-ui;margin:0;background:#f4f7f2;color:#1d2a1f}
  header{background:#2f6b3a;color:#fff;padding:18px 28px;font-size:20px;font-weight:600}
  main{max-width:720px;margin:24px auto;padding:0 16px}
  section{background:#fff;border:1px solid #dde6da;border-radius:14px;padding:18px 20px;margin:14px 0}
  .kart{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #eef2ec;padding:10px 0}
  .dugme{background:#2f6b3a;color:#fff;border-radius:999px;padding:6px 14px;text-decoration:none;font-size:14px}
  .hata{color:#a8231b}
</style></head>
<body>
  <header>🌿 Flora AI</header>
  <main>
    <section id="ekran-1"><h2>Bugün sulanacaklar</h2>
      <div class="kart"><span>Monstera · son sulama 10 Kasım</span><a class="dugme" href="#">Suladım</a></div>
      <div class="kart"><span>Orkide · son sulama 12 Kasım</span><a class="dugme" href="#">Suladım</a></div>
      <p>Liste boşsa: "Bugün sulanacak bitki yok."</p><a href="#ekran-2">+ Bitki ekle →</a></section>
    <section id="ekran-2"><h2>Bitki ekle</h2><p>Ad, tür, sulama aralığı (gün), son sulama tarihi.</p>
      <p class="hata">Hata durumu: "Bitki adı boş olamaz."</p><a href="#ekran-1">← Bitkilerim</a></section>
  </main>
</body>
</html>
`;

const DENEME_PO_SORUSU = {
  sorular: [{
    baslik: "Arayüz dili", soru: "Flora AI'ın arayüz dili ne olsun?", coklu: false,
    secenekler: [
      { etiket: "Türkçe (Önerilen)", aciklama: "Hedef pazar Türkiye; bütün metinler Türkçe." },
      { etiket: "İngilizce", aciklama: "Uluslararası pazarla başla; Türkçe sonra." },
      { etiket: "İki dilli (TR/EN)", aciklama: "Dil seçimi eklenir; kapsam ve test yükü artar." },
    ],
  }],
};

const DENEME_UYUM_SORUSU = [{
  baslik: "Kişisel veri", soru: "Uygulama kullanıcıdan e-posta gibi kişisel veri toplayacak mı?", coklu: false,
  secenekler: [
    { etiket: "Hayır, anonim kullanım (Önerilen)", aciklama: "Hesap yok; veriler cihazda kalır, KVKK yükü en az." },
    { etiket: "Evet, e-posta ile giriş", aciklama: "Aydınlatma metni ve açık rıza ekranı gerekir." },
  ],
}];

export class DenemeMotoru implements Motor {
  readonly ad = "deneme";
  readonly tur = "deneme" as const;
  readonly yerel = false;
  hazir = true;
  hata: string | null = null;
  surum = "deneme (sahte motor)";

  constructor(private gecikmeSn = 1) {}

  async saglik(): Promise<boolean> { return true; }
  modelSec(): string { return "deneme"; }
  async durumOzeti(): Promise<MotorDurumu> {
    return { hazir: true, surum: this.surum, hata: null, yol: null, tur: this.tur, yerel: false, model: "deneme" };
  }

  async calistir(c: AjanCagrisi): Promise<AjanSonucu> {
    const t0 = Date.now();
    await bekle(this.gecikmeSn * 1000 * (0.6 + Math.random() * 0.7));
    let metin: string;
    let yapisal: Record<string, unknown> | null = null;
    if (c.gorev_turu === "inceleme") { yapisal = this.incele(c); metin = JSON.stringify(yapisal); }
    else metin = this.uret(c);
    const girdi = Math.floor((c.sistem.length + c.istem.length) / 4);
    const cikti = Math.max(60, Math.floor(metin.length / 4));
    return sonuc({
      ok: true, metin, yapisal, maliyet: Math.round((girdi * 3 / 1e6 + cikti * 15 / 1e6) * 10_000) / 10_000,
      girdi_token: girdi, cikti_token: cikti, tur_sayisi: c.araclar.length ? 4 : 1, sure_sn: (Date.now() - t0) / 1000,
    });
  }

  private static isaret(asamaId: string) { return `.deneme-duzeltildi-${asamaId}`; }

  private incele(c: AjanCagrisi): Record<string, unknown> {
    const sorabilir = c.sistem.includes("kovan-soru");
    if (sorabilir && c.rol === "mevzuat" && c.asama_id === "analiz" && !c.istem.includes("### Kişisel veri")) {
      return { karar: "SORU", gerekce: "Kişisel veri toplanıp toplanmayacağı belirsiz; KVKK gereksinimleri buna bağlı.", bulgular: [], sorular: DENEME_UYUM_SORUSU };
    }
    let duzeltildi: boolean;
    if (path.basename(c.cwd) === "kod") duzeltildi = DenemeMotoru.ara(c.cwd, DenemeMotoru.isaret(c.asama_id));
    else duzeltildi = c.istem.split("## Referans belgeler")[0].includes("(düzeltildi)");
    if (["analiz", "be-gelistirme"].includes(c.asama_id) && ["urun-sahibi", "mimar"].includes(c.rol) && !duzeltildi) {
      return { karar: "DUZELT", gerekce: "Deneme modu: döngüyü göstermek için bir düzeltme istiyorum.", bulgular: ["Geçersiz sulama aralığı (0 ya da negatif) için hata davranışı açıkça yazılmamış."] };
    }
    return { karar: "ONAY", gerekce: "Deneme modu: kriterler karşılanıyor.", bulgular: [] };
  }

  private static ara(kok: string, ad: string): boolean {
    const yigin = [kok];
    while (yigin.length) {
      const d = yigin.pop()!;
      for (const g of fs.readdirSync(d, { withFileTypes: true })) {
        if (g.name === ad) return true;
        if (g.isDirectory() && g.name !== "node_modules") yigin.push(path.join(d, g.name));
      }
    }
    return false;
  }

  private uret(c: AjanCagrisi): string {
    const geriBildirimVar = c.istem.includes("## Düzeltme istekleri");
    const geriBildirim = geriBildirimVar ? c.istem.split("## Düzeltme istekleri")[1] : "";
    const sorabilir = c.sistem.includes("kovan-soru");
    if (sorabilir && c.rol === "urun-sahibi" && c.asama_id === "brif" && !c.istem.includes("### Arayüz dili")) {
      return "Brifi yazmadan önce bir kararına ihtiyacım var.\n\n```kovan-soru\n" + JSON.stringify(DENEME_PO_SORUSU, null, 2) + "\n```";
    }
    const cwd = c.cwd;
    const yaz = (rel: string, metin: string) => {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), metin, "utf8");
    };
    if (path.basename(cwd) === "kod") {
      if (c.rol === "test-otomasyon") {
        yaz("testler/be/sulama.test.mjs", DENEME_BE_TEST);
        yaz("test-be.sh", deneme_sh("testler/be/sulama.test.mjs"));
        let satir = "| TS-BE-1: sonraki sulama tarihi | testler/be/sulama.test.mjs |\n| TS-BE-2: geçersiz aralık | testler/be/sulama.test.mjs |";
        if (c.istem.includes("test-fe.sh")) {
          yaz("testler/fe/panel.test.mjs", DENEME_FE_TEST);
          yaz("test-fe.sh", deneme_sh("testler/fe/panel.test.mjs"));
          satir += "\n| TS-FE-1: bugün sulanacaklar | testler/fe/panel.test.mjs |\n| TS-FE-2: hata mesajı | testler/fe/panel.test.mjs |";
        }
        return "Deneme modu: otomatik testleri yazdım (şu an kırmızı; uygulama henüz yok).\n\n| Senaryo | Test |\n|---|---|\n" + satir;
      }
      if (c.rol === "ux-tasarimci") {
        yaz("tasarim/akislar.md", "# Akışlar (deneme)\n\n1. Bitkilerim → 2. Bitki ekle\n\nDurumlar: boş liste, hata, kayıt başarılı.\n\n## Arayüz sözleşmesi\n- bitki-adi, aralik, kaydet, hata, bugun-listesi\n");
        yaz("tasarim/prototip.html", DENEME_PROTOTIP);
        return "Deneme modu: tasarim/akislar.md ve tıklanabilir tasarim/prototip.html hazır.\n\nArayüz sözleşmesi: bitki-adi, aralik, kaydet, hata, bugun-listesi";
      }
      if (c.rol === "be-yazilimci" || c.rol === "fe-yazilimci") {
        const alan = c.rol === "be-yazilimci" ? "backend" : "frontend";
        const ilkTur = !geriBildirimVar;
        if (process.env.KOVAN_DENEME_IHLAL && ilkTur) {
          for (const d of ["be", "fe"]) {
            const klasor = path.join(cwd, "testler", d);
            if (!fs.existsSync(klasor)) continue;
            for (const f of fs.readdirSync(klasor)) if (f.endsWith(".test.mjs")) fs.appendFileSync(path.join(klasor, f), "\n// testi gevşettim\n");
          }
          yaz("notlar.txt", "yazma alanı dışı");
        }
        if (alan === "backend") yaz("backend/src/sulama.mjs", ilkTur ? DENEME_BE_HATALI : DENEME_BE_DOGRU);
        else yaz("frontend/index.html", deneme_fe(ilkTur ? "" : '<p id="hata" role="alert"></p>'));
        if (!ilkTur && !geriBildirim.includes(": KIRMIZI")) yaz(`${alan}/${DenemeMotoru.isaret(c.asama_id)}`, "1");
        return `Deneme modu: ${alan}/ yazıldı${ilkTur ? " (ilk tur, bilerek hatalı)." : ", düzeltme istekleri uygulandı."}`;
      }
    }

    const m = /### fikir\n([\s\S]*?)(?=\n### |\n## |$)/.exec(c.istem);
    const satirlar = [
      `# ${c.asama_id} (deneme)`, "", "> Bu belgeyi sahte motor üretti; gerçek bir ajan çalışmadı.", "",
      "## Özet", kisalt(m?.[1].trim() ?? "", 300) || "-", "", "## Maddeler",
      "- K1: Bir sonraki sulama tarihi doğru hesaplanır.", "- K2: Geçersiz sulama aralığı reddedilir.",
    ];
    if (c.istem.includes("## İnsan kararları")) satirlar.push("", "İnsan kararları dikkate alındı.");
    if (c.rol === "test-analisti") {
      satirlar.push("", "## Test senaryoları", "| ID | Taraf | Senaryo | Beklenen |", "|---|---|---|---|",
        "| TS-BE-1 | BE | Son sulama + 7 gün | doğru tarih |", "| TS-BE-2 | BE | Aralık 0 | RangeError |",
        "| TS-FE-1 | FE | Bugün sulanacaklar listesi | görünür |", "| TS-FE-2 | FE | Boş bitki adı | hata mesajı |");
    }
    if (geriBildirimVar) satirlar.push("", "(düzeltildi) Düzeltme istekleri uygulandı.");
    return satirlar.join("\n");
  }
}
