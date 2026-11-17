// kovan.yaml ayarları. KOVAN_* ortam değişkenleri testler için ayarları ezer.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { Mod } from "./tipler.js";

export const MODLAR: readonly Mod[] = ["hibrit", "claude", "deneme"];
export type { Mod };

export interface YerelMotorAyari {
  tur: "ollama";
  adres: string;
  model: string;
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
  motorlar: { "qwen-yerel": { tur: "ollama", adres: "http://127.0.0.1:11434", model: "qwen3-coder:30b" } },
};

export function ayarlariYukle(kok: string): Ayarlar {
  const cfg: Ayarlar = structuredClone(VARSAYILAN);
  const dosya = path.join(kok, "kovan.yaml");
  if (fs.existsSync(dosya)) {
    const veri = YAML.parse(fs.readFileSync(dosya, "utf8")) ?? {};
    if (typeof veri !== "object" || Array.isArray(veri)) throw new Error("kovan.yaml bir sözlük (anahtar: değer) olmalı");
    Object.assign(cfg, veri);
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
  return cfg;
}
