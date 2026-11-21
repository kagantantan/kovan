// Fastify sunucusu: derlenmiş arayüz (arayuz/dist) + JSON API. Yalnızca 127.0.0.1'de dinler.
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { spawn } from "node:child_process";
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
import { AjanSecimleri, varsayilanSecimDosyasi } from "./secimler.js";
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
  /** Fikrin klasörünü dosya yöneticisinde açar; testler sahtesini verir. */
  klasorAcici?: (yol: string) => void;
  /** Kaynak yolu seçimi için işletim sisteminin seçim penceresi; testler sahtesini verir. null: iptal. */
  yolSecici?: (tur: "klasor" | "dosya") => Promise<string[] | null>;
  /** Ajanlar ekranındaki motor ve model seçimlerinin dosyası; verilmezse ~/.kovan/ajan-secimleri.json, null ise yalnızca bellek. */
  ajan_secimleri?: string | null;
}

/** İşletim sisteminin seçim penceresini açar (macOS: Finder, Linux: zenity). Seçilen mutlak yollar; iptalde null. Kabuk kullanılmaz. */
function yolSec(tur: "klasor" | "dosya"): Promise<string[] | null> {
  const [komut, args]: [string, string[]] = process.platform === "darwin"
    ? ["osascript", ["-e", tur === "klasor"
      ? 'set y to choose folder with prompt "Mevcut sistemin klasörünü seç" with multiple selections allowed'
      : 'set y to choose file with prompt "Mevcut sistemin dosyalarını seç" with multiple selections allowed',
    "-e", 'set s to ""', "-e", "repeat with i in y", "-e", "set s to s & POSIX path of i & linefeed", "-e", "end repeat", "-e", "return s"]]
    : process.platform === "linux"
      ? ["zenity", ["--file-selection", "--multiple", "--separator=\n", ...(tur === "klasor" ? ["--directory"] : [])]]
      : ["", []];
  if (!komut) return Promise.reject(new KovanHatasi("Bu işletim sisteminde seçim penceresi yok; yolu elle yaz.", 501));
  return new Promise((coz, red) => {
    let cikti = "";
    const p = spawn(komut, args, { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout!.setEncoding("utf8").on("data", (x) => { cikti += x; });
    p.on("error", () => red(new KovanHatasi(`Seçim penceresi açılamadı (${komut} yok); yolu elle yaz.`, 501)));
    p.on("close", (kod) => coz(kod === 0 ? cikti.split("\n").map((y) => y.trim().replace(/(.)\/$/, "$1")).filter(Boolean) : null));
  });
}

/** Klasörü işletim sisteminin dosya yöneticisinde açar (Finder, Explorer, xdg-open). Kabuk kullanılmaz. */
function klasoruAc(yol: string): void {
  const [komut, args] = process.platform === "darwin" ? ["open", [yol]] : process.platform === "win32" ? ["explorer", [yol]] : ["xdg-open", [yol]];
  const p = spawn(komut, args as string[], { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  p.unref();
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
  const secimler = new AjanSecimleri(kartlar, () => [...motorlar.keys()].filter((m) => m !== "deneme"),
    secenek.ajan_secimleri === undefined ? varsayilanSecimDosyasi() : secenek.ajan_secimleri);
  // Ekrandan seçilen inceleme modeli, dosyadaki (kovan.yaml / dış ayar) değerin üstüne yazar
  if (secimler.incelemeModeli()) cfg.claude_inceleme_modeli = secimler.incelemeModeli();
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
      surum, varsayilan_motor: cfg.motor, calisma, paralel_fikir: cfg.paralel_fikir, paralel_inceleme: cfg.paralel_inceleme, claude_inceleme_modeli: cfg.claude_inceleme_modeli,
      ajan_sorulari: cfg.ajan_sorulari, en_fazla_soru_turu: cfg.en_fazla_soru_turu, motorlar: durumlar,
      hedef_yiginlar: HEDEF_YIGINLAR,
      ornek_kaynak: fs.existsSync(path.join(kok, "ornekler", "reeskont-eski")) ? path.join(kok, "ornekler", "reeskont-eski") : null,
      ornek_proje: fs.existsSync(path.join(kok, "ornekler", "proje-ornek")) ? path.join(kok, "ornekler", "proje-ornek") : null,
      katilim: cfg.katilim, buyuk_birader: cfg.buyuk_birader.acik,
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

  // Ajanlar ekranı: ajanın motoru ve modeli (Hibrit modda geçerli; Hepsi Claude ve Hepsi yerel modları hepsini tek motora alır)
  app.post<{ Params: { id: string } }>("/api/ajanlar/:id/secim", async (req) => {
    const g = govde(req.body);
    secimler.ayarla(req.params.id, { motor: metin(g.motor), model: metin(g.model) });
    return { ok: true };
  });
  // Tasarruf: Claude'daki incelemeler ve oylar ucuz modelle (ör. haiku); "" = her ajan kendi modelinde
  app.post("/api/inceleme-modeli", async (req) => {
    const model = metin(govde(req.body).model).trim();
    secimler.incelemeModeliAyarla(model || null);
    cfg.claude_inceleme_modeli = model || null;
    return { ok: true, model: cfg.claude_inceleme_modeli };
  });
  app.post<{ Params: { id: string } }>("/api/ajanlar/:id/secim-sil", async (req) => { secimler.kaldir(req.params.id); return { ok: true }; });
  // Seçim ekranı için öneri listesi: Claude takma adları ve OpenAI uyumlu motorların sunucudaki modelleri
  app.get("/api/motorlar/modeller", async () => {
    const sonuc: Record<string, string[]> = {};
    for (const [ad, m] of motorlar) {
      if (ad === "deneme") continue;
      if (m instanceof UyumluMotor) { await m.saglik(true).catch(() => false); sonuc[ad] = m.modeller.slice(0, 50); }
      else if (ad === "claude") sonuc[ad] = ["sonnet", "opus", "haiku"];
      else sonuc[ad] = [m.modelSec({ yerel_model: null } as never)];
    }
    return sonuc;
  });

  app.get("/api/ajanlar", async () => [...kartlar.values()].map((k): AjanOzeti => {
    const m = motorlar.get(k.motor);
    return {
      ...kartOzeti(k),
      motor_modeli: m ? m.modelSec(k) : k.model,
      motor_yerel: Boolean(m?.yerel),
      secim: secimler.secim(k.id),
      uretir: [...akislar.values()].flatMap((ak) => tumAdimlar(ak)
        .filter((a) => a.ajan === k.id || (a.ajan === "{gelistirici}" && ak.asamalar.some((s) => k.id in s.gelistiriciler)))
        .map((a) => `${a.ad} (${ak.ad})`)),
      onaylar: [...akislar.values()].flatMap((ak) => tumAdimlar(ak).filter((a) => a.dogrulama.some((v) => v.inceleyen === k.id)).map((a) => `${a.ad} (${ak.ad})`)),
    };
  }));

  // Var olan kodla başlayan akışlar (mevcut proje, replatform) sonda: sıfırdan ürün akışları birbirinin kısası, uzunu
  const akisSirasi = { yok: 0, proje: 1, zorunlu: 2 };
  app.get("/api/akislar", async () => [...akislar.values()]
    .sort((a, b) => akisSirasi[a.kaynak] - akisSirasi[b.kaynak])
    .map((a) => akisOzeti(a, kartlar)));

  app.get("/api/fikirler", async () => ork.fikirListesi());

  app.post("/api/fikirler", async (req) => {
    const b = govde(req.body);
    // kaynaklar: liste ya da satır satır yollar (replatform: mevcut sistemin klasörleri; mevcut proje: ekler)
    // proje: mevcut proje üzerinde işte projenin bu makinedeki klasörü
    const kaynaklar = Array.isArray(b.kaynaklar) ? b.kaynaklar.map(String) : metin(b.kaynaklar).split("\n");
    const fid = await ork.yeniFikir(metin(b.baslik), metin(b.metin), metin(b.profil), metin(b.motor) || cfg.motor,
      { kaynaklar, hedef_yigin: metin(b.hedef_yigin), proje: metin(b.proje), katilim: metin(b.katilim) });
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

  // Yeni fikir: mevcut sistemin klasörünü ya da dosyalarını Finder'dan seç (tarayıcı tam yolu veremez)
  app.post("/api/yol-sec", async (req) => {
    const tur = metin(govde(req.body).tur) === "dosya" ? "dosya" : "klasor";
    return { yollar: (await (secenek.yolSecici ?? yolSec)(tur)) ?? [] };
  });

  app.post<{ Params: { fid: string } }>("/api/fikirler/:fid/sil", async (req) => ({ ok: true, cop: ork.fikirSil(req.params.fid) }));

  app.post<{ Params: { fid: string } }>("/api/fikirler/:fid/klasor-ac", async (req) => {
    const alt = metin(govde(req.body ?? {}).alt);
    if (!["", "kod", "belgeler", "cikti"].includes(alt)) throw new KovanHatasi("alt yalnızca kod, belgeler ya da cikti olabilir.");
    const yol = ork.fikirKlasoru(req.params.fid, alt as "" | "kod" | "belgeler" | "cikti");
    if (!fs.existsSync(yol)) throw new KovanHatasi(`${alt || "Fikir"} klasörü henüz yok.`, 404);
    (secenek.klasorAcici ?? klasoruAc)(yol);
    return { ok: true, yol };
  });

  app.post<{ Params: { fid: string } }>("/api/fikirler/:fid/mod", async (req) => {
    ork.modDegistir(req.params.fid, metin(govde(req.body).mod));
    return { ok: true };
  });

  // Aşama sonu kapıları: sonda, planlama, her_asama. Sonraki aşama sonlarından itibaren geçerli.
  app.post<{ Params: { fid: string } }>("/api/fikirler/:fid/katilim", async (req) => {
    ork.katilimDegistir(req.params.fid, metin(govde(req.body).katilim));
    return { ok: true };
  });

  // Ajanla (ya da Büyük Birader'le) konuşma: soru arka planda cevaplanır, cevap fikir detayındaki sohbet listesine düşer.
  app.post<{ Params: { fid: string } }>("/api/fikirler/:fid/sor", async (req) => {
    const b = govde(req.body);
    return { id: ork.sor(req.params.fid, metin(b.hedef), metin(b.asama) || null, metin(b.soru)) };
  });

  app.post<{ Params: { fid: string; mid: string } }>("/api/fikirler/:fid/sohbet/:mid/karar", async (req) => {
    ork.sohbetKarari(req.params.fid, Number(req.params.mid), metin(govde(req.body).metin));
    return { ok: true };
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
