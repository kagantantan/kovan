// Akışlar: akislar/<id>.yaml. Her aşama bir "Üret -> Doğrula" döngüsüdür:
//   ajan       : üreten ajan (kart id)
//   dogrulama  : önce deterministik komutlar (ör. bash test-be.sh), sonra onay kurulu (inceleyen ajanlar)
//   yazabilir  : ajanın yazma alanı (kod/ altında)   kilitle: aşama geçince kilitlenen yollar
//   tur: insan : senin onay kapın
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { AjanKarti } from "./kartlar.js";
import type { AkisOzeti } from "./tipler.js";

export interface Dogrulayici {
  tip: "komut" | "ajan";
  ad: string;
  komut: string | null;
  inceleyen: string | null;
  odak: string;
  sure_dk: number;
}

export interface Asama {
  id: string;
  ad: string;
  tur: "ajan" | "insan";
  ajan: string | null;
  gorev: string;
  girdiler: string[];
  cikti: string | null;
  calisma_dizini: "kod" | null;
  yazabilir: string[];
  kilitle: string[];
  dogrulama: Dogrulayici[];
  en_fazla_tur: number;
  soru: string;
  geri_donus: string | null;
}

export interface Akis {
  id: string;
  ad: string;
  aciklama: string;
  fikir_butcesi_usd: number;
  asamalar: Asama[];
}

export function bosAsama(id: string, ad: string): Asama {
  return {
    id, ad, tur: "ajan", ajan: null, gorev: "", girdiler: [], cikti: null, calisma_dizini: null,
    yazabilir: [], kilitle: [], dogrulama: [], en_fazla_tur: 2, soru: "", geri_donus: null,
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

function akisOku(yol: string, kartlar: Map<string, AjanKarti>): Akis {
  const dosya = path.basename(yol);
  const veri = YAML.parse(fs.readFileSync(yol, "utf8")) ?? {};
  if (!Array.isArray(veri.asamalar) || !veri.asamalar.length) throw new Error(`${dosya}: 'asamalar' listesi zorunlu`);
  const asamalar: Asama[] = [];
  const uretilenler = new Set(["fikir", "kararlar"]);
  const idler = new Set<string>();

  veri.asamalar.forEach((ham: Record<string, any>, i: number) => {
    if (!ham || !ham.id) throw new Error(`${dosya}: ${i + 1}. aşamanın 'id' alanı yok`);
    const aid = String(ham.id);
    if (idler.has(aid)) throw new Error(`${dosya}: '${aid}' aşaması iki kez tanımlı`);
    idler.add(aid);
    const tur = String(ham.tur ?? "ajan");
    if (tur !== "ajan" && tur !== "insan") throw new Error(`${dosya}/${aid}: tur 'ajan' ya da 'insan' olmalı`);
    const a: Asama = {
      ...bosAsama(aid, String(ham.ad ?? aid)),
      tur,
      ajan: ham.ajan ? String(ham.ajan) : null,
      gorev: String(ham.gorev ?? "").trim(),
      girdiler: (ham.girdiler ?? []).map(String),
      cikti: ham.cikti ? String(ham.cikti) : null,
      calisma_dizini: ham.calisma_dizini ?? null,
      kilitle: (ham.kilitle ?? []).map(guvenliYol),
      yazabilir: (ham.yazabilir ?? []).map(guvenliYol),
      en_fazla_tur: Number(ham.en_fazla_tur ?? 2),
      soru: String(ham.soru ?? ""),
      geri_donus: ham.geri_donus ? String(ham.geri_donus) : null,
    };
    if (tur === "ajan") {
      if (!a.ajan || !kartlar.has(a.ajan)) throw new Error(`${dosya}/${aid}: ajan '${a.ajan}' için kart yok (ajanlar/ klasörü)`);
      if (!a.cikti) throw new Error(`${dosya}/${aid}: 'cikti' (belge adı) zorunlu`);
      for (const g of a.girdiler) if (!uretilenler.has(g)) throw new Error(`${dosya}/${aid}: girdi '${g}' daha önceki bir aşamada üretilmiyor`);
      if (a.calisma_dizini !== null && a.calisma_dizini !== "kod") throw new Error(`${dosya}/${aid}: calisma_dizini şimdilik yalnızca 'kod' olabilir`);
      if ((a.kilitle.length || a.yazabilir.length) && a.calisma_dizini !== "kod")
        throw new Error(`${dosya}/${aid}: kilitle/yazabilir yalnızca calisma_dizini: kod ile kullanılır`);
      (ham.dogrulama ?? []).forEach((d: Record<string, any>, j: number) => {
        if (!d || typeof d !== "object") throw new Error(`${dosya}/${aid}: ${j + 1}. doğrulayıcı geçersiz`);
        if (d.komut) {
          if (a.calisma_dizini !== "kod") throw new Error(`${dosya}/${aid}: komut doğrulaması için calisma_dizini: kod gerekli`);
          a.dogrulama.push({ tip: "komut", ad: String(d.ad ?? "Kontrol"), komut: String(d.komut), inceleyen: null, odak: "", sure_dk: Number(d.sure_dk ?? 5) });
        } else if (d.inceleyen) {
          const kart = kartlar.get(String(d.inceleyen));
          if (!kart) throw new Error(`${dosya}/${aid}: inceleyen '${d.inceleyen}' için kart yok`);
          a.dogrulama.push({
            tip: "ajan", ad: String(d.ad ?? `${kart.kisaltma} onayı`), komut: null, inceleyen: kart.id,
            odak: String(d.odak ?? "").trim(), sure_dk: Number(d.sure_dk ?? kart.sure_dk),
          });
        } else {
          throw new Error(`${dosya}/${aid}: doğrulayıcıda 'komut' ya da 'inceleyen' olmalı`);
        }
      });
      uretilenler.add(a.cikti);
    }
    asamalar.push(a);
  });
  for (const a of asamalar) {
    if (a.geri_donus && !idler.has(a.geri_donus)) throw new Error(`${dosya}/${a.id}: geri_donus '${a.geri_donus}' diye bir aşama yok`);
  }
  return {
    id: path.basename(yol, ".yaml"),
    ad: String(veri.ad ?? path.basename(yol, ".yaml")),
    aciklama: String(veri.aciklama ?? "").trim(),
    fikir_butcesi_usd: Number(veri.fikir_butcesi_usd ?? 5),
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

export function akisOzeti(a: Akis, kartlar: Map<string, AjanKarti>): AkisOzeti {
  const ad = (k: string | null) => (k && kartlar.get(k)?.ad) || null;
  return {
    id: a.id, ad: a.ad, aciklama: a.aciklama, fikir_butcesi_usd: a.fikir_butcesi_usd,
    asamalar: a.asamalar.map((s) => ({
      id: s.id, ad: s.ad, tur: s.tur, ajan: s.ajan, ajan_ad: ad(s.ajan), ajan_kisa: (s.ajan && kartlar.get(s.ajan)?.kisaltma) || null,
      girdiler: s.girdiler, cikti: s.cikti,
      kilitle: s.kilitle, yazabilir: s.yazabilir, en_fazla_tur: s.en_fazla_tur,
      dogrulama: s.dogrulama.map((d) => ({ ad: d.ad, tip: d.tip, komut: d.komut, inceleyen: d.inceleyen, inceleyen_ad: ad(d.inceleyen) })),
    })),
  };
}
