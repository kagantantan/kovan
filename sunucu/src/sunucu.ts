// Fastify sunucusu: derlenmiş arayüz (arayuz/dist) + JSON API. Yalnızca 127.0.0.1'de dinler.
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akisOzeti, akislariYukle, tumAdimlar } from "./akislar.js";
import { HEDEF_YIGINLAR, ayarlariYukle, type Ayarlar } from "./ayarlar.js";
import { Depo } from "./depo.js";
import { kartAyarlariniUygula, kartOzeti, kartlariYukle } from "./kartlar.js";
import { ClaudeMotoru, DenemeMotoru, OllamaMotoru, type Motor } from "./motor.js";
import { sistemKasasi, type Kasa } from "./kasa.js";
import { UyumluMotor } from "./uyumlu.js";
import { Orkestrator, type Cevap } from "./orkestrator.js";
import { KovanHatasi } from "./ortak.js";
import type { AjanOzeti, DurumYaniti } from "./tipler.js";

// Ajanların ürettiği HTML (prototip, frontend) Kovan'ın kendi kökeninden yalıtılır:
// betikleri çalışır ama Kovan API'sine Kovan adına istek atamaz.
const ONIZLEME_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals";

// Kovan arayüzünün kendisi için: yalnızca kendi dosyaları, çerçeveye alınamaz.
const ARAYUZ_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
};
const METIN = new Set([".txt", ".md", ".ts", ".tsx", ".jsx", ".yaml", ".yml", ".sh", ".csv", ".env.example"]);

function mimeTuru(dosya: string): string {
  const uz = path.extname(dosya).toLowerCase();
  return MIME[uz] ?? (METIN.has(uz) ? "text/plain; charset=utf-8" : "application/octet-stream");
}

export interface Kovan {
  app: FastifyInstance;
  ork: Orkestrator;
  depo: Depo;
  cfg: Ayarlar;
  motorlar: Map<string, Motor>;
  calisma: string;
  surum: string;
}

export interface KurulumSecenekleri {
  /** Testler için: kovan.yaml'ın üstüne yazılacak ayarlar. */
  ayar?: Partial<Ayarlar>;
  /** Derlenmiş arayüz klasörü (varsayılan: arayuz/dist). */
  arayuz?: string;
  /** Testler için: motorları değiştir (ör. sahte claude). */
  motorlar?: Map<string, Motor>;
  /** Dış ayar dosyası; verilmezse KOVAN_AYAR, null ise hiç okunmaz. */
  dis_ayar?: string | null;
  /** API anahtarı kasası; verilmezse işletim sisteminin kasası, null ise kasa yok. */
  kasa?: Kasa | null;
}

export async function kovanKur(kok: string, secenek: KurulumSecenekleri = {}): Promise<Kovan> {
  const cfg = { ...ayarlariYukle(kok, secenek.dis_ayar), ...secenek.ayar };
  const kartlar = kartlariYukle(path.join(kok, "ajanlar"));
  kartAyarlariniUygula(kartlar, cfg.ajanlar);
  const akislar = akislariYukle(path.join(kok, "akislar"), kartlar);
  const calisma = cfg.calisma_dizini ? path.resolve(cfg.calisma_dizini.replace(/^~(?=$|\/)/, os.homedir())) : path.join(kok, "calisma");
  fs.mkdirSync(calisma, { recursive: true });
  const surum = String(JSON.parse(fs.readFileSync(path.join(kok, "package.json"), "utf8")).version ?? "?");

  const kasa = secenek.kasa === undefined ? sistemKasasi() : secenek.kasa;
  const motorlar = secenek.motorlar ?? new Map<string, Motor>([
    ...(cfg.claude ? [["claude", new ClaudeMotoru(cfg.claude_yolu, cfg.api_anahtarini_yoksay)] as [string, Motor]] : []),
    ["deneme", new DenemeMotoru(cfg.deneme_gecikme_sn)],
    ...Object.entries(cfg.motorlar).map(([ad, m]): [string, Motor] =>
      [ad, m.tur === "openai" ? new UyumluMotor(ad, m, kasa) : new OllamaMotoru(ad, m.adres, m.model, cfg.claude_yolu)]),
  ]);
  const depo = new Depo(calisma);
  const ork = new Orkestrator(calisma, cfg, depo, kartlar, akislar, motorlar);

  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const izinliHostlar = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
  const izinliKokenler = new Set([...izinliHostlar].map((h) => `http://${h}`));

  // Tarayıcında açık başka bir sitenin Kovan'a istek atıp fikir başlatmasını ya da onay vermesini engeller.
  // Host denetimi DNS rebinding'e, köken denetimi siteler arası POST'a karşı.
  app.addHook("onRequest", async (req, reply) => {
    if (!izinliHostlar.has(String(req.headers.host ?? ""))) {
      return reply.code(403).send({ detail: `İzin verilmeyen adres: ${req.headers.host ?? "-"}` });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const koken = req.headers.origin;
      if (koken !== undefined && !izinliKokenler.has(koken)) return reply.code(403).send({ detail: `İzin verilmeyen köken: ${koken}` });
    }
  });

  app.setErrorHandler((e: Error & { kod?: number; statusCode?: number; validation?: unknown }, _req, reply) => {
    if (e instanceof KovanHatasi) return reply.code(e.kod).send({ detail: e.message });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ detail: e.message });
    console.error(e);
    return reply.code(500).send({ detail: `Beklenmeyen hata: ${e.message}` });
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ detail: `Bulunamadı: ${req.url}` }));

  const govde = (b: unknown): Record<string, unknown> => (b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {});
  const metin = (v: unknown) => (v === undefined || v === null ? "" : String(v));

  // ------------------------------ API ------------------------------
  app.get("/api/durum", async (): Promise<DurumYaniti> => {
    const durumlar: DurumYaniti["motorlar"] = {};
    for (const [ad, m] of motorlar) durumlar[ad] = await m.durumOzeti();
    return {
      surum, varsayilan_motor: cfg.motor, calisma, paralel_fikir: cfg.paralel_fikir, paralel_inceleme: cfg.paralel_inceleme,
      ajan_sorulari: cfg.ajan_sorulari, en_fazla_soru_turu: cfg.en_fazla_soru_turu, motorlar: durumlar,
      hedef_yiginlar: HEDEF_YIGINLAR,
      ornek_kaynak: fs.existsSync(path.join(kok, "ornekler", "reeskont-eski")) ? path.join(kok, "ornekler", "reeskont-eski") : null,
      yerel_motor: ork.yerelMotorAdi(),
      modlar: ork.acikModlar(),
      dis_ayar: cfg.dis_ayar,
      ortak_karar: {
        acik: cfg.ortak_karar.acik, kural: cfg.ortak_karar.kural,
        kurul: cfg.ortak_karar.kurul.map((id) => ({ id, ad: kartlar.get(id)?.ad ?? id, kisa: kartlar.get(id)?.kisaltma ?? id })),
      },
    };
  });

  // Kurum LLM'inin API anahtarı (Ayarlar ekranı). Anahtar yalnızca gelir; hiçbir yanıtta, günlükte ya da dosyada yok.
  const uyumluMotor = (ad: string): UyumluMotor => {
    const m = motorlar.get(ad);
    if (!(m instanceof UyumluMotor)) throw new KovanHatasi(`OpenAI uyumlu motor yok: ${ad}`, 404);
    return m;
  };
  const baglantiSonucu = async (m: UyumluMotor) => {
    const hazir = await m.saglik(true);
    return { ...(await m.durumOzeti()), hazir, modeller: m.modeller.slice(0, 50) };
  };
  app.post<{ Params: { ad: string } }>("/api/motorlar/:ad/anahtar", async (req) => {
    const m = uyumluMotor(req.params.ad);
    const g = govde(req.body);
    if (typeof g.anahtar !== "string") throw new KovanHatasi("API anahtarı gerekli.");
    m.anahtarAyarla(g.anahtar, g.kalici === true);
    return baglantiSonucu(m);
  });
  app.post<{ Params: { ad: string } }>("/api/motorlar/:ad/anahtar-sil", async (req) => {
    const m = uyumluMotor(req.params.ad);
    m.anahtarSil();
    return baglantiSonucu(m);
  });
  app.post<{ Params: { ad: string } }>("/api/motorlar/:ad/dene", async (req) => baglantiSonucu(uyumluMotor(req.params.ad)));

  app.get("/api/ajanlar", async () => [...kartlar.values()].map((k): AjanOzeti => {
    const m = motorlar.get(k.motor);
    return {
      ...kartOzeti(k),
      motor_modeli: m ? m.modelSec(k) : k.model,
      motor_yerel: Boolean(m?.yerel),
      uretir: [...akislar.values()].flatMap((ak) => tumAdimlar(ak)
        .filter((a) => a.ajan === k.id || (a.ajan === "{gelistirici}" && ak.asamalar.some((s) => k.id in s.gelistiriciler)))
        .map((a) => `${a.ad} (${ak.ad})`)),
      onaylar: [...akislar.values()].flatMap((ak) => tumAdimlar(ak).filter((a) => a.dogrulama.some((v) => v.inceleyen === k.id)).map((a) => `${a.ad} (${ak.ad})`)),
    };
  }));

  // Var olan sistemle başlayan akışlar (replatform) sonda: sıfırdan ürün akışları birbirinin kısası, uzunu
  app.get("/api/akislar", async () => [...akislar.values()]
    .sort((a, b) => Number(a.kaynak === "zorunlu") - Number(b.kaynak === "zorunlu"))
    .map((a) => akisOzeti(a, kartlar)));

  app.get("/api/fikirler", async () => ork.fikirListesi());

  app.post("/api/fikirler", async (req) => {
    const b = govde(req.body);
    // kaynaklar: liste ya da satır satır yollar (replatform: mevcut sistemin klasörleri)
    const kaynaklar = Array.isArray(b.kaynaklar) ? b.kaynaklar.map(String) : metin(b.kaynaklar).split("\n");
    const fid = await ork.yeniFikir(metin(b.baslik), metin(b.metin), metin(b.profil), metin(b.motor) || cfg.motor,
      { kaynaklar, hedef_yigin: metin(b.hedef_yigin) });
    return { id: fid };
  });

  app.get<{ Params: { fid: string } }>("/api/fikirler/:fid", async (req) => ork.fikirDetayi(req.params.fid));

  app.get<{ Params: { fid: string }; Querystring: { yol?: string } }>("/api/fikirler/:fid/dosya", async (req) => {
    if (!req.query.yol) throw new KovanHatasi("yol parametresi gerekli");
    return ork.dosyaOku(req.params.fid, req.query.yol);
  });

  app.post<{ Params: { fid: string } }>("/api/fikirler/:fid/karar", async (req) => {
    const b = govde(req.body);
    ork.kararVer(req.params.fid, metin(b.secim), metin(b.not), metin(b.hedef) || null);
    return { ok: true };
  });

  app.post<{ Params: { fid: string } }>("/api/fikirler/:fid/cevap", async (req) => {
    const b = govde(req.body);
    if (!Array.isArray(b.cevaplar)) throw new KovanHatasi("cevaplar listesi gerekli");
    const cevaplar: Cevap[] = b.cevaplar.map((c) => {
      const o = govde(c);
      return { secilenler: Array.isArray(o.secilenler) ? o.secilenler.map(String) : [], serbest: metin(o.serbest) };
    });
    ork.cevapla(req.params.fid, cevaplar);
    return { ok: true };
  });

  app.post<{ Params: { fid: string } }>("/api/fikirler/:fid/surum", async (req) => {
    const b = govde(req.body);
    return { id: await ork.yeniSurum(req.params.fid, metin(b.metin)) };
  });

  app.post<{ Params: { fid: string } }>("/api/fikirler/:fid/durdur", async (req) => { ork.durdur(req.params.fid); return { ok: true }; });
  app.post<{ Params: { fid: string } }>("/api/fikirler/:fid/devam", async (req) => { ork.devamEttir(req.params.fid); return { ok: true }; });

  // Ajanların ürettiği kod/ altındaki dosyaları tarayıcıda açar (UX prototipi, frontend build'i).
  app.get<{ Params: { fid: string; "*": string } }>("/onizle/:fid/*", async (req, reply) => {
    const yol = path.posix.normalize(req.params["*"] ?? "");
    if (!(yol === "kod" || yol.startsWith("kod/"))) throw new KovanHatasi("Yalnızca kod/ altı önizlenebilir.", 403);
    const dosya = ork.dosyaYolu(req.params.fid, yol);
    reply.header("Content-Security-Policy", ONIZLEME_CSP).header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    // Sandbox'taki sayfanın kökeni opaktır ("null"); Vite build'inin modül betikleri CORS ile yüklenir.
    // İzin yalnızca bu tür alt kaynak isteklerine verilir.
    if (req.headers.origin === "null" && ["script", "style", "font", "worker"].includes(String(req.headers["sec-fetch-dest"] ?? ""))) {
      reply.header("Access-Control-Allow-Origin", "null");
    }
    return reply.type(mimeTuru(dosya)).send(fs.createReadStream(dosya));
  });

  // ------------------------------ arayüz ------------------------------
  const arayuz = secenek.arayuz ?? path.join(kok, "arayuz", "dist");
  const guvenlikBasliklari = (reply: FastifyReply) => {
    reply.header("Content-Security-Policy", ARAYUZ_CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  };
  if (fs.existsSync(path.join(arayuz, "index.html"))) {
    await app.register(fastifyStatic, {
      root: arayuz, prefix: "/", index: ["index.html"], wildcard: true,
      setHeaders(reply, dosya) {
        guvenlikBasliklari(reply);
        reply.header("Cache-Control", dosya.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-store");
      },
    });
  } else {
    app.get("/", async (_req, reply) => {
      guvenlikBasliklari(reply);
      return reply.type("text/html; charset=utf-8").send(
        "<!doctype html><meta charset=utf-8><title>Kovan</title><body style='font-family:system-ui;padding:40px'>" +
        "<h1>Arayüz derlenmemiş</h1><p>Terminal'de <code>npm run build</code> çalıştır ya da <code>Baslat.command</code> ile başlat.</p></body>");
    });
  }

  return { app, ork, depo, cfg, motorlar, calisma, surum };
}
