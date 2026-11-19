// kovan.yaml ayarları + isteğe bağlı dış ayar dosyası (--ayar <yol> ya da KOVAN_AYAR).
// Dış dosya repoda durmaz: kurum adresleri, anahtarın nereden okunacağı ve ajan ayarları oradan gelir.
// Dış dosyada yazılan her üst anahtar repodaki kovan.yaml'ın aynı anahtarının yerine geçer.
// KOVAN_* ortam değişkenleri testler için ayarları ezer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import type { HedefYigin, Mod } from "./tipler.js";
import type { UyumluMotorAyari } from "./uyumlu.js";

export const MODLAR: readonly Mod[] = ["hibrit", "claude", "deneme", "yerel"];

/** Yeni kodun teknolojisi. Seçilen metin karar defterine "Hedef yığın" olarak yazılır; bütün ajanlar uyar. */
export const HEDEF_YIGINLAR: HedefYigin[] = [
  { id: "node-ts", ad: "Node.js + TypeScript",
    aciklama: "Node.js 22 + TypeScript (ESM); testler Vitest; arayüz varsa Vite + React. Kovan'ın varsayılan yığını." },
  { id: "java21-spring-maven", ad: "Java 21 + Spring Boot (Maven)",
    aciklama: "Java 21, Spring Boot (güncel kararlı sürüm), Maven; testler JUnit 5 + AssertJ. Para ve oranlar BigDecimal (yuvarlama kuralı açık). İş mantığı saf Java domain katmanında; Spring, veritabanı ve zamanlayıcı yalnızca adaptörlerde (hexagonal)." },
  { id: "java25-spring-maven", ad: "Java 25 + Spring Boot (Maven)",
    aciklama: "Java 25 (LTS), Spring Boot (Java 25'i destekleyen güncel kararlı sürüm), Maven; testler JUnit 5 + AssertJ. Para ve oranlar BigDecimal (yuvarlama kuralı açık). İş mantığı saf Java domain katmanında; Spring, veritabanı ve zamanlayıcı yalnızca adaptörlerde (hexagonal)." },
  { id: "java21-temporal", ad: "Java 21 + Spring Boot + Temporal",
    aciklama: "Java 21, Spring Boot, Maven, Temporal Java SDK. Gün sonu akışı bir Temporal workflow'u, her adım idempotent bir activity (yeniden deneme ve zaman aşımı açıkça tanımlı); hesaplama saf Java domain katmanında, activity'ler yalnızca onu çağırır. Testler JUnit 5 + AssertJ; workflow testleri Temporal test ortamıyla (TestWorkflowEnvironment)." },
  { id: "java17-spring-batch", ad: "Java 17 + Spring Batch / REST (Oracle)",
    aciklama: "Java 17, Spring Boot 3, Maven, Oracle. Eski sistemin her giriş noktası (zamanlanmış iş, çevrim içi çağrı) için batch job mı, REST endpoint mi, ikisi mi olacağı bir ADR'yle (alan: calisma_bicimi) seçenekleriyle kararlaştırılır; ikisi de aynı saf domain servisini çağırır. Batch: Spring Batch 5. Yüksek hacimli gün sonu işi chunk tabanlı step'lerle; partitioning, paralel step ve chunk boyutu mimarın kararı, beklenen hacim ve süre hedefiyle rakamla gerekçelendirilir. Büyük toplu güncellemeler JDBC batch ya da küme tabanlı SQL ile, satır satır değil. JobRepository ile yeniden başlatılabilir: kesintide kaldığı chunk ya da partition'dan sürer; aynı iş tarihi iki kez işlenmez (iş tarihi job parametresi). Para ve oranlar BigDecimal (yuvarlama kuralı açık). İş mantığı saf Java domain katmanında; reader, processor ve writer yalnızca onu çağıran adaptörler. Testler JUnit 5 + AssertJ + spring-batch-test; test veritabanı H2 (Oracle modu), Docker gerekmez; ölçekli verim testi sentetik veriyle. REST: Spring Web MVC; istek ve yanıt DTO'ları, girdi doğrulama, hata yanıtı biçimi, idempotency anahtarı, zaman aşımı ve transaction sınırı açık; testler MockMvc ile." },
];
export type { Mod };

export interface YerelMotorAyari {
  tur: "ollama";
  adres: string;
  model: string;
}

export type MotorAyari = YerelMotorAyari | UyumluMotorAyari;

/** Dış ayarla değiştirilebilen kart alanları. Araçlar, izinler ve sistem promptu kartta kalır: yetki dışarıdan genişletilmez. */
export const KART_AYAR_ALANLARI = ["motor", "model", "yerel_model", "sure_dk", "butce_usd", "efor"] as const;
export type KartAyari = Partial<Record<(typeof KART_AYAR_ALANLARI)[number], string | number | null>>;

/** Ajan soruları önce bu kurula gider; anlaşırlarsa sana sorulmaz. */
export interface OrtakKararAyari {
  acik: boolean;
  kurul: string[];                  // kart id'leri; soran ajan da kendi önerisiyle oy verir
  kural: "oybirligi" | "cogunluk";  // oybirliği: hepsi aynı seçeneği seçmeli
}

export interface Ayarlar {
  port: number;
  motor: Mod;                       // yeni fikirde varsayılan mod
  claude_yolu: string;
  api_anahtarini_yoksay: boolean;   // Claude ajanlarında yönlendirme değişkenlerini temizle
  paralel_fikir: number;
  paralel_inceleme: boolean;
  onayi_koru: boolean;              // revizyon turunda önceki turda onaylayan onaycı yeniden bakmaz
  deneme_sayisi: number;
  deneme_gecikme_sn: number;
  calisma_dizini: string | null;
  ajan_sorulari: boolean;           // ajanlar insana seçenekli soru sorabilsin mi
  en_fazla_soru_turu: number;       // bir aşamada en fazla kaç soru turu
  ortak_karar: OrtakKararAyari;
  motorlar: Record<string, MotorAyari>;
  claude: boolean;                  // false: Claude'a hiç bağlanılmaz, claude komutu aranmaz
  modlar: Mod[];                    // arayüzde ve API'de açık modlar
  yerel_motor: string | null;       // Hepsi yerel modunun motoru (boşsa ilk yerel motor)
  ajanlar: Record<string, KartAyari>;  // "*" bütün ajanlar; kart id'si tek ajan
  dis_ayar: string | null;          // okunan dış ayar dosyası
}

export const VARSAYILAN: Ayarlar = {
  port: 8765,
  motor: "hibrit",
  claude_yolu: "claude",
  api_anahtarini_yoksay: true,
  paralel_fikir: 1,
  paralel_inceleme: true,
  onayi_koru: true,
  deneme_sayisi: 2,
  deneme_gecikme_sn: 1,
  calisma_dizini: null,
  ajan_sorulari: true,
  en_fazla_soru_turu: 2,
  ortak_karar: { acik: true, kurul: ["urun-sahibi", "mimar", "analist"], kural: "oybirligi" },
  motorlar: { "qwen-yerel": { tur: "ollama", adres: "http://127.0.0.1:11434", model: "qwen3-coder:30b" } },
  claude: true,
  modlar: [...MODLAR],
  yerel_motor: null,
  ajanlar: {},
  dis_ayar: null,
};

const evYolu = (y: string) => y.replace(/^~(?=$|\/)/, os.homedir());

function yamlOku(dosya: string, ad: string): Record<string, unknown> {
  let veri: unknown;
  try { veri = YAML.parse(fs.readFileSync(dosya, "utf8")) ?? {}; } catch (e) { throw new Error(`${ad} okunamadı: ${(e as Error).message}`); }
  if (typeof veri !== "object" || Array.isArray(veri)) throw new Error(`${ad} bir sözlük (anahtar: değer) olmalı`);
  return veri as Record<string, unknown>;
}

function motorDogrula(ad: string, m: Record<string, unknown>, kaynak: string): MotorAyari {
  if (ad === "claude" || ad === "deneme") throw new Error(`${kaynak}: '${ad}' adı ayrılmış, motora başka bir ad ver`);
  if (!m || typeof m !== "object") throw new Error(`${kaynak}: motorlar.${ad} bir sözlük olmalı`);
  if (m.tur === "ollama") {
    if (!m.model) throw new Error(`${kaynak}: motorlar.${ad} için 'model' zorunlu`);
    return { tur: "ollama", model: String(m.model), adres: process.env.KOVAN_OLLAMA_ADRES || String(m.adres || "http://127.0.0.1:11434") };
  }
  if (m.tur === "openai") {
    for (const z of ["adres", "model"]) if (!m[z]) throw new Error(`${kaynak}: motorlar.${ad} için '${z}' zorunlu`);
    try { new URL(String(m.adres)); } catch { throw new Error(`${kaynak}: motorlar.${ad}.adres geçerli bir adres değil: ${m.adres}`); }
    for (const yasak of ["anahtar", "api_key", "api_anahtari"]) {
      if (yasak in m) throw new Error(`${kaynak}: motorlar.${ad}.${yasak}: anahtarın kendisini ayar dosyasına yazma; anahtar_degiskeni (ortam değişkeninin adı) ya da anahtar_dosyasi ver`);
    }
    const bicim = m.arac_bicimi ?? "otomatik";
    if (!["otomatik", "openai", "metin"].includes(String(bicim))) throw new Error(`${kaynak}: motorlar.${ad}.arac_bicimi otomatik, openai ya da metin olmalı`);
    const sayi = (k: string) => (m[k] === undefined || m[k] === null ? undefined : Number(m[k]));
    return {
      tur: "openai", adres: String(m.adres), model: String(m.model),
      anahtar_degiskeni: m.anahtar_degiskeni ? String(m.anahtar_degiskeni) : null,
      anahtar_dosyasi: m.anahtar_dosyasi ? evYolu(String(m.anahtar_dosyasi)) : null,
      anahtar_basligi: m.anahtar_basligi ? String(m.anahtar_basligi) : "Authorization",
      ek_basliklar: Object.fromEntries(Object.entries((m.ek_basliklar as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)])),
      ca_dosyasi: m.ca_dosyasi ? evYolu(String(m.ca_dosyasi)) : null,
      arac_bicimi: bicim as UyumluMotorAyari["arac_bicimi"],
      sicaklik: sayi("sicaklik") ?? null, en_fazla_token: sayi("en_fazla_token") ?? null,
      baglam_token: sayi("baglam_token") ?? 32_768, en_fazla_tur: sayi("en_fazla_tur") ?? 100,
      yerel: m.yerel !== false,
    };
  }
  throw new Error(`${kaynak}: motorlar.${ad}.tur 'ollama' ya da 'openai' olmalı`);
}

/** disYol: dış ayar dosyası; verilmezse KOVAN_AYAR ortam değişkeni, null ise hiç okunmaz. */
export function ayarlariYukle(kok: string, disYol: string | null | undefined = process.env.KOVAN_AYAR): Ayarlar {
  const cfg: Ayarlar = structuredClone(VARSAYILAN);
  const katmanlar: { ad: string; veri: Record<string, unknown> }[] = [];
  const dosya = path.join(kok, "kovan.yaml");
  if (fs.existsSync(dosya)) katmanlar.push({ ad: "kovan.yaml", veri: yamlOku(dosya, "kovan.yaml") });
  if (disYol) {
    const tam = path.resolve(evYolu(disYol));
    if (!fs.existsSync(tam)) throw new Error(`Dış ayar dosyası bulunamadı: ${tam}`);
    katmanlar.push({ ad: tam, veri: yamlOku(tam, tam) });
    cfg.dis_ayar = tam;
  }
  const motorKaynagi: Record<string, string> = {};
  for (const { ad, veri } of katmanlar) {
    const { ortak_karar: ok, motorlar, ...diger } = veri;
    Object.assign(cfg, diger);
    // ortak_karar: false kısayolu ya da eksik alanlı sözlük
    if (ok === false || ok === true) cfg.ortak_karar = { ...VARSAYILAN.ortak_karar, acik: ok };
    else if (ok && typeof ok === "object") cfg.ortak_karar = { ...VARSAYILAN.ortak_karar, ...(ok as Partial<OrtakKararAyari>) };
    if (motorlar !== undefined) {
      if (!motorlar || typeof motorlar !== "object" || Array.isArray(motorlar)) throw new Error(`${ad}: motorlar bir sözlük olmalı`);
      cfg.motorlar = motorlar as Ayarlar["motorlar"];
      for (const m of Object.keys(motorlar)) motorKaynagi[m] = ad;
    }
  }
  // Varsayılan mod açık modlar arasında değilse: dış dosya ya da --deneme açıkça istediyse hata, yoksa ilk açık mod
  const motorAcikca = Boolean(process.env.KOVAN_MOTOR) || (Boolean(cfg.dis_ayar) && "motor" in katmanlar.at(-1)!.veri);

  const ortam: Record<string, [keyof Ayarlar, (s: string) => unknown]> = {
    KOVAN_PORT: ["port", Number],
    KOVAN_MOTOR: ["motor", String],
    KOVAN_CLAUDE_YOLU: ["claude_yolu", String],
    KOVAN_DENEME_GECIKME: ["deneme_gecikme_sn", Number],
    KOVAN_CALISMA: ["calisma_dizini", String],
    KOVAN_DENEME_SAYISI: ["deneme_sayisi", Number],
  };
  for (const [anahtar, [alan, tip]] of Object.entries(ortam)) {
    const v = process.env[anahtar];
    if (v) (cfg as unknown as Record<string, unknown>)[alan] = tip(v);
  }

  cfg.motorlar = Object.fromEntries(Object.entries(cfg.motorlar ?? {}).map(([ad, m]) =>
    [ad, motorDogrula(ad, m as unknown as Record<string, unknown>, motorKaynagi[ad] ?? "kovan.yaml")]));

  cfg.claude = cfg.claude !== false;
  if (!Array.isArray(cfg.modlar) || !cfg.modlar.length) throw new Error("ayarlar: modlar boş olmayan bir liste olmalı (ör. [yerel, deneme])");
  const bilinmeyen = cfg.modlar.filter((m) => !MODLAR.includes(m));
  if (bilinmeyen.length) throw new Error(`ayarlar: modlar içinde bilinmeyen mod: ${bilinmeyen.join(", ")} (${MODLAR.join(", ")})`);
  if (!cfg.claude) cfg.modlar = cfg.modlar.filter((m) => m !== "claude");
  if (!cfg.modlar.length) throw new Error("ayarlar: Claude kapalıyken modlar içinde en az biri olmalı: hibrit, yerel ya da deneme");
  if (!MODLAR.includes(cfg.motor)) throw new Error(`kovan.yaml: motor şunlardan biri olmalı: ${MODLAR.join(", ")}`);
  if (!cfg.modlar.includes(cfg.motor)) {
    if (motorAcikca) throw new Error(`ayarlar: varsayılan mod '${cfg.motor}' açık modlar arasında değil (${cfg.modlar.join(", ")})`);
    cfg.motor = cfg.modlar[0];
  }
  if (cfg.yerel_motor) {
    const m = cfg.motorlar[cfg.yerel_motor];
    if (!m) throw new Error(`ayarlar: yerel_motor '${cfg.yerel_motor}' motorlar içinde yok`);
    if (m.tur === "openai" && m.yerel === false) throw new Error(`ayarlar: yerel_motor '${cfg.yerel_motor}' yerel: false; Hepsi yerel modu buluta giden bir motoru kullanamaz`);
  }
  if (!cfg.ajanlar || typeof cfg.ajanlar !== "object" || Array.isArray(cfg.ajanlar)) throw new Error("ayarlar: ajanlar bir sözlük olmalı");
  for (const [id, a] of Object.entries(cfg.ajanlar)) {
    if (!a || typeof a !== "object") throw new Error(`ayarlar: ajanlar.${id} bir sözlük olmalı`);
    const fazla = Object.keys(a).filter((k) => !(KART_AYAR_ALANLARI as readonly string[]).includes(k));
    if (fazla.length) throw new Error(`ayarlar: ajanlar.${id}: ${fazla.join(", ")} dışarıdan değiştirilemez (değiştirilebilenler: ${KART_AYAR_ALANLARI.join(", ")}; araç ve izinler kartta)`);
  }
  const k = cfg.ortak_karar;
  if (!Array.isArray(k.kurul)) throw new Error("kovan.yaml: ortak_karar.kurul bir liste olmalı (ör. [urun-sahibi, mimar, analist])");
  k.kurul = k.kurul.map(String);
  k.acik = Boolean(k.acik);
  if (k.kural !== "oybirligi" && k.kural !== "cogunluk") throw new Error("kovan.yaml: ortak_karar.kural 'oybirligi' ya da 'cogunluk' olmalı");
  return cfg;
}
