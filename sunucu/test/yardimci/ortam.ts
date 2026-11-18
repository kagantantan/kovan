// Test ortamı: geçici Kovan kökü, sahte motorlar ve durum bekleme yardımcıları.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ayarlar } from "../../src/ayarlar.js";
import type { AjanKarti } from "../../src/kartlar.js";
import { DenemeMotoru, sonuc, type AjanCagrisi, type AjanSonucu, type Motor, type MotorDurumu } from "../../src/motor.js";
import { kovanKur, type Kovan } from "../../src/sunucu.js";
import type { Fikir } from "../../src/tipler.js";

export const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Kovan kökünün geçici kopyası. ekAkislar: akislar/<ad>.yaml olarak eklenir. */
export function geciciKok(ekAkislar: Record<string, string> = {}): string {
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), "kovan-test-"));
  for (const ad of ["ajanlar", "akislar"]) fs.cpSync(path.join(KOK, ad), path.join(kok, ad), { recursive: true });
  for (const ad of ["package.json", "kovan.yaml"]) fs.copyFileSync(path.join(KOK, ad), path.join(kok, ad));
  for (const [ad, icerik] of Object.entries(ekAkislar)) fs.writeFileSync(path.join(kok, "akislar", `${ad}.yaml`), icerik);
  return kok;
}

/**
 * Motor adı ve yerel/Claude kimliği verilebilen sarmalayıcı. İçeride deneme motorunun davranışını kullanır;
 * hata vermesi istenen aşamalarda kalıcı hata döner. Aynı anda kaç çağrı olduğunu sayar.
 */
export class SahteMotor implements Motor {
  readonly tur: "claude" | "ollama" | "deneme";
  hazir = true;
  hata: string | null = null;
  surum = "sahte";
  cagrilar: AjanCagrisi[] = [];
  anlik = 0;
  enFazlaAnlik = 0;
  hataVerecekAsamalar = new Set<string>();
  izinRetleri = new Map<string, string[]>();   // aşama -> sistemin reddettiği araç çağrıları

  constructor(readonly ad: string, readonly yerel = false, private ic: Motor = new DenemeMotoru(0)) {
    this.tur = ad === "deneme" ? "deneme" : yerel ? "ollama" : "claude";
  }

  async saglik(): Promise<boolean> { return this.hazir; }
  modelSec(kart: AjanKarti): string { return this.yerel ? "qwen-sahte" : kart.model; }
  async durumOzeti(): Promise<MotorDurumu> {
    return { hazir: this.hazir, surum: this.surum, hata: this.hata, yol: null, tur: this.tur, yerel: this.yerel, model: this.yerel ? "qwen-sahte" : null };
  }

  async calistir(c: AjanCagrisi): Promise<AjanSonucu> {
    this.cagrilar.push(c);
    this.anlik++;
    this.enFazlaAnlik = Math.max(this.enFazlaAnlik, this.anlik);
    try {
      if (this.hataVerecekAsamalar.has(c.asama_id)) return sonuc({ hata: "Ollama'ya bağlanılamadı (sahte)", kalici_hata: true });
      const r = await this.ic.calistir(c);
      if (c.gorev_turu === "uret" && this.izinRetleri.has(c.asama_id)) r.izin_retleri = this.izinRetleri.get(c.asama_id)!;
      return r;
    } finally {
      this.anlik--;
    }
  }
}

/** Betikli motor: betik bir sonuç döndürürse onu kullanır, null dönerse deneme motorunun davranışına bırakır. */
export class BetikMotor extends SahteMotor {
  constructor(ad: string, private betik: (c: AjanCagrisi) => Partial<AjanSonucu> | null, yerel = false) {
    super(ad, yerel);
  }

  override async calistir(c: AjanCagrisi): Promise<AjanSonucu> {
    const r = this.betik(c);
    if (!r) return super.calistir(c);
    this.cagrilar.push(c);
    return sonuc({ ok: true, ...r });
  }
}

/** Kısa bir oy cevabı: her soru için seçenek numarası. */
export const oyCevabi = (...secimler: (number | "insan")[]) => ({
  yapisal: { oylar: secimler.map((s, i) => ({ soru: i + 1, secim: s === "insan" ? [] : [s], insana_birak: s === "insan", gerekce: "betik" })) },
  metin: "",
});

/** Üretici ajanın kovan-soru bloğu. */
export const soruBlogu = (sorular: object[]) => ({ metin: "```kovan-soru\n" + JSON.stringify({ sorular }) + "\n```" });

export const KISA_BRIF = `ad: Kısa brif
aciklama: Test için brif ve kabul.
fikir_butcesi_usd: 5
asamalar:
  - id: brif
    ad: Brif
    ajan: urun-sahibi
    gorev: Brif yaz.
    girdiler: [fikir]
    cikti: brif
  - id: kabul
    ad: Kabul
    tur: insan
    soru: Tamam mı?
`;

export interface TestKovani extends Kovan {
  kok: string;
}

/**
 * motorlar: null verilirse motorlar ayarlardan kurulur (gerçek Claude, Ollama ya da OpenAI uyumlu motorlar).
 * dis_ayar: geliştiricinin kabuğundaki KOVAN_AYAR testlere sızmasın diye varsayılan null.
 */
export async function kovanOlustur(secenek: { kok?: string; ayar?: Partial<Ayarlar>; motorlar?: Map<string, Motor> | null; gecikme?: number; dis_ayar?: string | null } = {}): Promise<TestKovani> {
  const kok = secenek.kok ?? geciciKok();
  const motorlar = secenek.motorlar === null ? undefined : secenek.motorlar ?? new Map<string, Motor>([
    ["deneme", new DenemeMotoru(secenek.gecikme ?? 0)],
    ["claude", new SahteMotor("claude")],
    ["qwen-yerel", new SahteMotor("qwen-yerel", true)],
  ]);
  const k = await kovanKur(kok, {
    ayar: { calisma_dizini: path.join(kok, "calisma"), port: 8765, ...secenek.ayar },
    motorlar,
    arayuz: path.join(kok, "arayuz-yok"),
    dis_ayar: secenek.dis_ayar ?? null,
  });
  return { ...k, kok };
}

/** Fikir koşulu sağlayana kadar bekler; sağlanmazsa son durumu anlatan bir hata fırlatır. */
export async function bekle(k: Kovan, fid: string, kosul: (f: Fikir) => boolean, ms = 30_000): Promise<Fikir> {
  const t0 = Date.now();
  for (;;) {
    const f = k.depo.fikir(fid);
    if (f && kosul(f)) return structuredClone(f);
    if (Date.now() - t0 > ms) {
      throw new Error(`Bekleme zaman aşımı: ${fid} durum=${f?.durum} aşama=${f?.asama_idx} bekleme=${f?.bekleme?.sebep}/${f?.bekleme?.mesaj}`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

export const bekliyor = (sebep?: string) => (f: Fikir) => f.durum === "bekliyor" && (!sebep || f.bekleme?.sebep === sebep);

/** Bir adımın günlüğündeki istem (ajana giden metin). */
export function istemi(k: Kovan, fid: string, adimId: number): string {
  return JSON.parse(fs.readFileSync(path.join(k.calisma, fid, "gunluk", `adim-${adimId}.json`), "utf8")).istem;
}

export function dosya(k: Kovan, fid: string, rel: string): string {
  return fs.readFileSync(path.join(k.calisma, fid, rel), "utf8");
}

export function varMi(k: Kovan, fid: string, rel: string): boolean {
  return fs.existsSync(path.join(k.calisma, fid, rel));
}

export const ORNEK_MINI = "Flora AI analiz kredisi: ücretsiz kullanıcıya haftada 3 bitki fotoğrafı analizi hakkı, premium kullanıcıda sınırsız.";
export const ORNEK_PANEL = "Flora AI bakım paneli (web): bitki ekle, bugün sulanacaklar listesi, 'Suladım' ile işaretle.";
