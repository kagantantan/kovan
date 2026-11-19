// Ajan seçimleri: her ajanın hangi motorda ve hangi modelle çalışacağı, Ajanlar ekranından.
// Sıra: kart (ajanlar/*.md) < dış ayar (ajanlar: bölümü) < ekran seçimi. Yalnızca motor ve model değişir;
// araçlar, izinler ve sistem promptu kartta kalır (yetki dışarıdan genişletilmez).
// Seçimler repo dışında durur (varsayılan ~/.kovan/ajan-secimleri.json); testlerde dosya yok, yalnızca bellek.
import os from "node:os";
import path from "node:path";
import type { AjanKarti } from "./kartlar.js";
import { KovanHatasi, atomikYaz, jsonOku } from "./ortak.js";

export interface AjanSecimi {
  motor: string;    // "claude" ya da kovan.yaml'daki bir motorun adı (ör. qwen-yerel)
  model: string;    // o motordaki model (Claude: sonnet, opus, haiku; Ollama: qwen3:8b...)
}

const MODEL_KALIBI = /^[A-Za-z0-9._:/@+-]{1,100}$/;

export const varsayilanSecimDosyasi = (): string =>
  process.env.KOVAN_AJAN_SECIMLERI || path.join(os.homedir(), ".kovan", "ajan-secimleri.json");

export class AjanSecimleri {
  private secimler: Record<string, AjanSecimi>;
  /** Kart ve dış ayar uygulandıktan sonraki değerler: seçim kaldırılınca bunlara dönülür. */
  private taban = new Map<string, Pick<AjanKarti, "motor" | "model" | "yerel_model">>();

  constructor(private kartlar: Map<string, AjanKarti>, private motorAdlari: () => string[], private dosya: string | null) {
    for (const k of kartlar.values()) this.taban.set(k.id, { motor: k.motor, model: k.model, yerel_model: k.yerel_model });
    this.secimler = dosya ? jsonOku<Record<string, AjanSecimi>>(dosya, {}) : {};
    // Dosyadaki geçersiz seçimler (silinmiş ajan ya da motor) yok sayılır; Kovan açılmaya devam eder
    for (const [id, s] of Object.entries(this.secimler)) {
      if (this.hata(id, s)) delete this.secimler[id];
      else this.uygula(id);
    }
  }

  private hata(id: string, s: AjanSecimi | undefined): string | null {
    if (!this.kartlar.has(id)) return `Bilinmeyen ajan: ${id}`;
    if (!s || typeof s.motor !== "string" || typeof s.model !== "string") return "motor ve model gerekli.";
    if (!this.motorAdlari().includes(s.motor)) return `Bu kurulumda '${s.motor}' diye bir motor yok. Motorlar: ${this.motorAdlari().join(", ")}`;
    if (!MODEL_KALIBI.test(s.model)) return `Geçersiz model adı: '${s.model}'`;
    return null;
  }

  private uygula(id: string): void {
    const k = this.kartlar.get(id)!;
    Object.assign(k, this.taban.get(id));
    const s = this.secimler[id];
    if (!s) return;
    k.motor = s.motor;
    if (s.motor === "claude") k.model = s.model;
    else k.yerel_model = s.model;
  }

  private kaydet(): void {
    if (this.dosya) atomikYaz(this.dosya, JSON.stringify(this.secimler, null, 2));
  }

  secim(id: string): AjanSecimi | null {
    return this.secimler[id] ?? null;
  }

  ayarla(id: string, s: AjanSecimi): void {
    const temiz = { motor: String(s?.motor ?? "").trim(), model: String(s?.model ?? "").trim() };
    const h = this.hata(id, temiz);
    if (h) throw new KovanHatasi(h, this.kartlar.has(id) ? 400 : 404);
    this.secimler[id] = temiz;
    this.uygula(id);
    this.kaydet();
  }

  kaldir(id: string): void {
    if (!this.kartlar.has(id)) throw new KovanHatasi(`Bilinmeyen ajan: ${id}`, 404);
    delete this.secimler[id];
    this.uygula(id);
    this.kaydet();
  }
}
