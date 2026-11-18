// Ajan kartları: ajanlar/<id>.md = YAML ön bilgi (motor, model, araçlar, izinler, sınırlar)
// + markdown gövde (sistem promptu). Sınırın bir kısmı prompt'ta, bir kısmı sistemde uygulanır.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { KartAyari } from "./ayarlar.js";

export const BILINEN_ARACLAR = new Set([
  "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash",
  "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite", "Task",
]);

export interface AjanKarti {
  id: string;
  ad: string;
  kisaltma: string;
  motor: string;                 // claude | kovan.yaml'daki yerel motor adı
  model: string;                 // Claude modeli (hepsi-Claude modunda yerel ajanlar da bunu kullanır)
  yerel_model: string | null;    // yerel motorda bu ajana özel model
  aciklama: string;
  araclar: string[];
  izinli_komutlar: string[];
  sure_dk: number;
  butce_usd: number | null;
  sistem_promptu: "degistir" | "ekle";
  efor: string | null;
  govde: string;
  dosya: string;
}

const ON_BILGI = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/** Gövdeden "# <başlık>" bölümünü döndürür (bir sonraki # başlığına kadar). */
export function bolum(govde: string, baslik: string): string {
  const satirlar = govde.split("\n");
  const bas = satirlar.findIndex((s) => s.trim() === `# ${baslik}`);
  if (bas < 0) return "";
  const son = satirlar.findIndex((s, i) => i > bas && /^#\s/.test(s));
  return satirlar.slice(bas + 1, son < 0 ? undefined : son).join("\n").trim();
}

export function kartOku(yol: string): AjanKarti {
  const ad = path.basename(yol);
  const metin = fs.readFileSync(yol, "utf8").replace(/\r\n/g, "\n");
  const m = ON_BILGI.exec(metin);
  if (!m) throw new Error(`${ad}: kart '---' ile başlayan YAML ön bilgi içermeli`);
  const on = YAML.parse(m[1]) ?? {};
  const govde = m[2].trim();
  if (typeof on !== "object") throw new Error(`${ad}: ön bilgi anahtar: değer biçiminde olmalı`);
  for (const z of ["ad", "kisaltma"]) if (!on[z]) throw new Error(`${ad}: '${z}' alanı zorunlu`);
  if (!govde) throw new Error(`${ad}: kartın gövdesi (sistem promptu) boş olamaz`);
  const araclar: string[] = (on.araclar ?? []).map(String);
  const bilinmeyen = araclar.filter((a) => !BILINEN_ARACLAR.has(a));
  if (bilinmeyen.length) throw new Error(`${ad}: bilinmeyen araç(lar): ${bilinmeyen.join(", ")}`);
  const sp = String(on.sistem_promptu ?? "degistir");
  if (sp !== "degistir" && sp !== "ekle") throw new Error(`${ad}: sistem_promptu 'degistir' ya da 'ekle' olmalı`);
  return {
    id: path.basename(yol, ".md"),
    ad: String(on.ad),
    kisaltma: String(on.kisaltma),
    motor: String(on.motor ?? "claude"),
    model: String(on.model ?? "sonnet"),
    yerel_model: on.yerel_model ? String(on.yerel_model) : null,
    aciklama: String(on.aciklama ?? ""),
    araclar,
    izinli_komutlar: (on.izinli_komutlar ?? []).map(String),
    sure_dk: Number(on.sure_dk ?? 10),
    butce_usd: on.butce_usd === undefined || on.butce_usd === null || on.butce_usd === "" ? null : Number(on.butce_usd),
    sistem_promptu: sp,
    efor: on.efor ? String(on.efor) : null,
    govde,
    dosya: yol,
  };
}

export function kartlariYukle(dizin: string): Map<string, AjanKarti> {
  const kartlar = new Map<string, AjanKarti>();
  for (const dosya of fs.readdirSync(dizin).sort()) {
    if (!dosya.endsWith(".md") || dosya.startsWith("_")) continue;
    const k = kartOku(path.join(dizin, dosya));
    kartlar.set(k.id, k);
  }
  if (!kartlar.size) throw new Error(`${dizin} içinde ajan kartı bulunamadı`);
  return kartlar;
}

/**
 * Dış ayardaki ajanlar bölümünü kartlara uygular: önce "*" (hepsi), sonra kartın kendi kimliği.
 * Yalnızca motor, model, süre ve bütçe değişir; araçlar ve izinler kartta kalır.
 */
export function kartAyarlariniUygula(kartlar: Map<string, AjanKarti>, ayarlar: Record<string, KartAyari>): void {
  const bilinmeyen = Object.keys(ayarlar).filter((id) => id !== "*" && !kartlar.has(id));
  if (bilinmeyen.length) throw new Error(`ayarlar: ajanlar içinde bilinmeyen ajan: ${bilinmeyen.join(", ")} (kartlar: ${[...kartlar.keys()].join(", ")})`);
  for (const k of kartlar.values()) {
    for (const a of [ayarlar["*"], ayarlar[k.id]]) {
      if (!a) continue;
      if (a.motor !== undefined) k.motor = String(a.motor);
      if (a.model !== undefined) k.model = String(a.model);
      if (a.yerel_model !== undefined) k.yerel_model = a.yerel_model === null ? null : String(a.yerel_model);
      if (a.efor !== undefined) k.efor = a.efor === null ? null : String(a.efor);
      if (a.sure_dk !== undefined) {
        const v = Number(a.sure_dk);
        if (!(v > 0)) throw new Error(`ayarlar: ajanlar.${k.id}.sure_dk pozitif bir sayı olmalı`);
        k.sure_dk = v;
      }
      if (a.butce_usd !== undefined) k.butce_usd = a.butce_usd === null ? null : Number(a.butce_usd);
    }
  }
}

export function kartOzeti(k: AjanKarti) {
  return {
    id: k.id, ad: k.ad, kisaltma: k.kisaltma, motor: k.motor, model: k.model, yerel_model: k.yerel_model,
    aciklama: k.aciklama, araclar: k.araclar, izinli_komutlar: k.izinli_komutlar, sure_dk: k.sure_dk,
    butce_usd: k.butce_usd, sistem_promptu: k.sistem_promptu, sinirlar: bolum(k.govde, "Sınırların"),
    govde: k.govde, dosya: path.join(path.basename(path.dirname(k.dosya)), path.basename(k.dosya)),
  };
}
