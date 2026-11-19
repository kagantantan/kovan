// Ajan çıktısındaki yapılandırılmış bloklar:
//   ```kovan-plan     Proje Yöneticisi'nin teslim planı: sıralı iş kalemleri (P1, P2...) ve bağımlılıkları
//   ```kovan-gelisim  Ürün Sahibi'nin gelişim önerileri (G1, G2...)
//   ```kovan-adr      Mimar'ın mimari karar kayıtları (ADR-1, ADR-2...): her biri en az iki seçenekle
// Bloklar YAML ya da JSON olabilir. Hatalar insan diliyle döner; üreten ajana bulgu olarak gider.
import YAML from "yaml";
import type { Asama } from "./akislar.js";
import type { Adr, AdrSecenegi, GelisimOnerisi, PlanKalemi } from "./tipler.js";

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

export const EN_FAZLA_ADR = 12;
export const ADR_ALANLARI = ["calisma_bicimi", "veri", "performans", "hata", "guvenlik", "entegrasyon", "test", "diger"] as const;

const sade = (s: string) => s.toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();

/** ```kovan-adr bloğunu okur ve denetler. zorunlu: bu alanlarda en az birer ADR olmalı (ör. replatformda calisma_bicimi). */
export function adrCikar(belge: string, secenek: { en_az?: number; zorunlu?: string[] } = {}): { adrler?: Adr[]; hatalar?: string[] } {
  const enAz = secenek.en_az ?? 1;
  const govde = blokBul(belge, "kovan-adr");
  if (govde === null) return { hatalar: ["Belgede ```kovan-adr bloğu yok. Önemli mimari kararları bu blokta ADR olarak yaz."] };
  const l = liste(govde, "adrler");
  if (!l.liste) return { hatalar: [`kovan-adr ${l.hata}. En az ${enAz} ADR olmalı.`] };
  const hatalar: string[] = [];
  if (l.liste.length < enAz) hatalar.push(`En az ${enAz} ADR olmalı (${l.liste.length} var).`);
  if (l.liste.length > EN_FAZLA_ADR) hatalar.push(`En fazla ${EN_FAZLA_ADR} ADR olabilir (${l.liste.length} var); küçük kararları teknik planda bırak.`);
  const adrler: Adr[] = [];
  const idler = new Set<string>();
  l.liste.slice(0, EN_FAZLA_ADR).forEach((a, i) => {
    const id = metin(a?.id).toUpperCase().replace(/^ADR-?0*(\d)/, "ADR-$1");
    const yer = id || `${i + 1}. ADR`;
    if (!/^ADR-\d{1,3}$/.test(id)) hatalar.push(`${yer}: id ADR-1, ADR-2 biçiminde olmalı.`);
    else if (idler.has(id)) hatalar.push(`${id}: aynı id iki kez kullanılmış.`);
    idler.add(id);
    const alan = metin(a?.alan).toLowerCase();
    if (!(ADR_ALANLARI as readonly string[]).includes(alan)) hatalar.push(`${yer}: alan şunlardan biri olmalı: ${ADR_ALANLARI.join(", ")} ('${alan || "-"}' yazılmış).`);
    for (const z of ["baslik", "baglam", "karar", "gerekce", "sonuclar"] as const) if (!metin(a?.[z])) hatalar.push(`${yer}: ${z} boş.`);
    const ham = Array.isArray(a?.secenekler) ? (a.secenekler as Record<string, unknown>[]) : [];
    const secenekler: AdrSecenegi[] = ham.map((s) => ({ ad: metin(s?.ad), arti: metin(s?.arti), eksi: metin(s?.eksi) }));
    if (secenekler.length < 2) hatalar.push(`${yer}: en az iki seçenek olmalı; her biri ad, arti, eksi ile.`);
    secenekler.forEach((s, j) => { if (!s.ad || !s.arti || !s.eksi) hatalar.push(`${yer}: ${j + 1}. seçenekte ad, arti ve eksi zorunlu.`); });
    const karar = metin(a?.karar);
    if (karar && secenekler.length >= 2 && !secenekler.some((s) => sade(s.ad) === sade(karar)))
      hatalar.push(`${yer}: karar ('${karar}') seçeneklerden birinin adıyla aynı olmalı.`);
    adrler.push({ id, baslik: metin(a?.baslik), alan, baglam: metin(a?.baglam), secenekler, karar, gerekce: metin(a?.gerekce),
      sonuclar: metin(a?.sonuclar), kurallar: dizi(a?.kurallar).map((x) => x.toUpperCase()) });
  });
  for (const z of secenek.zorunlu ?? []) {
    if (!adrler.some((a) => a.alan === z)) hatalar.push(`'${z}' alanında bir ADR yok; bu akışta zorunlu.`);
  }
  return hatalar.length ? { hatalar } : { adrler };
}

const dosyaAdi = (s: string) => s.toLocaleLowerCase("tr").replace(/ı/g, "i").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s")
  .replace(/ö/g, "o").replace(/ç/g, "c").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "karar";

/** ADR'nin kod/adr/ altındaki dosyası: ADR-001-calisma-bicimi.md */
export function adrDosyaAdi(a: Adr): string {
  return `ADR-${a.id.replace("ADR-", "").padStart(3, "0")}-${dosyaAdi(a.baslik)}.md`;
}

/** ADR'yi okunur Markdown'a çevirir (Nygard biçimi, seçeneklerle). */
export function adrMarkdown(a: Adr, tarih: string): string {
  const s = [`# ${a.id}: ${a.baslik}`, "", `- Durum: Kabul edildi (${tarih})`, `- Alan: ${a.alan}`];
  if (a.kurallar.length) s.push(`- İlgili: ${a.kurallar.join(", ")}`);
  s.push("", "## Bağlam", a.baglam, "", "## Seçenekler");
  for (const o of a.secenekler) s.push("", `### ${o.ad}${sade(o.ad) === sade(a.karar) ? " (seçildi)" : ""}`, `- Artı: ${o.arti}`, `- Eksi: ${o.eksi}`);
  s.push("", "## Karar", a.karar, "", "## Gerekçe", a.gerekce, "", "## Sonuçlar", a.sonuclar, "");
  return s.join("\n");
}

/** Belgedeki kimlikler: kurallar (E3), kabul (K2), hesaplar (H1), kalemler (P2), farklar ve şüpheler (FARK-1, ŞÜPHE-6), ADR'ler. */
const KIMLIK = /(?<![\p{L}\p{N}_-])(?:E|K|H|P|ADR-|FARK-|ŞÜPHE-)\d{1,3}(?![\p{N}])/gu;
export const kimlikler = (metin: string): Set<string> => new Set(metin.match(KIMLIK) ?? []);

/** Revizyonda yeni belge öncekinin tamamı olmalı: kimlik kaybı ya da yarıdan fazla kısalma, belgenin baştan ya da
 *  kısmen yazıldığını gösterir (önceki turların içeriği kaybolur). Bulgu, onay kuruluna gitmeden yazara döner. */
export function belgeButunlugu(onceki: string, yeni: string): { hatalar: string[]; ozet: string } {
  const eski = kimlikler(onceki);
  const simdi = kimlikler(yeni);
  const kayip = [...eski].filter((k) => !simdi.has(k));
  const hatalar: string[] = [];
  if (kayip.length) {
    hatalar.push(`Önceki sürümde olan ${kayip.length} kimlik bu sürümde yok: ${kayip.slice(0, 30).join(", ")}${kayip.length > 30 ? "..." : ""}. ` +
      "Belge önceki sürümün tamamı olmalı: onaylanmış bölümleri aynen koru, yalnızca istenenleri düzelt. Bir kuralı bilerek kaldırıyorsan kimliğini ve nedenini \"Kaldırılanlar\" bölümünde yaz.");
  }
  if (yeni.trim().length < onceki.trim().length * 0.5) {
    hatalar.push(`Belge önceki sürümün yarısından kısa (${yeni.trim().length.toLocaleString("tr-TR")} / ${onceki.trim().length.toLocaleString("tr-TR")} karakter); bölümler düşmüş görünüyor. Önceki sürümün tamamını temel al.`);
  }
  return { hatalar, ozet: `${simdi.size} kimlik korundu, ${yeni.trim().length.toLocaleString("tr-TR")} karakter` };
}
