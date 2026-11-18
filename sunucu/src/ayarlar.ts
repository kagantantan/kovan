// kovan.yaml ayarları. KOVAN_* ortam değişkenleri testler için ayarları ezer.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { HedefYigin, Mod } from "./tipler.js";

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
];
export type { Mod };

export interface YerelMotorAyari {
  tur: "ollama";
  adres: string;
  model: string;
}

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
  deneme_sayisi: number;
  deneme_gecikme_sn: number;
  calisma_dizini: string | null;
  ajan_sorulari: boolean;           // ajanlar insana seçenekli soru sorabilsin mi
  en_fazla_soru_turu: number;       // bir aşamada en fazla kaç soru turu
  ortak_karar: OrtakKararAyari;
  motorlar: Record<string, YerelMotorAyari>;
}

export const VARSAYILAN: Ayarlar = {
  port: 8765,
  motor: "hibrit",
  claude_yolu: "claude",
  api_anahtarini_yoksay: true,
  paralel_fikir: 1,
  paralel_inceleme: true,
  deneme_sayisi: 2,
  deneme_gecikme_sn: 1,
  calisma_dizini: null,
  ajan_sorulari: true,
  en_fazla_soru_turu: 2,
  ortak_karar: { acik: true, kurul: ["urun-sahibi", "mimar", "analist"], kural: "oybirligi" },
  motorlar: { "qwen-yerel": { tur: "ollama", adres: "http://127.0.0.1:11434", model: "qwen3-coder:30b" } },
};

export function ayarlariYukle(kok: string): Ayarlar {
  const cfg: Ayarlar = structuredClone(VARSAYILAN);
  const dosya = path.join(kok, "kovan.yaml");
  if (fs.existsSync(dosya)) {
    const veri = YAML.parse(fs.readFileSync(dosya, "utf8")) ?? {};
    if (typeof veri !== "object" || Array.isArray(veri)) throw new Error("kovan.yaml bir sözlük (anahtar: değer) olmalı");
    Object.assign(cfg, veri);
    // ortak_karar: false kısayolu ya da eksik alanlı sözlük
    const ok = veri.ortak_karar;
    if (ok === false || ok === true) cfg.ortak_karar = { ...VARSAYILAN.ortak_karar, acik: ok };
    else if (ok && typeof ok === "object") cfg.ortak_karar = { ...VARSAYILAN.ortak_karar, ...ok };
  }

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

  const motorlar = cfg.motorlar ?? {};
  if (typeof motorlar !== "object") throw new Error("kovan.yaml: motorlar bir sözlük olmalı");
  for (const [ad, m] of Object.entries(motorlar)) {
    if (ad === "claude" || ad === "deneme") throw new Error(`kovan.yaml: '${ad}' adı ayrılmış, yerel motora başka bir ad ver`);
    if (!m || m.tur !== "ollama" || !m.model) throw new Error(`kovan.yaml: motorlar.${ad} için 'tur: ollama' ve 'model' zorunlu`);
    m.adres = process.env.KOVAN_OLLAMA_ADRES || m.adres || "http://127.0.0.1:11434";
  }
  cfg.motorlar = motorlar;

  if (!MODLAR.includes(cfg.motor)) throw new Error(`kovan.yaml: motor şunlardan biri olmalı: ${MODLAR.join(", ")}`);
  const k = cfg.ortak_karar;
  if (!Array.isArray(k.kurul)) throw new Error("kovan.yaml: ortak_karar.kurul bir liste olmalı (ör. [urun-sahibi, mimar, analist])");
  k.kurul = k.kurul.map(String);
  k.acik = Boolean(k.acik);
  if (k.kural !== "oybirligi" && k.kural !== "cogunluk") throw new Error("kovan.yaml: ortak_karar.kural 'oybirligi' ya da 'cogunluk' olmalı");
  return cfg;
}
