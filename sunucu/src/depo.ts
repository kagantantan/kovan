// Depo: her fikrin durumu ve adımları kendi klasöründe okunabilir JSON olarak tutulur.
//   calisma/F-001/.kovan/fikir.json    calisma/F-001/.kovan/adimlar.json
// Tek süreç olduğu için bellekte tutulur, her değişiklikte atomik olarak diske yazılır.
import fs from "node:fs";
import path from "node:path";
import { atomikYaz, jsonOku, simdi } from "./ortak.js";

import type { Adim, Fikir, FikirDurumu } from "./tipler.js";
export type { Adim, AdimTipi, AjanSorusu, Bekleme, BeklemeSebebi, Fikir, FikirDurumu, Secenek } from "./tipler.js";

/** Silinen fikirlerin klasörü (calisma/.cop/F-004-20261119...). */
export const COP_KLASORU = ".cop";

export class Depo {
  private fikirMap = new Map<string, Fikir>();
  private adimMap = new Map<string, Adim[]>();

  constructor(private calisma: string) {
    fs.mkdirSync(calisma, { recursive: true });
    for (const ad of fs.readdirSync(calisma)) {
      const f = jsonOku<Fikir | null>(path.join(calisma, ad, ".kovan", "fikir.json"), null);
      if (!f) continue;
      f.istisnalar ??= {};
      f.soru_turu ??= 0;
      this.fikirMap.set(f.id, f);
      this.adimMap.set(f.id, jsonOku<Adim[]>(path.join(calisma, ad, ".kovan", "adimlar.json"), []));
    }
  }

  private kaydet(fid: string): void {
    const f = this.fikirMap.get(fid);
    if (!f) return;
    atomikYaz(path.join(this.calisma, fid, ".kovan", "fikir.json"), JSON.stringify(f, null, 2));
    atomikYaz(path.join(this.calisma, fid, ".kovan", "adimlar.json"), JSON.stringify(this.adimMap.get(fid) ?? [], null, 1));
  }

  // ---------------- fikirler ----------------
  yeniId(): string {
    let enBuyuk = 0;
    for (const id of this.fikirMap.keys()) enBuyuk = Math.max(enBuyuk, Number(id.split("-").pop()) || 0);
    // Silinen fikirlerin numarası yeniden kullanılmaz: çöp kutusundaki F-004-... de sayılır
    const cop = path.join(this.calisma, COP_KLASORU);
    if (fs.existsSync(cop)) for (const ad of fs.readdirSync(cop)) enBuyuk = Math.max(enBuyuk, Number(/^F-(\d+)/.exec(ad)?.[1]) || 0);
    return `F-${String(enBuyuk + 1).padStart(3, "0")}`;
  }

  fikirEkle(f: Fikir): void {
    this.fikirMap.set(f.id, f);
    this.adimMap.set(f.id, []);
    this.kaydet(f.id);
  }

  /** Fikri listeden çıkarır ve klasörünü çöp kutusuna (calisma/.cop/) taşır; kalıcı silme yok, elle geri taşınabilir. */
  fikirKaldir(fid: string): string {
    if (!this.fikirMap.has(fid)) throw new Error(`Fikir yok: ${fid}`);
    const hedef = path.join(this.calisma, COP_KLASORU, `${fid}-${simdi().replace(/[^0-9]/g, "").slice(0, 14)}`);
    fs.mkdirSync(path.dirname(hedef), { recursive: true });
    fs.renameSync(path.join(this.calisma, fid), hedef);
    this.fikirMap.delete(fid);
    this.adimMap.delete(fid);
    return hedef;
  }

  fikir(fid: string): Fikir | undefined {
    return this.fikirMap.get(fid);
  }

  fikirler(): Fikir[] {
    return [...this.fikirMap.values()].sort((a, b) => (b.olusturma + b.id).localeCompare(a.olusturma + a.id));
  }

  fikirGuncelle(fid: string, alanlar: Partial<Fikir>): Fikir {
    const f = this.fikirMap.get(fid);
    if (!f) throw new Error(`Fikir yok: ${fid}`);
    Object.assign(f, alanlar, { guncelleme: simdi() });
    this.kaydet(fid);
    return f;
  }

  maliyetEkle(fid: string, maliyet: number, girdi: number, cikti: number): void {
    const f = this.fikirMap.get(fid);
    if (!f) return;
    f.maliyet_usd += maliyet || 0;
    f.girdi_token += girdi || 0;
    f.cikti_token += cikti || 0;
    this.kaydet(fid);
  }

  durumdakiler(...durumlar: FikirDurumu[]): Fikir[] {
    return [...this.fikirMap.values()].filter((f) => durumlar.includes(f.durum));
  }

  // ---------------- adımlar ----------------
  adimEkle(a: Omit<Adim, "id" | "basla" | "bitis" | "sure_sn" | "maliyet_usd" | "girdi_token" | "cikti_token" | "ajan_turu" | "ozet" | "dosya"> &
    Partial<Pick<Adim, "ozet" | "dosya">>): number {
    const liste = this.adimMap.get(a.fikir_id) ?? [];
    const id = (liste.at(-1)?.id ?? 0) + 1;
    liste.push({
      ozet: "", dosya: "", ...a, id, basla: simdi(), bitis: null, sure_sn: null,
      maliyet_usd: 0, girdi_token: 0, cikti_token: 0, ajan_turu: 0,
    });
    this.adimMap.set(a.fikir_id, liste);
    this.kaydet(a.fikir_id);
    return id;
  }

  adimGuncelle(fid: string, adimId: number, alanlar: Partial<Adim>): void {
    const s = this.adim(fid, adimId);
    if (!s) return;
    Object.assign(s, alanlar);
    this.kaydet(fid);
  }

  adim(fid: string, adimId: number): Adim | undefined {
    return this.adimMap.get(fid)?.find((s) => s.id === adimId);
  }

  adimlar(fid: string): Adim[] {
    return this.adimMap.get(fid) ?? [];
  }

  calisanAdimlariKapat(): void {
    for (const [fid, liste] of this.adimMap) {
      let degisti = false;
      for (const s of liste) if (s.durum === "calisiyor") { s.durum = "kesildi"; s.bitis = simdi(); degisti = true; }
      if (degisti) this.kaydet(fid);
    }
  }
}
