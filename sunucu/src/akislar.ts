// Akışlar: akislar/<id>.yaml. Her aşama bir "Üret -> Doğrula" döngüsüdür:
//   ajan       : üreten ajan (kart id)
//   dogrulama  : önce deterministik denetimler (komut: ör. bash test-be.sh, plan: teslim planı biçimi),
//                sonra onay kurulu (inceleyen ajanlar)
//   yazabilir  : ajanın yazma alanı (kod/ altında)   kilitle: aşama geçince kilitlenen yollar
//   tur: insan    : senin onay kapın
//   tur: kalemler : teslim planındaki her iş kalemi için "adimlar" sırayla tekrarlanır (P1, P2, ...)
//   tur: gelisim  : Ürün Sahibi gelişim önerileri çıkarır; her öneri sana "olmalı mı?" diye gelir
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { AjanKarti } from "./kartlar.js";
import type { AkisAsamaOzeti, AkisOzeti, AsamaTuru } from "./tipler.js";

export interface Dogrulayici {
  tip: "komut" | "ajan" | "plan" | "atif";
  ad: string;
  komut: string | null;
  inceleyen: string | null;
  odak: string;
  sure_dk: number;
  atlanabilir: boolean;          // onaycı bu fikirde "alanım yok" dediyse sonraki aşamalarda atlanır
  gelistiriciler: string[];      // tip: plan -> planda izin verilen yazılımcılar
  taraf: string | null;          // kalem adımında: yalnızca bu taraftaki kalemlerde (ör. fe) çalışır
}

export interface KalemBilgisi {
  id: string;
  baslik: string;
}

export interface GelistiriciAyari {
  alan: string;    // yazılımcının klasörü (backend, frontend)
  taraf: string;   // test tarafı (be, fe): testler/<taraf>/, test-<taraf>.sh
}

export interface Asama {
  id: string;
  ad: string;
  tur: AsamaTuru;
  ajan: string | null;
  gorev: string;
  girdiler: string[];
  cikti: string | null;
  calisma_dizini: "kod" | null;
  salt_okunur: boolean;            // kod/'u (ve kaynak/'ı) okur, hiçbir şey yazamaz; son mesajı belgenin kendisidir
  yazabilir: string[];
  kilitle: string[];
  dogrulama: Dogrulayici[];
  en_fazla_tur: number;
  soru: string;
  geri_donus: string | null;
  kalem: KalemBilgisi | null;                          // genişletilmiş iş kalemi aşaması
  plan: string | null;                                 // tur: kalemler -> planı içeren belge
  gelistiriciler: Record<string, GelistiriciAyari>;    // tur: kalemler
  adimlar: Asama[];                                    // tur: kalemler -> her kalemde tekrarlanan adımlar
}

export interface Akis {
  id: string;
  ad: string;
  aciklama: string;
  fikir_butcesi_usd: number;
  ortak_karar: boolean;
  kaynak: "zorunlu" | "yok";       // zorunlu: fikir mevcut sistemin kodu ve dokümanlarıyla başlar
  asamalar: Asama[];
}

/** Her akışta her zaman okunabilen belgeler (Kovan yazar). */
export const HAZIR_BELGELER = ["fikir", "kararlar", "gelisim-defteri", "kaynak-envanteri"];

export function bosAsama(id: string, ad: string): Asama {
  return {
    id, ad, tur: "ajan", ajan: null, gorev: "", girdiler: [], cikti: null, calisma_dizini: null, salt_okunur: false,
    yazabilir: [], kilitle: [], dogrulama: [], en_fazla_tur: 2, soru: "", geri_donus: null,
    kalem: null, plan: null, gelistiriciler: {}, adimlar: [],
  };
}

/** "./backend/" -> "backend"; kod/ altında göreli ve güvenli yol. */
export function guvenliYol(ham: unknown): string {
  let y = String(ham).trim().replace(/\\/g, "/");
  while (y.startsWith("./")) y = y.slice(2);
  y = y.replace(/^\/+|\/+$/g, "");
  if (!y || y.startsWith("..") || `/${y}/`.includes("/../")) throw new Error(`geçersiz yol: ${ham}`);
  return y;
}

const TURLER: AsamaTuru[] = ["ajan", "insan", "kalemler", "gelisim"];
const GELISTIRICI_YER_TUTUCU = "{gelistirici}";

/** Bir ajan (ya da gelişim) aşamasını ya da kalem adımını okur. sablon: kalem adımı (yer tutucular serbest). */
function ajanAsamasiOku(dosya: string, ham: Record<string, any>, a: Asama, kartlar: Map<string, AjanKarti>,
  uretilenler: Set<string>, sablon: { gelistiriciler: string[] } | null): void {
  const yer = `${dosya}/${a.id}`;
  const gelistiriciAdimi = sablon !== null && a.ajan === GELISTIRICI_YER_TUTUCU;
  if (!gelistiriciAdimi && (!a.ajan || !kartlar.has(a.ajan))) throw new Error(`${yer}: ajan '${a.ajan}' için kart yok (ajanlar/ klasörü)`);
  if (!a.cikti) throw new Error(`${yer}: 'cikti' (belge adı) zorunlu`);
  for (const g of a.girdiler) if (!uretilenler.has(g)) throw new Error(`${yer}: girdi '${g}' daha önceki bir aşamada üretilmiyor`);
  if (a.calisma_dizini !== null && a.calisma_dizini !== "kod") throw new Error(`${yer}: calisma_dizini şimdilik yalnızca 'kod' olabilir`);
  if ((a.kilitle.length || a.yazabilir.length || a.salt_okunur) && a.calisma_dizini !== "kod")
    throw new Error(`${yer}: kilitle/yazabilir/salt_okunur yalnızca calisma_dizini: kod ile kullanılır`);
  if (a.salt_okunur && (a.kilitle.length || a.yazabilir.length)) throw new Error(`${yer}: salt_okunur aşamada yazabilir ya da kilitle olmaz`);
  (ham.dogrulama ?? []).forEach((d: Record<string, any>, j: number) => {
    if (!d || typeof d !== "object") throw new Error(`${yer}: ${j + 1}. doğrulayıcı geçersiz`);
    if (d.taraf && !sablon) throw new Error(`${yer}: 'taraf' koşulu yalnızca kalem adımlarında kullanılır`);
    const ortak = { komut: null, inceleyen: null, odak: "", atlanabilir: false, gelistiriciler: [] as string[], taraf: d.taraf ? String(d.taraf) : null };
    if (d.komut) {
      if (a.calisma_dizini !== "kod") throw new Error(`${yer}: komut doğrulaması için calisma_dizini: kod gerekli`);
      a.dogrulama.push({ ...ortak, tip: "komut", ad: String(d.ad ?? "Kontrol"), komut: String(d.komut), sure_dk: Number(d.sure_dk ?? 5) });
    } else if (d.plan) {
      a.dogrulama.push({ ...ortak, tip: "plan", ad: String(d.ad ?? "Plan biçimi"), sure_dk: 0 });
    } else if (d.atif) {
      a.dogrulama.push({ ...ortak, tip: "atif", ad: String(d.ad ?? "Kaynak atıfları"), sure_dk: 0 });
    } else if (d.inceleyen) {
      const kart = kartlar.get(String(d.inceleyen));
      if (!kart) throw new Error(`${yer}: inceleyen '${d.inceleyen}' için kart yok`);
      a.dogrulama.push({
        ...ortak, tip: "ajan", ad: String(d.ad ?? `${kart.kisaltma} onayı`), inceleyen: kart.id,
        odak: String(d.odak ?? "").trim(), sure_dk: Number(d.sure_dk ?? kart.sure_dk), atlanabilir: Boolean(d.atlanabilir),
      });
    } else {
      throw new Error(`${yer}: doğrulayıcıda 'komut', 'plan', 'atif' ya da 'inceleyen' olmalı`);
    }
  });
  uretilenler.add(a.cikti);
}

function asamaOku(dosya: string, ham: Record<string, any>, i: number, kartlar: Map<string, AjanKarti>): Asama {
  if (!ham || !ham.id) throw new Error(`${dosya}: ${i + 1}. aşamanın 'id' alanı yok`);
  const aid = String(ham.id);
  const tur = String(ham.tur ?? "ajan") as AsamaTuru;
  if (!TURLER.includes(tur)) throw new Error(`${dosya}/${aid}: tur şunlardan biri olmalı: ${TURLER.join(", ")}`);
  return {
    ...bosAsama(aid, String(ham.ad ?? aid)),
    tur,
    ajan: ham.ajan ? String(ham.ajan) : null,
    gorev: String(ham.gorev ?? "").trim(),
    girdiler: (ham.girdiler ?? []).map(String),
    cikti: ham.cikti ? String(ham.cikti) : null,
    calisma_dizini: ham.calisma_dizini ?? null,
    salt_okunur: Boolean(ham.salt_okunur),
    kilitle: (ham.kilitle ?? []).map(guvenliYol),
    yazabilir: (ham.yazabilir ?? []).map(guvenliYol),
    en_fazla_tur: Number(ham.en_fazla_tur ?? 2),
    soru: String(ham.soru ?? ""),
    geri_donus: ham.geri_donus ? String(ham.geri_donus) : null,
  };
}

function akisOku(yol: string, kartlar: Map<string, AjanKarti>): Akis {
  const dosya = path.basename(yol);
  const veri = YAML.parse(fs.readFileSync(yol, "utf8")) ?? {};
  if (!Array.isArray(veri.asamalar) || !veri.asamalar.length) throw new Error(`${dosya}: 'asamalar' listesi zorunlu`);
  const asamalar: Asama[] = [];
  const uretilenler = new Set(HAZIR_BELGELER);
  const kaynakTuru = String(veri.kaynak ?? "yok");
  if (kaynakTuru !== "zorunlu" && kaynakTuru !== "yok") throw new Error(`${dosya}: kaynak 'zorunlu' ya da 'yok' olmalı`);
  const idler = new Set<string>();

  veri.asamalar.forEach((ham: Record<string, any>, i: number) => {
    const a = asamaOku(dosya, ham, i, kartlar);
    if (idler.has(a.id)) throw new Error(`${dosya}: '${a.id}' aşaması iki kez tanımlı`);
    idler.add(a.id);
    if (a.tur === "ajan" || a.tur === "gelisim") {
      ajanAsamasiOku(dosya, ham, a, kartlar, uretilenler, null);
    } else if (a.tur === "kalemler") {
      const yer = `${dosya}/${a.id}`;
      a.plan = ham.plan ? String(ham.plan) : null;
      if (!a.plan || !uretilenler.has(a.plan)) throw new Error(`${yer}: 'plan' daha önceki bir aşamanın ürettiği teslim planı belgesi olmalı`);
      const gel = ham.gelistiriciler ?? {};
      if (typeof gel !== "object" || Array.isArray(gel) || !Object.keys(gel).length)
        throw new Error(`${yer}: 'gelistiriciler' zorunlu (ör. be-yazilimci: {alan: backend, taraf: be})`);
      for (const [kid, ayar] of Object.entries(gel as Record<string, any>)) {
        if (!kartlar.has(kid)) throw new Error(`${yer}: gelistiriciler: '${kid}' için kart yok`);
        if (!ayar?.alan || !ayar?.taraf) throw new Error(`${yer}: gelistiriciler.${kid} için 'alan' ve 'taraf' zorunlu`);
        a.gelistiriciler[kid] = { alan: guvenliYol(ayar.alan), taraf: String(ayar.taraf) };
      }
      if (!Array.isArray(ham.adimlar) || !ham.adimlar.length) throw new Error(`${yer}: 'adimlar' listesi zorunlu`);
      const icIdler = new Set<string>();
      const icUretilen = new Set(uretilenler);
      ham.adimlar.forEach((h: Record<string, any>, j: number) => {
        const s = asamaOku(`${dosya}/${a.id}`, h, j, kartlar);
        if (s.tur !== "ajan") throw new Error(`${yer}/${s.id}: kalem adımları ajan aşaması olmalı`);
        if (icIdler.has(s.id)) throw new Error(`${yer}: '${s.id}' adımı iki kez tanımlı`);
        icIdler.add(s.id);
        ajanAsamasiOku(`${dosya}/${a.id}`, h, s, kartlar, icUretilen, { gelistiriciler: Object.keys(a.gelistiriciler) });
        a.adimlar.push(s);
      });
      uretilenler.add("kalemler");   // sonraki aşamalar bütün kalemlerin özetini okuyabilir
    }
    asamalar.push(a);
  });
  // Plan denetimi, planı açacak kalemler aşamasının yazılımcı listesini bilir.
  for (const a of asamalar) {
    for (const v of a.dogrulama.filter((x) => x.tip === "plan")) {
      const k = asamalar.find((x) => x.tur === "kalemler" && x.plan === a.cikti);
      if (!k) throw new Error(`${dosya}/${a.id}: plan denetimi var ama bu belgeyi açan 'tur: kalemler' aşaması yok`);
      v.gelistiriciler = Object.keys(k.gelistiriciler);
    }
  }
  for (const a of asamalar) {
    if (a.geri_donus && !idler.has(a.geri_donus)) throw new Error(`${dosya}/${a.id}: geri_donus '${a.geri_donus}' diye bir aşama yok`);
  }
  return {
    id: path.basename(yol, ".yaml"),
    ad: String(veri.ad ?? path.basename(yol, ".yaml")),
    aciklama: String(veri.aciklama ?? "").trim(),
    fikir_butcesi_usd: Number(veri.fikir_butcesi_usd ?? 5),
    ortak_karar: veri.ortak_karar === undefined ? true : Boolean(veri.ortak_karar),
    kaynak: kaynakTuru as "zorunlu" | "yok",
    asamalar,
  };
}

export function akislariYukle(dizin: string, kartlar: Map<string, AjanKarti>): Map<string, Akis> {
  const akislar = new Map<string, Akis>();
  for (const dosya of fs.readdirSync(dizin).sort()) {
    if (!dosya.endsWith(".yaml")) continue;
    const a = akisOku(path.join(dizin, dosya), kartlar);
    akislar.set(a.id, a);
  }
  if (!akislar.size) throw new Error(`${dizin} içinde akış bulunamadı`);
  return akislar;
}

/** Akıştaki bütün üretim adımları (kalem şablonları dahil); ajan sayfası ve motor denetimi için. */
export function tumAdimlar(a: Akis): Asama[] {
  return a.asamalar.flatMap((s) => (s.tur === "kalemler" ? s.adimlar : [s]));
}

function asamaOzeti(s: Asama, kartlar: Map<string, AjanKarti>, gelistiriciler: string[] = []): AkisAsamaOzeti {
  const ad = (k: string | null) => (k && kartlar.get(k)?.ad) || (k === GELISTIRICI_YER_TUTUCU ? "Kalemin yazılımcısı" : null);
  const yazilimcilar = gelistiriciler.map((g) => kartlar.get(g)?.kisaltma ?? g).join("/") || null;
  return {
    id: s.id, ad: s.ad, tur: s.tur, ajan: s.ajan, ajan_ad: ad(s.ajan),
    ajan_kisa: (s.ajan && kartlar.get(s.ajan)?.kisaltma) || (s.ajan === GELISTIRICI_YER_TUTUCU ? yazilimcilar : null),
    girdiler: s.girdiler, cikti: s.cikti, salt_okunur: s.salt_okunur,
    kilitle: s.kilitle, yazabilir: s.yazabilir, en_fazla_tur: s.en_fazla_tur,
    dogrulama: s.dogrulama.map((d) => ({ ad: d.ad, tip: d.tip, komut: d.komut, inceleyen: d.inceleyen, inceleyen_ad: ad(d.inceleyen), atlanabilir: d.atlanabilir, taraf: d.taraf })),
    kalem_adimlari: s.adimlar.map((x) => asamaOzeti(x, kartlar, Object.keys(s.gelistiriciler))),
  };
}

export function akisOzeti(a: Akis, kartlar: Map<string, AjanKarti>): AkisOzeti {
  return {
    id: a.id, ad: a.ad, aciklama: a.aciklama, fikir_butcesi_usd: a.fikir_butcesi_usd, ortak_karar: a.ortak_karar, kaynak: a.kaynak,
    asamalar: a.asamalar.map((s) => asamaOzeti(s, kartlar)),
  };
}
