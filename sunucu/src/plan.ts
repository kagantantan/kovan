// Ajan çıktısındaki yapılandırılmış bloklar:
//   ```kovan-plan     Proje Yöneticisi'nin teslim planı: sıralı iş kalemleri (P1, P2...) ve bağımlılıkları
//   ```kovan-gelisim  Ürün Sahibi'nin gelişim önerileri (G1, G2...)
// Bloklar YAML ya da JSON olabilir. Hatalar insan diliyle döner; üreten ajana bulgu olarak gider.
import YAML from "yaml";
import type { Asama } from "./akislar.js";
import type { GelisimOnerisi, PlanKalemi } from "./tipler.js";

export const EN_FAZLA_KALEM = 8;
export const EN_FAZLA_ONERI = 5;

export function blokBul(metin: string, ad: string): string | null {
  const m = new RegExp("```" + ad + "[ \\t]*\\n([\\s\\S]*?)```").exec(metin ?? "");
  return m ? m[1] : null;
}

function liste(govde: string, anahtar: string): { liste?: Record<string, unknown>[]; hata?: string } {
  let ham: unknown;
  try { ham = YAML.parse(govde); } catch (e) { return { hata: `blok okunamadı (YAML/JSON): ${(e as Error).message.split("\n")[0]}` }; }
  const l = Array.isArray(ham) ? ham : (ham as Record<string, unknown> | null)?.[anahtar];
  if (!Array.isArray(l) || !l.length) return { hata: "blok boş ya da liste değil" };
  return { liste: l as Record<string, unknown>[] };
}

const dizi = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean);

const metin = (v: unknown): string => (Array.isArray(v) ? v.map(String).join("; ") : v === undefined || v === null ? "" : String(v)).trim();

/** ```kovan-plan bloğunu okur, denetler ve bağımlılık sırasına dizer. */
export function planCikar(belge: string, gelistiriciler: string[]): { kalemler?: PlanKalemi[]; hatalar?: string[] } {
  const govde = blokBul(belge, "kovan-plan");
  if (govde === null) return { hatalar: ["Belgede ```kovan-plan bloğu yok. Kalemleri bu blokta listele."] };
  const l = liste(govde, "kalemler");
  if (!l.liste) return { hatalar: [`kovan-plan ${l.hata}. En az bir kalem olmalı.`] };
  const hatalar: string[] = [];
  if (l.liste.length > EN_FAZLA_KALEM) hatalar.push(`En fazla ${EN_FAZLA_KALEM} kalem olabilir (${l.liste.length} var); küçük kalemleri birleştir.`);
  const kalemler: PlanKalemi[] = [];
  const idler = new Set<string>();
  l.liste.slice(0, EN_FAZLA_KALEM).forEach((k, i) => {
    const id = metin(k?.id).toUpperCase();
    const yer = id || `${i + 1}. kalem`;
    if (!/^P\d{1,2}$/.test(id)) hatalar.push(`${yer}: id P1, P2 biçiminde olmalı.`);
    else if (idler.has(id)) hatalar.push(`${id}: aynı id iki kez kullanılmış.`);
    idler.add(id);
    const baslik = metin(k?.baslik);
    if (!baslik) hatalar.push(`${yer}: baslik boş.`);
    const gelistirici = metin(k?.gelistirici);
    if (!gelistiriciler.includes(gelistirici)) hatalar.push(`${yer}: gelistirici şunlardan biri olmalı: ${gelistiriciler.join(", ")} ('${gelistirici || "-"}' yazılmış).`);
    const kapsam = metin(k?.kapsam);
    if (!kapsam) hatalar.push(`${yer}: kapsam boş.`);
    kalemler.push({ id, baslik, gelistirici, bagimli: dizi(k?.bagimli).map((x) => x.toUpperCase()), kabul: dizi(k?.kabul), kapsam });
  });
  for (const k of kalemler) {
    for (const b of k.bagimli) {
      if (b === k.id) hatalar.push(`${k.id}: kendine bağımlı olamaz.`);
      else if (!idler.has(b)) hatalar.push(`${k.id}: bağımlı olduğu '${b}' diye bir kalem yok.`);
    }
  }
  if (hatalar.length) return { hatalar };
  const sirali = sirala(kalemler);
  if (!sirali) return { hatalar: ["Bağımlılıklarda döngü var; kalemler bir sıraya dizilemiyor."] };
  return { kalemler: sirali };
}

/** Bağımlılık sırası (topolojik); eşitlikte planın kendi sırası korunur. Döngü varsa null. */
export function sirala(kalemler: PlanKalemi[]): PlanKalemi[] | null {
  const kalan = [...kalemler];
  const sonuc: PlanKalemi[] = [];
  const bitti = new Set<string>();
  while (kalan.length) {
    const i = kalan.findIndex((k) => k.bagimli.every((b) => bitti.has(b)));
    if (i < 0) return null;
    const [k] = kalan.splice(i, 1);
    sonuc.push(k);
    bitti.add(k.id);
  }
  return sonuc;
}

/** Kalemin klasör ve aşama kimliği: p1; ikinci sürümden sonra v2-p1 (önceki sürümün testleriyle çakışmasın). */
export function kalemKimligi(kalemId: string, surum = 1): string {
  return (surum > 1 ? `v${surum}-` : "") + kalemId.toLowerCase();
}

/** Kalemler aşamasının adımlarını her kalem için somut aşamalara açar (yer tutucular doldurulur). */
export function kalemleriGenislet(sablon: Asama, kalemler: PlanKalemi[], surum = 1): Asama[] {
  return kalemler.flatMap((k) => {
    const g = sablon.gelistiriciler[k.gelistirici];
    const kk = kalemKimligi(k.id, surum);
    const degerler: Record<string, string> = {
      kalem: k.id, kalem_kucuk: kk, baslik: k.baslik, kapsam: k.kapsam, kabul: k.kabul.join(", ") || "-",
      bagimli: k.bagimli.join(", ") || "yok", gelistirici: k.gelistirici, alan: g?.alan ?? "", taraf: g?.taraf ?? "",
    };
    const yaz = (s: string) => s.replace(/\{([a-z_]+)\}/g, (m, ad: string) => degerler[ad] ?? m);
    return sablon.adimlar.map((a): Asama => ({
      ...a,
      id: `${kk}-${a.id}`,
      ad: `${k.id} ${a.ad}`,
      ajan: a.ajan ? yaz(a.ajan) : null,
      gorev: yaz(a.gorev),
      girdiler: a.girdiler.map(yaz),
      cikti: a.cikti ? yaz(a.cikti) : null,
      yazabilir: a.yazabilir.map(yaz),
      kilitle: a.kilitle.map(yaz),
      dogrulama: a.dogrulama.filter((v) => !v.taraf || v.taraf === g?.taraf)
        .map((v) => ({ ...v, ad: yaz(v.ad), komut: v.komut ? yaz(v.komut) : null, odak: yaz(v.odak) })),
      soru: yaz(a.soru),
      geri_donus: null,
      kalem: { id: k.id, baslik: k.baslik },
    }));
  });
}

const EFORLAR: Record<string, string> = { s: "S", k: "S", kucuk: "S", küçük: "S", m: "M", orta: "M", l: "L", b: "L", buyuk: "L", büyük: "L" };
const ONCELIKLER = new Set(["yuksek", "orta", "dusuk"]);

/** ```kovan-gelisim bloğunu okur ve denetler. */
export function gelisimCikar(belge: string): { oneriler?: GelisimOnerisi[]; hatalar?: string[] } {
  const govde = blokBul(belge, "kovan-gelisim");
  if (govde === null) return { hatalar: ["Belgede ```kovan-gelisim bloğu yok. Önerileri bu blokta listele."] };
  const l = liste(govde, "oneriler");
  if (!l.liste) return { hatalar: [`kovan-gelisim ${l.hata}. En az bir öneri olmalı.`] };
  const hatalar: string[] = [];
  if (l.liste.length > EN_FAZLA_ONERI) hatalar.push(`En fazla ${EN_FAZLA_ONERI} öneri olabilir (${l.liste.length} var); en değerlilerini seç.`);
  const oneriler: GelisimOnerisi[] = [];
  const idler = new Set<string>();
  l.liste.slice(0, EN_FAZLA_ONERI).forEach((o, i) => {
    const id = metin(o?.id).toUpperCase() || `G${i + 1}`;
    if (!/^G\d{1,2}$/.test(id)) hatalar.push(`${id}: id G1, G2 biçiminde olmalı.`);
    else if (idler.has(id)) hatalar.push(`${id}: aynı id iki kez kullanılmış.`);
    idler.add(id);
    const baslik = metin(o?.baslik);
    const aciklama = metin(o?.aciklama);
    if (!baslik || !aciklama) hatalar.push(`${id}: baslik ve aciklama zorunlu.`);
    const efor = EFORLAR[metin(o?.efor).toLowerCase()] ?? "M";
    const oncelik = metin(o?.oncelik).toLocaleLowerCase("tr").replace(/ü/g, "u").replace(/ş/g, "s");
    oneriler.push({ id, baslik, aciklama, deger: metin(o?.deger), efor, oncelik: ONCELIKLER.has(oncelik) ? oncelik : "orta" });
  });
  return hatalar.length ? { hatalar } : { oneriler };
}
