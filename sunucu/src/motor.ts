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
  gorev_turu: "uret" | "inceleme" | "karar" | "sohbet";   // karar: ortak kararda oy; sohbet: projenin sahibinin sorusuna cevap (salt okunur)
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
  readonly tur: "claude" | "ollama" | "openai" | "deneme";
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
    insan: { type: "boolean" },
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
    kapsam_disi: { type: "boolean" },
  },
  required: ["karar", "gerekce", "bulgular"],
  additionalProperties: false,
};

/** Büyük Birader'in hükmü: her aşamanın sonunda işin tamamına bakar. VETO kanıt ister. */
export const BIRADER_SEMASI = {
  type: "object",
  properties: {
    hukum: { type: "string", enum: ["UYGUN", "DIKKAT", "VETO"] },
    ozet: { type: "string" },
    bulgular: {
      type: "array", maxItems: 6,
      items: {
        type: "object",
        properties: { konu: { type: "string" }, kanit: { type: "string" }, aciklama: { type: "string" } },
        required: ["konu", "kanit", "aciklama"], additionalProperties: false,
      },
    },
    oneri: { type: "string" },
  },
  required: ["hukum", "ozet", "bulgular"],
  additionalProperties: false,
};

/** Ortak kararda bir ajanın oyları: her soru için seçenek numaraları (1'den başlar). */
export const OY_SEMASI = {
  type: "object",
  properties: {
    oylar: {
      type: "array",
      items: {
        type: "object",
        properties: {
          soru: { type: "integer" },
          secim: { type: "array", items: { type: "integer" } },
          insana_birak: { type: "boolean" },
          gerekce: { type: "string" },
        },
        required: ["soru", "secim", "gerekce"],
        additionalProperties: false,
      },
    },
  },
  required: ["oylar"],
  additionalProperties: false,
};

/** Model --json-schema'yı desteklemiyorsa (yerel motor) JSON istemin sonunda istenir. */
export function yedekJsonTalimati(c: AjanCagrisi): string {
  const ornek = c.sema === BIRADER_SEMASI
    ? '{"hukum": "UYGUN" | "DIKKAT" | "VETO", "ozet": "...", "bulgular": [{"konu": "...", "kanit": "...", "aciklama": "..."}], "oneri": "..."}'
    : c.gorev_turu === "karar"
    ? '{"oylar": [{"soru": 1, "secim": [1], "insana_birak": false, "gerekce": "..."}]}'
    : '{"karar": "ONAY" | "DUZELT" | "SORU", "gerekce": "...", "bulgular": ["..."], "sorular": []}';
  return `\n\nYanıtının EN SONUNA yalnızca şu biçimde bir JSON bloğu koy:\n\`\`\`json\n${ornek}\n\`\`\``;
}

export interface HamSoru {
  baslik: string;
  soru: string;
  coklu: boolean;
  insan: boolean;     // ajana göre kararı yalnızca projenin sahibi verebilir; ekip oylamaz
  konu: "is_kurali" | "teknik" | null;   // yalnızca is_kurali_sana aşamalarında anlamlı
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
    sorular.push({ soru, baslik: kisalt(String(s?.baslik ?? "") || soru, 24), coklu: Boolean(s?.coklu), insan: s?.insan === true,
      konu: s?.konu === "teknik" || s?.konu === "is_kurali" ? s.konu : null, secenekler });
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

/** Serbest metnin içinden verilen anahtarı ('karar', 'oylar') içeren son JSON nesnesini bulur. */
export function jsonCikar(metin: string, anahtar = "karar"): Record<string, unknown> | null {
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
      if (v && typeof v === "object" && anahtar in v) return v;
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
    if (c.sema && !(this.yapisalDestek && this.var("--json-schema"))) istem += yedekJsonTalimati(c);
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
// Deneme testleri node:test ile yazılır: npm kurulumu gerekmez, saniyeler içinde koşar.
const testBasi = (iceAktar: string) => `import { test } from "node:test";
import assert from "node:assert/strict";
${iceAktar}
`;

/** Deneme projesindeki kalemler (Flora AI bakım paneli): test dosyası, testler ve kod. */
const DENEME_KALEMLER: Record<string, { taraf: "be" | "fe"; test: string; testMetni: string; dosya: string; kod: string; hatali?: string; senaryo: string[] }> = {
  p1: {
    taraf: "be", test: "sulama.test.mjs", dosya: "backend/src/sulama.mjs", senaryo: ["TS-BE-1: sonraki sulama tarihi", "TS-BE-2: geçersiz aralık reddedilir"],
    testMetni: testBasi('import { sonrakiSulama } from "../../../backend/src/sulama.mjs";') + `
test("TS-BE-1: sonraki sulama tarihi", () => {
  assert.equal(sonrakiSulama("2026-11-17", 7), "2026-11-24");
});

test("TS-BE-2: geçersiz aralık reddedilir", () => {
  assert.throws(() => sonrakiSulama("2026-11-17", 0), RangeError);
});
`,
    hatali: `export function sonrakiSulama(sonSulama, aralikGun) {
  if (!(aralikGun >= 1)) throw new RangeError("Sulama aralığı en az 1 gün olmalı");
  return sonSulama; // deneme: ilk turda bilerek hatalı (aralık eklenmedi)
}
`,
    kod: `/** Son sulama tarihine aralığı ekler; geçersiz aralığı reddeder. */
export function sonrakiSulama(sonSulama, aralikGun) {
  if (!(aralikGun >= 1)) throw new RangeError("Sulama aralığı en az 1 gün olmalı");
  const d = new Date(\`\${sonSulama}T00:00:00Z\`);
  d.setUTCDate(d.getUTCDate() + aralikGun);
  return d.toISOString().slice(0, 10);
}
`,
  },
  p2: {
    taraf: "be", test: "liste.test.mjs", dosya: "backend/src/liste.mjs", senaryo: ["TS-BE-3: bugün sulanacaklar listesi"],
    testMetni: testBasi('import { bugunSulanacaklar } from "../../../backend/src/liste.mjs";') + `
test("TS-BE-3: bugün sulanacaklar listesi", () => {
  const bitkiler = [
    { ad: "Monstera", sonSulama: "2026-11-10", aralikGun: 7 },
    { ad: "Kaktüs", sonSulama: "2026-11-15", aralikGun: 14 },
  ];
  assert.deepEqual(bugunSulanacaklar(bitkiler, "2026-11-17").map((b) => b.ad), ["Monstera"]);
});
`,
    kod: `import { sonrakiSulama } from "./sulama.mjs";

/** Sulama günü gelmiş ya da geçmiş bitkiler. */
export function bugunSulanacaklar(bitkiler, bugun) {
  return bitkiler.filter((b) => sonrakiSulama(b.sonSulama, b.aralikGun) <= bugun);
}
`,
  },
  p3: {
    taraf: "be", test: "isaret.test.mjs", dosya: "backend/src/isaret.mjs", senaryo: ["TS-BE-4: 'Suladım' son sulamayı bugüne çeker"],
    testMetni: testBasi('import { suladim } from "../../../backend/src/isaret.mjs";') + `
test("TS-BE-4: 'Suladım' son sulamayı bugüne çeker", () => {
  const b = suladim({ ad: "Monstera", sonSulama: "2026-11-10", aralikGun: 7 }, "2026-11-17");
  assert.equal(b.sonSulama, "2026-11-17");
});
`,
    kod: `/** "Suladım": bitkinin son sulama tarihini günceller (girdiyi değiştirmez). */
export function suladim(bitki, tarih) {
  return { ...bitki, sonSulama: tarih };
}
`,
  },
  "p3-fe": {
    taraf: "fe", test: "panel.test.mjs", dosya: "frontend/index.html", senaryo: ["TS-FE-1: bugün sulanacaklar listesi", "TS-FE-2: hata mesajı alanı"],
    testMetni: testBasi('import { readFileSync } from "node:fs";') + `
const html = () => readFileSync(new URL("../../../frontend/index.html", import.meta.url), "utf8");

test("TS-FE-1: bugün sulanacaklar listesi var", () => assert.match(html(), /id="bugun-listesi"/));
test("TS-FE-2: hata mesajı alanı var", () => assert.match(html(), /id="hata"/));
`,
    kod: "",
  },
};

/** Replatform denemesi (kurgusal kart reeskont gün sonu): kalemler, testler ve kod. */
const DENEME_REESKONT: typeof DENEME_KALEMLER = {
  p1: {
    taraf: "be", test: "faiz.test.mjs", dosya: "backend/src/faiz.mjs", senaryo: ["TS-BE-1 (E1): 365 gün esası, kuruşa yuvarlama", "TS-BE-2 (E2): sıfır ve alacaklı bakiye"],
    testMetni: testBasi('import { gunlukFaiz } from "../../../backend/src/faiz.mjs";') + `
test("TS-BE-1 (E1): günlük faiz 365 gün esasıyla hesaplanır, kuruşa yuvarlanır", () => {
  assert.equal(gunlukFaiz(10000, 36), 9.86);
  assert.equal(gunlukFaiz(2500.5, 48), 3.29);
});

test("TS-BE-2 (E2): sıfır ve alacaklı bakiyeye faiz işlemez", () => {
  assert.equal(gunlukFaiz(0, 36), 0);
  assert.equal(gunlukFaiz(-150, 36), 0);
});
`,
    hatali: `export const GUN_ESASI = 360; // deneme: ilk turda bilerek dokümandaki 360 (eski kod 365)

export function gunlukFaiz(bakiye, yillikOran) {
  if (!(bakiye > 0)) return 0;
  return Math.round((bakiye * yillikOran / 100 / GUN_ESASI) * 100 + 1e-9) / 100;
}
`,
    kod: `/** Eski sistemle aynı gün esası (E1; doküman 360 diyordu, karar: 365). */
export const GUN_ESASI = 365;

/** Günlük faiz tahakkuku: bakiye × yıllık oran / 100 / gün esası, kuruşa yarım yukarı yuvarlanır. Sıfır ve alacaklı bakiyede 0 (E2). */
export function gunlukFaiz(bakiye, yillikOran) {
  if (!(bakiye > 0)) return 0;
  return Math.round((bakiye * yillikOran / 100 / GUN_ESASI) * 100 + 1e-9) / 100;
}
`,
  },
  p2: {
    taraf: "be", test: "reeskont.test.mjs", dosya: "backend/src/reeskont.mjs", senaryo: ["TS-BE-3 (E3, E4): örnek kartlarda eski sistemle aynı hareketler ve toplam"],
    testMetni: testBasi('import { reeskontHesapla } from "../../../backend/src/reeskont.mjs";') + `
const kart = (kartNo, bakiye, yillikOran, durum = "A", faizIsler = "E") => ({ kartNo, bakiye, yillikOran, durum, faizIsler });

test("TS-BE-3 (E3, E4): yalnızca aktif ve faiz işleyen kartlar, sıralı; eski sistemle aynı toplam", () => {
  const sonuc = reeskontHesapla([
    kart("K0005", 125000, 30), kart("K0001", 10000, 36), kart("K0003", -150, 36),
    kart("K0002", 2500.5, 48), kart("K0006", 8000, 36, "K"), kart("K0007", 4000, 36, "A", "H"),
  ]);
  assert.deepEqual(sonuc.hareketler, [
    { kartNo: "K0001", tutar: 9.86 }, { kartNo: "K0002", tutar: 3.29 }, { kartNo: "K0005", tutar: 102.74 },
  ]);
  assert.equal(sonuc.toplam, 115.89);
});
`,
    kod: `import { gunlukFaiz } from "./faiz.mjs";

/** Faiz işleyen aktif kartların günlük tahakkukları (kart numarasına göre) ve günün toplamı (E3, E4). */
export function reeskontHesapla(kartlar) {
  const hareketler = kartlar
    .filter((k) => k.durum === "A" && k.faizIsler === "E")
    .sort((a, b) => a.kartNo.localeCompare(b.kartNo))
    .map((k) => ({ kartNo: k.kartNo, tutar: gunlukFaiz(k.bakiye, k.yillikOran) }))
    .filter((h) => h.tutar > 0);
  const toplam = Math.round(hareketler.reduce((t, h) => t + h.tutar * 100, 0)) / 100;
  return { hareketler, toplam };
}
`,
  },
  p3: {
    taraf: "be", test: "gunsonu.test.mjs", dosya: "backend/src/gunsonu.mjs", senaryo: ["TS-BE-4 (E5): tek muhasebe fişi, hesap parametreden", "TS-BE-5 (ŞÜPHE-1): aynı tarih ikinci kez yazılmaz"],
    testMetni: testBasi('import { gunSonu } from "../../../backend/src/gunsonu.mjs";') + `
function bellekDepo(kartlar) {
  const islenen = new Map();
  return {
    kayitlar: islenen,
    kartlar: () => kartlar,
    muhasebeHesabi: () => "18100",
    tarihIslendiMi: (tarih) => islenen.has(tarih),
    kaydet: (tarih, hareketler, fis) => islenen.set(tarih, { hareketler, fis }),
  };
}
const kartlar = [{ kartNo: "K0001", bakiye: 10000, yillikOran: 36, durum: "A", faizIsler: "E" }];

test("TS-BE-4 (E5): günün toplamı tek fiş olarak, parametredeki hesaba yazılır", () => {
  const depo = bellekDepo(kartlar);
  assert.equal(gunSonu("2026-11-17", depo).toplam, 9.86);
  assert.deepEqual(depo.kayitlar.get("2026-11-17").fis, { hesap: "18100", tutar: 9.86, aciklama: "Kart reeskont tahakkuku" });
});

test("TS-BE-5 (ŞÜPHE-1): aynı tarih ikinci kez çalışırsa hiçbir şey yazılmaz", () => {
  const depo = bellekDepo(kartlar);
  gunSonu("2026-11-17", depo);
  assert.equal(gunSonu("2026-11-17", depo).atlandi, true);
  assert.equal(depo.kayitlar.size, 1);
});
`,
    kod: `import { reeskontHesapla } from "./reeskont.mjs";

/**
 * Gün sonu reeskont: hareketler, özet ve muhasebe fişi depo portu üzerinden tek seferde yazılır (E4, E5).
 * Aynı tarih ikinci kez çalışırsa hiçbir şey yazmaz (eski sistemdeki çift kayıt şüphesi, karar: düzelt).
 */
export function gunSonu(tarih, depo) {
  if (depo.tarihIslendiMi(tarih)) return { tarih, atlandi: true, toplam: 0 };
  const { hareketler, toplam } = reeskontHesapla(depo.kartlar());
  depo.kaydet(tarih, hareketler, { hesap: depo.muhasebeHesabi(), tutar: toplam, aciklama: "Kart reeskont tahakkuku" });
  return { tarih, atlandi: false, toplam };
}
`,
  },
};

/** Birleştirme: kaynak/ altındaki eski sistemin örnek girdi ve çıktısıyla tam bir gün sonu (altın test). */
const DENEME_REESKONT_ENTEGRASYON = testBasi(`import fs from "node:fs";
import path from "node:path";
import { gunSonu } from "../../../backend/src/gunsonu.mjs";`) + `
function bul(dizin, ad) {
  for (const g of fs.readdirSync(dizin, { withFileTypes: true })) {
    const p = path.join(dizin, g.name);
    if (g.isDirectory()) { const r = bul(p, ad); if (r) return r; } else if (g.name === ad) return p;
  }
  return null;
}
const kaynak = new URL("../../../kaynak/", import.meta.url).pathname;
const girdi = fs.existsSync(kaynak) ? bul(kaynak, "girdi.csv") : null;
const satirlar = (p) => fs.readFileSync(p, "utf8").trim().split(/\\r?\\n/).slice(1).map((s) => s.split(";"));

test("TS-E2E-1: eski sistemin örnek verisiyle aynı hareketler ve toplam (altın test)", { skip: !girdi && "örnek veri yok" }, () => {
  const kartlar = satirlar(girdi).map(([kartNo, bakiye, oran, durum, faizIsler]) =>
    ({ kartNo, bakiye: Number(bakiye), yillikOran: Number(oran), durum, faizIsler }));
  const beklenen = new Map(satirlar(path.join(path.dirname(girdi), "beklenen.csv")).map(([k, t]) => [k, Number(t)]));
  const yazilan = [];
  const depo = { kartlar: () => kartlar, muhasebeHesabi: () => "18100", tarihIslendiMi: () => false,
    kaydet: (tarih, hareketler) => yazilan.push(...hareketler) };
  const { toplam } = gunSonu("2026-11-17", depo);
  for (const h of yazilan) assert.equal(h.tutar, beklenen.get(h.kartNo), h.kartNo);
  assert.equal(toplam, beklenen.get("TOPLAM"));
});
`;

const DENEME_ENTEGRASYON = testBasi(`import { sonrakiSulama } from "../../../backend/src/sulama.mjs";
import { bugunSulanacaklar } from "../../../backend/src/liste.mjs";`) + `
test("TS-E2E-1: aralığı dolan bitki bugün listesinde görünür", () => {
  const b = { ad: "Orkide", sonSulama: "2026-11-10", aralikGun: 7 };
  assert.equal(sonrakiSulama(b.sonSulama, b.aralikGun), "2026-11-17");
  assert.equal(bugunSulanacaklar([b], "2026-11-17").length, 1);
});
`;

/** Bir taraftaki bütün testleri koşar (kalem klasörleri dahil); test yoksa yeşil döner. */
const deneme_sh = (taraf: string) => `#!/bin/bash
cd "$(dirname "$0")"
dosyalar=$(find testler/${taraf} -name '*.test.mjs' 2>/dev/null | sort)
if [ -z "$dosyalar" ]; then echo "Henüz ${taraf.toUpperCase()} testi yok"; exit 0; fi
node --test $dosyalar
`;

const DENEME_BE_TEST = DENEME_KALEMLER.p1.testMetni.replace(/\.\.\/\.\.\/\.\.\//g, "../../");

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
    baslik: "Arayüz dili", soru: "Uygulamanın arayüz dili ne olsun?", coklu: false,
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

/** Fikir metninde mevzuatı ilgilendiren bir konu var mı (deneme: kaba anahtar kelime taraması). */
const MEVZUAT_IZI = /fotoğraf|e-posta|konum|kişisel|kullanıcı|ödeme|kart|sağlık|premium|hesap|abonelik/i;

/** Deneme: mimarın teknik plandaki ADR'leri (replatformda çalışma biçimi zorunlu). */
const DENEME_ADR = (replatform: boolean) => [
  "## Mimari karar kayıtları", "", "```kovan-adr", "adrler:",
  ...(replatform ? [
    "  - id: ADR-1", "    baslik: Gün sonu reeskontu batch job olarak çalışır", "    alan: calisma_bicimi",
    "    baglam: Eski sistemde tek giriş noktası var, gün sonunda zamanlayıcının çağırdığı prosedür; çevrim içi çağıran yok.",
    "    secenekler:",
    "      - ad: Batch job", "        arti: Yeniden başlatma ve parça parça işleme hazır", "        eksi: Anlık sorgu için ayrı bir uç gerekir",
    "      - ad: REST endpoint", "        arti: Başka sistemler anlık çağırabilir", "        eksi: Uzun süren iş HTTP zaman aşımına takılır",
    "      - ad: İkisi", "        arti: Hem gün sonu hem anlık sorgu", "        eksi: Bugün kimsenin istemediği bir ucu da bakımda tutmak",
    "    karar: Batch job",
    "    gerekce: Bütün kartlar tek çalıştırmada işleniyor; zamanlayıcı zaten var. Endpoint istenirse aynı domain servisini çağırır.",
    "    sonuclar: Hesap saf domain katmanında kalır; batch yalnızca onu çağıran adaptör.",
    "    kurallar: [E1, E3, E5]",
    "  - id: ADR-2", "    baslik: Para ve oranlar ondalık, kuruşa yarım yukarı", "    alan: veri",
    "    baglam: Eski sistem NUMBER ve ROUND(x, 2) kullanıyor; eşdeğerlik birebir aynı tutarı istiyor.",
    "    secenekler:",
    "      - ad: Ondalık sayı, yarım yukarı", "        arti: Eski ROUND ile aynı sonuç", "        eksi: Kayan noktadan biraz yavaş",
    "      - ad: Tamsayı kuruş", "        arti: Hızlı ve basit", "        eksi: Ara hesapta hassasiyet kaybı; eski sonuçla fark çıkar",
    "    karar: Ondalık sayı, yarım yukarı",
    "    gerekce: Altın testte tek kuruşluk fark kabul edilmiyor.",
    "    sonuclar: Her hesapta ölçek ve yuvarlama modu açık yazılır.",
    "    kurallar: [E1, E2]",
  ] : [
    "  - id: ADR-1", "    baslik: Veri tarayıcıda tutulur", "    alan: veri",
    "    baglam: Tek kullanıcılı bir araç; hesap ya da senkronizasyon istenmedi.",
    "    secenekler:",
    "      - ad: Tarayıcı deposu", "        arti: Sunucu ve hesap gerekmez", "        eksi: Cihazlar arası taşınmaz",
    "      - ad: Sunucu veritabanı", "        arti: Cihazlar arası erişim", "        eksi: Hesap, barındırma ve kişisel veri yükü",
    "    karar: Tarayıcı deposu",
    "    gerekce: Analizde senkronizasyon yok; en ucuz ve geri alınabilir seçim.",
    "    sonuclar: Depolama bir port arkasında; ileride sunucuya taşınabilir.",
  ]),
  "```",
].join("\n");

const DENEME_PLAN = (fe: boolean) => [
  "# Teslim planı (deneme)", "", "> Bu belgeyi sahte motor üretti; gerçek bir ajan çalışmadı.", "",
  "İş üç dikey kaleme bölündü. Her kalem kendi kabul testiyle başlar; bir kalem bitmeden sonraki başlamaz.", "",
  "| Kalem | Başlık | Yazılımcı | Bağımlı | Kabul |", "|---|---|---|---|---|",
  "| P1 | Sulama tarihi hesabı | BE | - | K1, K2 |",
  "| P2 | Bugün sulanacaklar listesi | BE | P1 | K1 |",
  fe ? "| P3 | Bakım paneli ekranı | FE | P2 | K3 |" : "| P3 | 'Suladım' işareti | BE | P2 | K3 |",
  "", "```kovan-plan",
  "- id: P1", "  baslik: Sulama tarihi hesabı", "  gelistirici: be-yazilimci", "  bagimli: []", "  kabul: [K1, K2]",
  "  kapsam: Son sulama tarihine aralığı ekleyen ve geçersiz aralığı reddeden fonksiyon.",
  "- id: P2", "  baslik: Bugün sulanacaklar listesi", "  gelistirici: be-yazilimci", "  bagimli: [P1]", "  kabul: [K1]",
  "  kapsam: Sulama günü gelmiş bitkileri listeleyen fonksiyon.",
  ...(fe
    ? ["- id: P3", "  baslik: Bakım paneli ekranı", "  gelistirici: fe-yazilimci", "  bagimli: [P2]", "  kabul: [K3]",
      "  kapsam: Bitki ekleme formu, hata mesajı alanı ve bugün sulanacaklar listesi."]
    : ["- id: P3", "  baslik: \"'Suladım' işareti\"", "  gelistirici: be-yazilimci", "  bagimli: [P2]", "  kabul: [K3]",
      "  kapsam: Bitkinin son sulama tarihini bugüne çeken işlem."]),
  "```",
].join("\n");

const DENEME_REESKONT_PLAN = [
  "# Teslim planı (deneme)", "", "> Bu belgeyi sahte motor üretti; gerçek bir ajan çalışmadı.", "",
  "Önce saf hesaplama, sonra onu kullanan hesap, en sonda portlarla gün sonu akışı.", "",
  "| Kalem | Başlık | Yazılımcı | Bağımlı | Eski kurallar |", "|---|---|---|---|---|",
  "| P1 | Günlük faiz hesabı | BE | - | E1, E2 |", "| P2 | Reeskont hesaplama | BE | P1 | E3, E4 |", "| P3 | Gün sonu akışı ve portlar | BE | P2 | E5, ŞÜPHE-1 |",
  "", "```kovan-plan",
  "- id: P1", "  baslik: Günlük faiz hesabı", "  gelistirici: be-yazilimci", "  bagimli: []", "  kabul: [K1, K2]",
  "  kapsam: E1-E2. Gün esası 365 ile günlük faiz, kuruşa yarım yukarı yuvarlama; sıfır ve alacaklı bakiyede sıfır.",
  "- id: P2", "  baslik: Reeskont hesaplama", "  gelistirici: be-yazilimci", "  bagimli: [P1]", "  kabul: [K1, K3]",
  "  kapsam: E3-E4. Aktif ve faiz işleyen kartlar, kart numarasına göre sıralı hareketler ve günün toplamı.",
  "- id: P3", "  baslik: Gün sonu akışı ve portlar", "  gelistirici: be-yazilimci", "  bagimli: [P2]", "  kabul: [K4, K5]",
  "  kapsam: E5. Hareket, özet ve muhasebe fişi depo portu üzerinden; muhasebe hesabı parametre; aynı tarih iki kez işlenmez.",
  "```",
].join("\n");

const DENEME_GUN_ESASI_SORUSU = {
  sorular: [{
    baslik: "Gün esası", soru: "Analiz dokümanı gün esasını 360 diyor, eski kod 365 kullanıyor. Yeni sistem hangisini kullansın?", coklu: false,
    secenekler: [
      { etiket: "Koddaki gibi 365 (Önerilen)", aciklama: "Üretimdeki sonuçlar korunur; eşdeğerlik testleri eski çıktıyla birebir tutar." },
      { etiket: "Dokümandaki gibi 360", aciklama: "Doküman esas alınır; tutarlar değişir, eski çıktıyla karşılaştırmada fark beklenir." },
    ],
  }],
};

const DENEME_UYARI = "> Bu belgeyi sahte motor üretti; gerçek bir ajan çalışmadı.";

/** Replatform denemesinin belgeleri (kurgusal kart reeskont gün sonu). */
const DENEME_REESKONT_BELGELER: Record<string, string> = {
  "hedef-analiz": [
    "# Hedef analiz (deneme)", "", DENEME_UYARI, "",
    "## Eski kuralların durumu", "| Eski kural | Karar | Gerekçe | Yeni kural |", "|---|---|---|---|",
    "| E1: günlük faiz, kuruşa yuvarlama | AYNEN KORU | Gün esası kararı: koddaki gibi 365 | K2 |",
    "| E2: sıfır ve alacaklı bakiyeye faiz yok | AYNEN KORU | Üretimdeki davranış | K2 |",
    "| E3: aktif ve faiz işleyen kartlar, sıralı | AYNEN KORU | - | K3 |",
    "| E4: kart başına hareket, özete toplam | AYNEN KORU | - | K1 |",
    "| E5: günün toplamı tek fiş | DEĞİŞTİR | Hesap kodu koddan çıkar, parametre olur | K4 |",
    "| ŞÜPHE-1: yeniden çalıştırmada çift kayıt | DÜZELT | Aynı tarih ikinci kez işlenmez | K5 |", "",
    "## Yeni kurallar",
    "- K1: Korunan kurallarda eski sistemle aynı sonuç (eşdeğerlik; altın test eski çıktıyla karşılaştırır).",
    "- K2: Günlük faiz = bakiye × yıllık oran / 100 / 365, kuruşa yarım yukarı; sıfır ve alacaklı bakiyede 0.",
    "- K3: Yalnızca durumu aktif ve faiz işleyen kartlar, kart numarasına göre.",
    "- K4: Günün toplamı tek muhasebe fişi; hesap kodu parametreden.",
    "- K5: Bir tarih yalnızca bir kez işlenir; ikinci çalıştırma hiçbir şey yazmaz.", "",
    "## Uç durumlar", "- Tutarı sıfır çıkan kart için hareket yazılmaz.", "- Hiç kart yoksa fiş tutarı 0 olur; fiş yine tek.",
  ].join("\n"),
  "teknik-plan": [
    "# Teknik plan (deneme)", "", DENEME_UYARI, "",
    "## Katmanlar",
    "- Domain (saf): `faiz.gunlukFaiz`, `reeskont.reeskontHesapla`. Tarih, veritabanı ya da saat bilmez; yan etkisi yok.",
    "- Uygulama: `gunsonu.gunSonu(tarih, depo)`. Akışı yönetir; aynı tarihi ikinci kez işlemez.",
    "- Port (senin sistemin uygular): `depo.kartlar()`, `depo.tarihIslendiMi(tarih)`, `depo.kaydet(tarih, hareketler, fis)` (tek transaction), `depo.muhasebeHesabi()`.", "",
    "## Eski kuralların yeni yeri", "| Eski kural | Yeni yer |", "|---|---|",
    "| E1, E2 | domain: faiz |", "| E3, E4 | domain: reeskont |", "| E5, ŞÜPHE-1 | uygulama: gunsonu + depo portu |", "",
    "## Eski tablolar ve portlar", "| Eski yapı | Port |", "|---|---|",
    "| kart_bakiye (okuma) | depo.kartlar() |", "| reeskont_hareket, reeskont_ozet, muhasebe_fis (yazma) | depo.kaydet(...), tek transaction |",
    "| Sabit muhasebe hesabı | depo.muhasebeHesabi() |",
  ].join("\n"),
  entegrasyon: [
    "# Entegrasyon kılavuzu (deneme)", "", DENEME_UYARI, "",
    "## Modüller", "- `backend/src/faiz.mjs`, `backend/src/reeskont.mjs`: saf hesap, olduğu gibi alınır.",
    "- `backend/src/gunsonu.mjs`: giriş noktası `gunSonu(tarih, depo)`; zamanlayıcın gün sonunda bir kez çağırır.", "",
    "## Yazman gereken adaptör (depo portu)", "| Metot | Ne yapar | Eski karşılığı |", "|---|---|---|",
    "| kartlar() | Kartların faize esas bakiyesi, oranı, durumu | kart_bakiye imleci |",
    "| tarihIslendiMi(tarih) | O gün daha önce işlendi mi | Yoktu (yeni) |",
    "| kaydet(tarih, hareketler, fis) | Hareketler, özet ve fiş tek transaction | INSERT, UPDATE, INSERT ve COMMIT |",
    "| muhasebeHesabi() | Parametre tablosundan hesap kodu | Koddaki sabit |", "",
    "## Paralel koşum planı",
    "1. Yeni iş gölge modda (adaptör yazmadan) eski işle aynı gün koşar.",
    "2. Kart kart tutarlar ve günün toplamı eski işin yazdıklarıyla karşılaştırılır; beklenen fark sıfır.",
    "3. Art arda farksız günlerden sonra geçiş yapılır.", "",
    "## Geçiş ve geri dönüş",
    "- Geçiş günü eski iş zamanlayıcıdan çıkar, yeni iş girer.",
    "- Geri dönüşte, yeni işin işlediği bir tarih için eski işi çalıştırma: eski işte tarih kontrolü yok, çift kayıt olur.",
  ].join("\n"),
  teslim: [
    "# Teslim paketi (deneme)", "", DENEME_UYARI, "",
    "## Kalemler", "| Kalem | Teslim edilen | Testler |", "|---|---|---|",
    "| P1 | gunlukFaiz | TS-BE-1, TS-BE-2 |", "| P2 | reeskontHesapla | TS-BE-3 |", "| P3 | gunSonu ve depo portu | TS-BE-4, TS-BE-5 |",
    "| Birleştirme | Eski sistemin örnek verisiyle tam gün sonu | TS-E2E-1 (altın test) |", "",
    "## Eski kuralların durumu", "- Korundu: E1 (365 gün esası), E2, E3, E4.", "- Değişti: E5 (hesap kodu parametreden).",
    "- Düzeltildi: ŞÜPHE-1 (aynı tarih iki kez işlenmez).", "",
    "## Bilinen sınırlar", "- Depo adaptörü senin sisteminde yazılacak; transaction sınırı adaptörün sorumluluğunda.",
  ].join("\n"),
};

/** Mevcut sistem analizi: kaynak/ altındaki gerçek satırlara atıfla (atıf denetimi geçsin diye satırlar aranarak bulunur). */
function denemeMevcutSistem(kod: string): string {
  const kok = path.join(kod, "kaynak");
  const dosyalar: string[] = [];
  const gez = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const g of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, g.name);
      if (g.isDirectory()) gez(p);
      else if (/\.(pkb|pks|sql|java|cbl|cob|c|cpp|cs|py|js|ts|sh|ksh|md|txt)$/i.test(g.name)) dosyalar.push(p);
    }
  };
  gez(kok);
  const rel = (p: string) => path.relative(kod, p).split(path.sep).join("/");
  const ara = (re: RegExp) => {
    for (const d of dosyalar) {
      const satirlar = fs.readFileSync(d, "utf8").split("\n");
      const i = satirlar.findIndex((s) => re.test(s));
      if (i >= 0) return { yol: rel(d), satir: i + 1, satirlar };
    }
    return null;
  };
  const p = ["# Mevcut sistem analizi (deneme)", "", "> Bu belgeyi sahte motor üretti; gerçek bir ajan çalışmadı.", ""];
  const esas = ara(/c_gun_esasi\s+CONSTANT/i);
  if (esas) {
    const a = (re: RegExp, bitis?: RegExp) => {
      const b = ara(re);
      if (!b) return "";
      const son = bitis ? b.satirlar.findIndex((s, i) => i >= b.satir - 1 && bitis.test(s)) + 1 : 0;
      return son > b.satir ? `${b.yol}:${b.satir}-${son}` : `${b.yol}:${b.satir}`;
    };
    p.push("## Özet", "Gün sonunda faiz işleyen aktif kartlar için günlük faiz tahakkuku (reeskont) hesaplanır, hareket olarak yazılır, özet bakiyeye eklenir ve tek muhasebe fişi kesilir.", "",
      "## Giriş noktaları ve akış", `1. \`calistir(p_tarih)\` gün sonunda bir kez çağrılır: ${a(/PROCEDURE calistir/i, /END calistir/i)}`,
      `2. Kartlar okunur, her biri için günlük faiz hesaplanır: ${a(/FOR r IN/i, /END LOOP/i)}`, "",
      "## Veri modeli", `- Okunan: kart_bakiye (kart_no, faize_esas_bakiye, yillik_oran, durum, faiz_isler) ${a(/FROM kart_bakiye/i)}`,
      `- Yazılan: reeskont_hareket, reeskont_ozet, muhasebe_fis ${a(/INSERT INTO reeskont_hareket/i)}`, "",
      "## İş kuralları (E1...)",
      `- E1: Günlük faiz = bakiye × yıllık oran / 100 / gün esası, 2 haneye yuvarlanır. ${a(/RETURN ROUND/i)}`,
      `- E2: Sıfır ya da alacaklı bakiyeye faiz işlemez. ${a(/p_bakiye <= 0/i, /END IF/i)}`,
      `- E3: Yalnızca durum = 'A' ve faiz_isler = 'E' kartlar, kart numarasına göre sıralı. ${a(/WHERE durum = 'A'/i, /ORDER BY/i)}`,
      `- E4: Tutarı sıfırdan büyük her kart için hareket yazılır; toplam özet bakiyeye eklenir. ${a(/IF v_faiz > 0/i, /END IF/i)} ${a(/UPDATE reeskont_ozet/i, /WHERE urun/i)}`,
      `- E5: Günün toplamı tek muhasebe fişi olarak yazılır. ${a(/INSERT INTO muhasebe_fis/i, /VALUES/i)}`, "",
      "## Doküman ile kod farkları", `- FARK: Gün esası: doküman 360 diyor, kod 365 kullanıyor. ${esas.yol}:${esas.satir}`, "",
      "## Şüpheli davranışlar", `- ŞÜPHE-1: Aynı tarih ikinci kez çalışırsa hareketler ve fiş yeniden yazılır; tarih kontrolü yok. ${a(/PROCEDURE calistir/i, /END calistir/i)}`, "",
      "## Ölü kod ve sabit değerler", `- Muhasebe hesabı kodda sabit. ${a(/c_reeskont_hes\s+CONSTANT/i)}`);
  } else {
    p.push("## Özet", "Kaynaktaki dosyalar okundu (deneme modu ayrıntıya girmez).", "", "## İş kuralları (E1...)");
    dosyalar.slice(0, 3).forEach((d, i) => {
      const n = fs.readFileSync(d, "utf8").split("\n").length;
      p.push(`- E${i + 1}: ${path.basename(d)} dosyasının başındaki davranış. ${rel(d)}:1-${Math.max(1, Math.min(5, n - 1))}`);
    });
  }
  p.push("", "## Bilinmeyenler", "- Deneme modu: üretimdeki parametre değerleri doğrulanmadı.");
  return p.join("\n");
}

const DENEME_GELISIM = [
  "# Gelişim önerileri (deneme)", "", "> Bu belgeyi sahte motor üretti.", "",
  "Teslim edilen sürümü kullanıcı gözüyle değerlendirdim; en değerli üç adım:", "",
  "```kovan-gelisim",
  "- id: G1", "  baslik: Fotoğraftan hastalık tespiti",
  "  aciklama: Kullanıcı yaprağın fotoğrafını çeker; uygulama olası hastalığı ve bakım önerisini gösterir.",
  "  deger: Bitki kaybını azaltır; ürünün asıl vaadine yaklaştırır.", "  efor: L", "  oncelik: yuksek",
  "- id: G2", "  baslik: Hava durumuna göre sulama",
  "  aciklama: Yağmurlu günlerde dış mekân bitkileri için sulama hatırlatması ertelenir.",
  "  deger: Gereksiz sulama ve bildirim yorgunluğu azalır.", "  efor: M", "  oncelik: orta",
  "- id: G3", "  baslik: Ailece ortak bahçe",
  "  aciklama: Aynı bahçeyi birden çok kişi yönetir; 'Suladım' herkesin listesini günceller.",
  "  deger: Aynı bitkinin iki kez sulanmasını önler.", "  efor: M", "  oncelik: dusuk",
  "```",
].join("\n");

const DENEME_REESKONT_GELISIM = [
  "# Gelişim önerileri (deneme)", "", "> Bu belgeyi sahte motor üretti.", "",
  "Yeniden yazılan gün sonu işini işletme ve operasyon gözüyle değerlendirdim; en değerli üç adım:", "",
  "```kovan-gelisim",
  "- id: G1", "  baslik: Kesintide kaldığı yerden devam",
  "  aciklama: Gün sonu adımlara bölünür (hesapla, yaz, muhasebeleştir); kesintide baştan değil kaldığı adımdan sürer. Temporal gibi bir iş akışı motoruyla ya da adım tablosuyla.",
  "  deger: Gece yarıda kalan gün sonu sabah elle toparlanmaz; tekrar çalıştırma riski kalkar.", "  efor: M", "  oncelik: yuksek",
  "- id: G2", "  baslik: Kart bazında mutabakat raporu",
  "  aciklama: Her gün sonunda kart kart tahakkuk, toplam ve muhasebe fişi tek raporda; fark varsa uyarı.",
  "  deger: Muhasebe mutabakatı dakikalar sürer; gelir kaçağı erken görünür.", "  efor: S", "  oncelik: orta",
  "- id: G3", "  baslik: Gün esası ürün parametresi",
  "  aciklama: Gün esası (360 ya da 365) koddan çıkar, ürün parametresi olur.",
  "  deger: Yeni kart ürünlerinde kod değişmeden doğru hesap.", "  efor: S", "  oncelik: dusuk",
  "```",
].join("\n");

// ------------------------------ deneme: mevcut proje üzerinde iş ------------------------------
// Sahte motor yalnızca Kovan'ın örnek projesinde (ornekler/proje-ornek) gerçek bir değişiklik yapar: kalan kuruş hatası.
const DENEME_PROJE_DOSYA = "proje/src/taksit.mjs";
const DENEME_PROJE_HATALI = "  return Array.from({ length: adet }, () => taksit);";
const DENEME_PROJE_DUZELTME = "  const kalan = toplamKurus - taksit * adet;   // bölümden kalan kuruş son taksite eklenir; toplam tutar korunur\n" +
  "  return Array.from({ length: adet }, (_, i) => (i === adet - 1 ? taksit + kalan : taksit));";
const DENEME_PROJE_OZET = `// Taksit özeti: planın kısa dökümü.
import { taksitPlani } from "./taksit.mjs";

/**
 * @param {number} toplamKurus toplam tutar, kuruş
 * @param {number} adet taksit sayısı
 */
export function taksitOzeti(toplamKurus, adet) {
  const plan = taksitPlani(toplamKurus, adet);
  return { adet, taksit: plan[0], sonTaksit: plan[plan.length - 1], toplam: plan.reduce((a, b) => a + b, 0) };
}
`;
const denemeProjeTesti = (src: string, tur: "kalan" | "ozet" | "akis") => `import assert from "node:assert/strict";
import { test } from "node:test";
` + (tur === "kalan" ? `import { taksitPlani } from "${src}/taksit.mjs";

test("TS-1: taksitlerin toplamı tutara eşittir (kalan kuruş kaybolmaz)", () => {
  const plan = taksitPlani(10000, 3);
  assert.equal(plan.reduce((a, b) => a + b, 0), 10000);
});

test("TS-2: kalan kuruş son taksite eklenir", () => {
  assert.deepEqual(taksitPlani(10000, 3), [3333, 3333, 3334]);
});
` : tur === "ozet" ? `import { taksitOzeti } from "${src}/ozet.mjs";

test("TS-3: özet taksit sayısını, tutarları ve toplamı verir", () => {
  assert.deepEqual(taksitOzeti(10000, 3), { adet: 3, taksit: 3333, sonTaksit: 3334, toplam: 10000 });
});
` : `import { taksitOzeti } from "${src}/ozet.mjs";
import { taksitPlani } from "${src}/taksit.mjs";

test("TS-E2E-1: plan ile özet aynı toplamı verir", () => {
  for (const [tutar, adet] of [[10000, 3], [9999, 7], [12345, 12]]) {
    assert.equal(taksitPlani(tutar, adet).reduce((a, b) => a + b, 0), tutar);
    assert.equal(taksitOzeti(tutar, adet).toplam, tutar);
  }
});
`);
const DENEME_PROJE_PLAN = `# Teslim planı (deneme)

> Bu belgeyi sahte motor üretti; gerçek bir ajan çalışmadı.

| Kalem | Ne | Yazılımcı |
|---|---|---|
| P1 | Kalan kuruş son taksite | BE |
| P2 | Taksit özeti | BE |

\`\`\`kovan-plan
kalemler:
  - id: P1
    baslik: Kalan kuruş son taksite
    gelistirici: be-yazilimci
    bagimli: []
    kabul: [K1]
    kapsam: Tutar taksit sayısına tam bölünmediğinde kalan kuruş son taksite eklenir; taksitlerin toplamı tutara eşit olur.
  - id: P2
    baslik: Taksit özeti
    gelistirici: be-yazilimci
    bagimli: [P1]
    kabul: [K2]
    kapsam: taksitOzeti(toplam, adet) taksit sayısını, taksit tutarını, son taksiti ve toplamı döndürür.
\`\`\`
`;

/** kok altındaki ilk metin dosyası (göreli); gizli ve bağımlılık klasörlerine girmez. */
function denemeIlkDosya(kok: string, onek: string): string | null {
  if (!fs.existsSync(kok)) return null;
  for (const g of fs.readdirSync(kok, { withFileTypes: true }).sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name))) {
    if (g.name.startsWith(".") || g.name === "node_modules") continue;
    if (g.isFile() && fs.statSync(path.join(kok, g.name)).size > 0) return `${onek}/${g.name}`;
    if (g.isDirectory()) { const alt = denemeIlkDosya(path.join(kok, g.name), `${onek}/${g.name}`); if (alt) return alt; }
  }
  return null;
}

function denemeKesif(kod: string, fikir: string): string {
  const ornek = fs.existsSync(path.join(kod, DENEME_PROJE_DOSYA));
  const [tur, boyut] = /entegrasyon|entegre/i.test(fikir) ? ["entegrasyon", "buyuk"] : /özellik|özet/i.test(fikir) ? ["ozellik", "orta"] : ["hata", "kucuk"];
  const ek = denemeIlkDosya(path.join(kod, "kaynak"), "kaynak");
  const ekSatiri = ek ? [`- Ek: verilen belge okundu (${ek}:1).`] : [];
  const blok = (yazma: string, test: string, gerekce: string) => ["## İş önerisi", "```kovan-is", `tur: ${tur}`, `boyut: ${boyut}`, `gerekce: ${gerekce}`,
    "taraflar:", "  be:", `    yazma_alani: [${yazma}]`, `    test_alani: ${test}`, "```"];
  if (!ornek) {
    const ilk = denemeIlkDosya(path.join(kod, "proje"), "proje") ?? "proje/README.md";
    return ["# Keşif (deneme)", "", "> Bu belgeyi sahte motor üretti; gerçek bir ajan çalışmadı. Sahte motor yalnızca Kovan'ın örnek projesinde (ornekler/proje-ornek) gerçek bir değişiklik yapar.", "",
      "## İstek", kisalt(fikir.trim(), 300) || "-", "", "## İşin geçtiği yer", `- Projede ilk bakılan dosya (${ilk}:1).`, ...ekSatiri, "",
      ...blok(ilk, "proje/kovan-deneme-test", "Deneme modu: proje tanınmadı; öneri yalnızca akışı göstermek için.")].join("\n");
  }
  const satirlar = fs.readFileSync(path.join(kod, DENEME_PROJE_DOSYA), "utf8").split("\n");
  const n = Math.max(1, satirlar.findIndex((x) => x.includes("Math.floor")) + 1);
  return ["# Keşif (deneme)", "", "> Bu belgeyi sahte motor üretti; gerçek bir ajan çalışmadı.", "",
    "## İstek", kisalt(fikir.trim(), 300) || "-", "",
    "## İşin geçtiği yer", `- \`taksitPlani\` tutarı taksit sayısına böler ve aşağı yuvarlar (${DENEME_PROJE_DOSYA}:${n}); bütün taksitler aynı tutarla döner (${DENEME_PROJE_DOSYA}:${n + 1}).`, ...ekSatiri, "",
    "## Kök neden", "Bölümden kalan kuruş hiçbir taksite eklenmiyor: 100,00 TL 3 taksitte 33,33 + 33,33 + 33,33 = 99,99 TL ediyor.", "",
    "## Etki", `- Değişecek: ${DENEME_PROJE_DOSYA}`, "- Mevcut testler yalnızca tam bölünen tutarları sınıyor (proje/test/taksit.test.mjs:6); kalanlı bölme sınanmıyor.", "",
    "## Korunacak davranışlar", "- Tam bölünen tutarlarda sonuç değişmez; geçersiz tutar ve taksit sayısı reddedilir.", "",
    ...blok("proje/src", "proje/test/kovan", "Tek fonksiyonda kalan kuruş kaybı; bir kaynak dosyası etkileniyor, mevcut testler korunuyor.")].join("\n");
}

/** Mevcut proje akışında sahte motorun üretimi. null: genel deneme belgesine düş. */
function denemeProje(c: AjanCagrisi, ilkTur: boolean): string | null {
  if (c.rol === "proje-yoneticisi" && c.asama_id === "teslim-plani") return DENEME_PROJE_PLAN;
  const kod = c.cwd;
  if (path.basename(kod) !== "kod") return null;
  if (c.asama_id === "kesif") return denemeKesif(kod, /### fikir\n([\s\S]*?)(?=\n### |\n## |$)/.exec(c.istem)?.[1] ?? "");
  if (!["test-otomasyon", "be-yazilimci", "fe-yazilimci"].includes(c.rol)) return null;
  if (!fs.existsSync(path.join(kod, DENEME_PROJE_DOSYA))) return "Deneme modu: bu proje Kovan'ın örnek projesi değil; sahte motor gerçek bir değişiklik yapamaz.";
  const yaz = (rel: string, metin: string) => {
    fs.mkdirSync(path.dirname(path.join(kod, rel)), { recursive: true });
    fs.writeFileSync(path.join(kod, rel), metin, "utf8");
  };
  const kalem = /^(p\d+)-/.exec(c.asama_id)?.[1] ?? null;
  if (c.rol === "test-otomasyon") {
    const alan = /YAZMA ALANIN[^\n]*?`([^`]+)`/.exec(c.istem)?.[1].replace(/\/$/, "") ?? "proje/test/kovan";
    const src = path.posix.relative(alan, "proje/src");
    const [dosya, tur] = c.asama_id === "birlestirme" ? ["akis.test.mjs", "akis"] as const : kalem === "p2" ? ["ozet.test.mjs", "ozet"] as const : ["kalan-kurus.test.mjs", "kalan"] as const;
    yaz(`${alan}/${dosya}`, denemeProjeTesti(src, tur));
    return c.asama_id === "birlestirme" ? `Deneme modu: uçtan uca senaryo (TS-E2E-1) ${alan}/${dosya} dosyasına eklendi; projenin bütün testleri birlikte koşuyor.`
      : `Deneme modu: ${alan}/${dosya} yazıldı. Bugünkü kodda kırmızı: beklenen davranış henüz yok.`;
  }
  if (process.env.KOVAN_DENEME_IHLAL && ilkTur) {
    // Sınır denemesi: yazma alanı dışındaki proje dosyasına ve kilitli teste dokunur; sistem geri almalı
    fs.appendFileSync(path.join(kod, "proje/README.md"), "\nalan dışı değişiklik\n");
    const kilitli = path.join(kod, "proje/test/kovan/kalan-kurus.test.mjs");
    if (fs.existsSync(kilitli)) fs.appendFileSync(kilitli, "\n// testi gevşettim\n");
  }
  if (kalem === "p2") { yaz("proje/src/ozet.mjs", DENEME_PROJE_OZET); return "Deneme modu: proje/src/ozet.mjs eklendi; testler yeşil."; }
  const kaynak = fs.readFileSync(path.join(kod, DENEME_PROJE_DOSYA), "utf8");
  if (kaynak.includes(DENEME_PROJE_HATALI)) yaz(DENEME_PROJE_DOSYA, kaynak.replace(DENEME_PROJE_HATALI, DENEME_PROJE_DUZELTME));
  return `Deneme modu: ${DENEME_PROJE_DOSYA} düzeltildi: bölümden kalan kuruş son taksite ekleniyor. Yeni testler ve projenin mevcut testleri yeşil.`;
}

/** Deneme belgelerinin sonuna eklenen karar özeti: kapı kartını ve Büyük Birader'in izlemesini göstermek için. */
function denemeOzeti(asamaId: string): string {
  return ["", "", "```kovan-ozet", "kararlar:",
    `  - baslik: ${asamaId} ana kararı`, "    karar: Bu aşama, girdilerdeki isteği en sade yoldan karşılayacak biçimde karara bağlandı (deneme).",
    "    neden: Deneme modu; gerçek bir ajan çalışmadı.", "    alternatif: Daha kapsamlı bir çözüm; ilk sürüm için gereksiz.", "    tur: karar",
    "  - baslik: Varsayılan kapsam", "    karar: Girdilerde yazmayan konular kapsam dışı sayıldı.", "    neden: Belirsiz konuda en dar yorum seçildi.", "    tur: varsayim",
    "```"].join("\n");
}

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
    else if (c.gorev_turu === "karar") { yapisal = DenemeMotoru.oyla(c); metin = JSON.stringify(yapisal); }
    else if (c.gorev_turu === "sohbet") {
      const soru = /^# Soru \(projenin sahibinden\)\n\n([\s\S]*?)(?=\n## |$)/.exec(c.istem)?.[1].trim() ?? "";
      metin = `Deneme modu: sorunu aldım ("${kisalt(soru, 120)}"). Gerçek bir ajan çalışmadığı için yalnızca akışı gösteriyorum.\n\n` +
        "- Belgedeki karar girdilere dayanıyor; değiştirmek istersen kapıda **Değiştir** de.\n- Bu cevabı beğendiysen **Karara bağla** ile deftere yazabilirsin.";
    } else {
      metin = this.uret(c);
      // Karar özeti istendiyse (kapı ya da Büyük Birader açık) ve çıktı bir soru bloğu değilse sona eklenir
      if (c.sistem.includes("# Karar özeti (kovan-ozet)") && !metin.includes("```kovan-soru")) metin += denemeOzeti(c.asama_id);
    }
    const girdi = Math.floor((c.sistem.length + c.istem.length) / 4);
    const cikti = Math.max(60, Math.floor(metin.length / 4));
    return sonuc({
      ok: true, metin, yapisal, maliyet: Math.round((girdi * 3 / 1e6 + cikti * 15 / 1e6) * 10_000) / 10_000,
      girdi_token: girdi, cikti_token: cikti, tur_sayisi: c.araclar.length ? 4 : 1, sure_sn: (Date.now() - t0) / 1000,
    });
  }

  private static isaret(asamaId: string) { return `.deneme-duzeltildi-${asamaId}`; }

  /** Ortak karar: herkes soranın önerisine katılır; "Kişisel veri"de Mimar ayrışır (insana gider). */
  private static oyla(c: AjanCagrisi): Record<string, unknown> {
    const oylar = [...c.istem.matchAll(/\n## Soru (\d+): (.+?) \(soran: [^)]*\)\n([\s\S]*?)(?=\n## |$)/g)].map((m) => {
      const secenekler = [...m[3].matchAll(/^(\d+)\. (.+?) — /gm)];
      const onerilen = Number(secenekler.find((x) => x[2].includes("(Önerilen)"))?.[1] ?? 1);
      const ayris = (m[2] === "Kişisel veri" || m[2] === "Gün esası") && c.rol === "mimar";
      return {
        soru: Number(m[1]), secim: [ayris ? 2 : onerilen], insana_birak: false,
        gerekce: ayris ? (m[2] === "Gün esası" ? "Deneme modu: doküman kurumun onaylı kuralı, kod ondan sapmış." : "Deneme modu: cihazlar arası eşitleme için hesap gerekir.")
          : "Deneme modu: önerilen seçenek girdilerle uyumlu.",
      };
    });
    return { oylar };
  }

  private incele(c: AjanCagrisi): Record<string, unknown> {
    if (c.rol === "buyuk-birader") {
      // Akışı göstermek için teknik planda bir uyarı; gerisi uygun
      if (c.asama_id === "teknik-plan") {
        return { hukum: "DIKKAT", ozet: "Deneme modu: teknik plan kapsamla uyumlu; bir noktayı bilmen iyi olur.",
          bulgular: [{ konu: "Varsayılan kapsam", kanit: "belgeler/teknik-plan.md, karar özeti: 'Girdilerde yazmayan konular kapsam dışı sayıldı'", aciklama: "Kapsam dışı sayılanlar arasında beklediğin bir şey olabilir; kapıda kontrol et." }],
          oneri: "Kapıda 'Varsayılan kapsam' maddesine bak." };
      }
      return { hukum: "UYGUN", ozet: "Deneme modu: aşama, fikir ve önceki kararlarla tutarlı.", bulgular: [], oneri: "" };
    }
    const sorabilir = c.sistem.includes("kovan-soru");
    if (c.rol === "mevzuat" && c.asama_id === "analiz") {
      const fikir = /### fikir\n([\s\S]*?)(?=\n### |\n## |$)/.exec(c.istem)?.[1] ?? "";
      if (!MEVZUAT_IZI.test(fikir)) {
        return { karar: "ONAY", gerekce: "Deneme modu: kişisel veri, ödeme ya da düzenlemeye tabi bir konu yok; mevzuat açısından kapsam dışı.", bulgular: [], kapsam_disi: true };
      }
      if (sorabilir && !c.istem.includes("### Kişisel veri")) {
        return { karar: "SORU", gerekce: "Kişisel veri toplanıp toplanmayacağı belirsiz; KVKK gereksinimleri buna bağlı.", bulgular: [], sorular: DENEME_UYUM_SORUSU };
      }
    }
    let duzeltildi: boolean;
    // Kod aşamasının incelemesi: düzeltme yazılımcının bıraktığı işaret dosyasından anlaşılır; belge aşamasında belgeden
    if (c.istem.includes("## İncelenen\n")) duzeltildi = DenemeMotoru.ara(c.cwd, DenemeMotoru.isaret(c.asama_id));
    else duzeltildi = c.istem.split("## Referans belgeler")[0].includes("(düzeltildi)");
    if (c.rol === "mevcut-sistem-analisti" && c.asama_id === "hedef-analiz" && !duzeltildi) {
      return { karar: "DUZELT", gerekce: "Deneme modu: eşdeğerlik açığı.", bulgular: ["ŞÜPHE-1 (aynı tarihte yeniden çalıştırmada çift kayıt) için koru mu, düzelt mi kararı yazılmamış."] };
    }
    // Mevcut proje akışında bilerek düzeltme istenmez: işaret dosyası projeye (ve yamaya) karışırdı
    if (c.istem.includes("## Mevcut proje\n")) return { karar: "ONAY", gerekce: "Deneme modu: kriterler karşılanıyor.", bulgular: [] };
    const birKezDuzelt = (c.asama_id === "analiz" && ["urun-sahibi", "mimar"].includes(c.rol))
      || (c.asama_id === "be-gelistirme" && ["urun-sahibi", "mimar"].includes(c.rol))
      || (/^(v\d+-)?p1-is-kalemi$/.test(c.asama_id) && c.rol === "mimar");
    if (birKezDuzelt && !duzeltildi) {
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

  /** Kalem aşamasının deneme tanımı: "p3-kabul-testi" -> p3 (FE yazma alanı varsa p3-fe). */
  private static kalem(c: AjanCagrisi): { id: string; tanim: (typeof DENEME_KALEMLER)[string] } | null {
    const m = /^(?:v\d+-)?(p\d+)-/.exec(c.asama_id);
    if (!m) return null;
    if (/## İş kalemi\nP\d+: (Günlük faiz hesabı|Reeskont hesaplama|Gün sonu akışı)/.test(c.istem)) {
      return DENEME_REESKONT[m[1]] ? { id: m[1], tanim: DENEME_REESKONT[m[1]] } : null;
    }
    const fe = /`(?:testler\/fe\/|frontend\/)/.test(c.istem.split("YAZMA ALANIN")[1]?.split("\n")[0] ?? "");
    const anahtar = fe ? `${m[1]}-fe` : m[1];
    return DENEME_KALEMLER[anahtar] ? { id: m[1], tanim: DENEME_KALEMLER[anahtar] } : null;
  }

  private uret(c: AjanCagrisi): string {
    const geriBildirimVar = c.istem.includes("## Düzeltme istekleri");
    const geriBildirim = geriBildirimVar ? c.istem.split("## Düzeltme istekleri")[1] : "";
    const sorabilir = c.sistem.includes("kovan-soru");
    const replatform = c.istem.includes("## Mevcut sistem\nBu iş bir replatform");
    if (c.rol === "mevcut-sistem-analisti" && c.asama_id === "mevcut-sistem") return denemeMevcutSistem(c.cwd);
    if (sorabilir && c.rol === "analist" && c.asama_id === "hedef-analiz" && c.istem.includes("FARK: Gün esası") && !c.istem.includes("### Gün esası")) {
      return "Hedef analizi yazmadan önce bir karar gerekiyor.\n\n```kovan-soru\n" + JSON.stringify(DENEME_GUN_ESASI_SORUSU, null, 2) + "\n```";
    }
    if (sorabilir && !replatform && c.rol === "urun-sahibi" && c.asama_id === "brif" && !c.istem.includes("### Arayüz dili")) {
      return "Brifi yazmadan önce bir kararına ihtiyacım var.\n\n```kovan-soru\n" + JSON.stringify(DENEME_PO_SORUSU, null, 2) + "\n```";
    }
    if (c.istem.includes("## Mevcut proje\n")) {
      const r = denemeProje(c, !geriBildirimVar);
      if (r !== null) return r;
    }
    const cwd = c.cwd;
    const yaz = (rel: string, metin: string) => {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), metin, "utf8");
    };
    if (path.basename(cwd) === "kod") {
      const kalem = DenemeMotoru.kalem(c);
      // ilk tur: istemde düzeltme yok ve kalemin kendi notu henüz yazılmamış
      const ilkTur = !geriBildirimVar;
      if (c.rol === "test-otomasyon") {
        if (c.asama_id === "test-altyapisi") {
          yaz("test-be.sh", deneme_sh("be"));
          if (c.istem.includes("test-fe.sh")) yaz("test-fe.sh", deneme_sh("fe"));
          yaz("testler/README.md", "# Testler (deneme)\n\nHer iş kalemi testlerini testler/<taraf>/<kalem>/ altına yazar; test-be.sh ve test-fe.sh hepsini koşar.\n");
          return "Deneme modu: test altyapısı hazır. test-be.sh" + (c.istem.includes("test-fe.sh") ? " ve test-fe.sh" : "") + " testler/<taraf>/ altındaki bütün kalem testlerini koşar.";
        }
        if (kalem) {
          const klasor = /`(testler\/(?:be|fe)\/[a-z0-9-]+)\/`/.exec(c.istem)?.[1] ?? `testler/${kalem.tanim.taraf}/${kalem.id}`;
          yaz(`${klasor}/${kalem.tanim.test}`, kalem.tanim.testMetni);
          return `Deneme modu: ${kalem.id.toUpperCase()} kabul testleri yazıldı (şu an kırmızı; kod henüz yok).\n\n| Senaryo | Test |\n|---|---|\n` +
            kalem.tanim.senaryo.map((x) => `| ${x} | ${klasor}/${kalem.tanim.test} |`).join("\n");
        }
        if (c.asama_id === "birlestirme" && /Günlük faiz hesabı/.test(c.istem)) {
          yaz("testler/be/entegrasyon/altin.test.mjs", DENEME_REESKONT_ENTEGRASYON);
          return "Deneme modu: eski sistemin örnek verisiyle tam bir gün sonu (TS-E2E-1, altın test) eklendi; bütün testler birlikte koşuyor.";
        }
        if (c.asama_id === "birlestirme") {
          yaz("testler/be/entegrasyon/akis.test.mjs", DENEME_ENTEGRASYON);
          return "Deneme modu: uçtan uca senaryo (TS-E2E-1) eklendi; bütün kalemlerin testleri birlikte koşuyor.";
        }
        // Mini akış: tek seferde testler
        yaz("testler/be/sulama.test.mjs", DENEME_BE_TEST);
        yaz("test-be.sh", deneme_sh("be"));
        let satir = "| TS-BE-1: sonraki sulama tarihi | testler/be/sulama.test.mjs |\n| TS-BE-2: geçersiz aralık | testler/be/sulama.test.mjs |";
        if (c.istem.includes("test-fe.sh")) {
          yaz("testler/fe/panel.test.mjs", DENEME_KALEMLER["p3-fe"].testMetni.replace(/\.\.\/\.\.\/\.\.\//g, "../../"));
          yaz("test-fe.sh", deneme_sh("fe"));
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
        if (process.env.KOVAN_DENEME_IHLAL && ilkTur) {
          for (const d of ["be", "fe"]) {
            const klasor = path.join(cwd, "testler", d);
            if (!fs.existsSync(klasor)) continue;
            for (const f of fs.readdirSync(klasor)) if (f.endsWith(".test.mjs")) fs.appendFileSync(path.join(klasor, f), "\n// testi gevşettim\n");
          }
          yaz("notlar.txt", "yazma alanı dışı");
        }
        if (alan === "frontend") yaz("frontend/index.html", deneme_fe(ilkTur ? "" : '<p id="hata" role="alert"></p>'));
        else if (kalem && kalem.tanim.taraf === "be") yaz(kalem.tanim.dosya, ilkTur && kalem.tanim.hatali ? kalem.tanim.hatali : kalem.tanim.kod);
        else yaz("backend/src/sulama.mjs", ilkTur ? DENEME_KALEMLER.p1.hatali! : DENEME_KALEMLER.p1.kod);
        const bilerekHatali = ilkTur && (alan === "frontend" || !kalem || Boolean(kalem.tanim.hatali));
        if (!ilkTur && !geriBildirim.includes(": KIRMIZI")) yaz(`${alan}/${DenemeMotoru.isaret(c.asama_id)}`, "1");
        return `Deneme modu: ${alan}/ yazıldı${bilerekHatali ? " (ilk tur, bilerek hatalı)." : ilkTur ? "." : ", düzeltme istekleri uygulandı."}`;
      }
    }

    const adrEki = c.rol === "mimar" && c.asama_id === "teknik-plan" ? "\n\n" + DENEME_ADR(replatform) : "";
    if (c.rol === "proje-yoneticisi" && c.asama_id === "teslim-plani") return replatform ? DENEME_REESKONT_PLAN : DENEME_PLAN(c.istem.includes("### ux-ozeti"));
    if (c.rol === "urun-sahibi" && c.asama_id === "gelisim") return replatform ? DENEME_REESKONT_GELISIM : DENEME_GELISIM;
    if (replatform && DENEME_REESKONT_BELGELER[c.asama_id]) {
      let belge = DENEME_REESKONT_BELGELER[c.asama_id];
      // İlk turda şüpheli davranış için karar eksik: eşdeğerlik onaycısı bunu yakalar
      if (c.asama_id === "hedef-analiz" && !geriBildirimVar) belge = belge.split("\n").filter((x) => !x.includes("ŞÜPHE-1") && !x.startsWith("- K5")).join("\n");
      return belge + adrEki + (geriBildirimVar ? "\n\n(düzeltildi) Düzeltme istekleri uygulandı." : "");
    }

    const m = /### fikir\n([\s\S]*?)(?=\n### |\n## |$)/.exec(c.istem);
    const satirlar = [
      `# ${c.asama_id} (deneme)`, "", "> Bu belgeyi sahte motor üretti; gerçek bir ajan çalışmadı.", "",
      "## Özet", kisalt(m?.[1].trim() ?? "", 300) || "-", "", "## Maddeler",
      ...(replatform
        ? ["- K1: Korunan kurallarda eski sistemle aynı sonuç (eşdeğerlik).", "- K2: Günlük faiz 365 gün esasıyla, kuruşa yuvarlanır.",
          "- K3: Yalnızca aktif ve faiz işleyen kartlar.", "- K4: Günün toplamı tek fiş; hesap parametreden.", "- K5: Aynı tarih iki kez işlenmez."]
        : ["- K1: Bir sonraki sulama tarihi doğru hesaplanır.", "- K2: Geçersiz sulama aralığı reddedilir.", "- K3: 'Suladım' son sulamayı günceller."]),
    ];
    if (c.istem.includes("## Alınan kararlar")) satirlar.push("", "Alınan kararlar dikkate alındı.");
    if (c.rol === "test-analisti" && replatform) {
      satirlar.push("", "## Test senaryoları", "| ID | Kalem | Eski kural | Senaryo | Beklenen |", "|---|---|---|---|---|",
        "| TS-BE-1 | P1 | E1 | 10.000 TL, %36 | 9,86 |", "| TS-BE-2 | P1 | E2 | sıfır ve alacaklı bakiye | 0 |",
        "| TS-BE-3 | P2 | E3, E4 | örnek kartlar | eski sistemle aynı, toplam 115,89 |", "| TS-BE-4 | P3 | E5 | gün sonu | tek fiş, hesap parametreden |",
        "| TS-BE-5 | P3 | ŞÜPHE-1 | aynı tarih iki kez | ikinci çalıştırma yazmaz |", "| TS-E2E-1 | - | hepsi | kaynak/ örnek verisi | beklenen.csv ile aynı |");
    } else if (c.rol === "test-analisti") {
      satirlar.push("", "## Test senaryoları", "| ID | Kalem | Taraf | Senaryo | Beklenen |", "|---|---|---|---|---|",
        "| TS-BE-1 | P1 | BE | Son sulama + 7 gün | doğru tarih |", "| TS-BE-2 | P1 | BE | Aralık 0 | RangeError |",
        "| TS-BE-3 | P2 | BE | Bugün sulanacaklar | yalnızca günü gelenler |", "| TS-BE-4 | P3 | BE | 'Suladım' | son sulama bugün |",
        "| TS-FE-1 | P3 | FE | Bugün sulanacaklar listesi | görünür |", "| TS-FE-2 | P3 | FE | Boş bitki adı | hata mesajı |");
    }
    if (geriBildirimVar) satirlar.push("", "(düzeltildi) Düzeltme istekleri uygulandı.");
    return satirlar.join("\n") + adrEki;
  }
}
