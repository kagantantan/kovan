// OpenAI uyumlu motor: kurum içi LLM (vLLM, TGI, ağ geçidi), LM Studio ya da Ollama'nın /v1 adresi.
// Ajanlar Kovan'ın kendi döngüsüyle (sunucu/src/ajan) ayrı süreçte çalışır; Claude Code gerekmez.
// API anahtarı ayar dosyasına yazılmaz: ortam değişkeninin adı ya da anahtarı içeren dosyanın yolu verilir.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HttpHatasi, baglantiHatasi, jsonIstek, type AracBicimi, type BaglantiAyari, type DonguSonucu } from "./ajan/dongu.js";
import type { AjanKarti } from "./kartlar.js";
import { sonuc, sureciOldur, yedekJsonTalimati, type AjanCagrisi, type AjanSonucu, type Motor } from "./motor.js";
import type { MotorDurumu } from "./tipler.js";

export interface UyumluMotorAyari {
  tur: "openai";
  adres: string;                      // ör. https://llm.kurum.local/v1
  model: string;
  anahtar_degiskeni?: string | null;  // anahtarı tutan ortam değişkeninin ADI
  anahtar_dosyasi?: string | null;    // ya da anahtarı içeren dosya
  anahtar_basligi?: string;           // varsayılan Authorization ("Bearer <anahtar>")
  ek_basliklar?: Record<string, string>;
  ca_dosyasi?: string | null;         // kurumun kök sertifikası (PEM)
  arac_bicimi?: AracBicimi;
  sicaklik?: number | null;
  en_fazla_token?: number | null;
  baglam_token?: number;
  en_fazla_tur?: number;
  yerel?: boolean;                    // true (varsayılan): veri kurumun dışına çıkmaz, Hepsi yerel'de kullanılabilir
}

const AJAN_BETIGI = fileURLToPath(new URL("./ajan/kovan-ajan.ts", import.meta.url));
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const evYolu = (y: string) => y.replace(/^~(?=$|\/)/, os.homedir());

export class UyumluMotor implements Motor {
  readonly tur = "openai" as const;
  readonly yerel: boolean;
  hazir = false;
  hata: string | null = null;
  surum = "OpenAI uyumlu";
  modeller: string[] = [];
  private sonKontrol = 0;

  constructor(readonly ad: string, readonly ayar: UyumluMotorAyari) {
    this.yerel = ayar.yerel !== false;
  }

  /** Anahtar her çağrıda yeniden okunur: dosyadaki anahtar değişirse Kovan'ı yeniden başlatmak gerekmez. */
  anahtar(): { deger: string | null; hata: string | null } {
    const { anahtar_dosyasi: dosya, anahtar_degiskeni: degisken } = this.ayar;
    if (dosya) {
      const p = evYolu(dosya);
      if (!fs.existsSync(p)) return { deger: null, hata: `API anahtarı dosyası yok: ${p}` };
      const d = fs.readFileSync(p, "utf8").trim();
      return d ? { deger: d, hata: null } : { deger: null, hata: `API anahtarı dosyası boş: ${p}` };
    }
    if (degisken) {
      const d = process.env[degisken]?.trim();
      return d ? { deger: d, hata: null } : { deger: null, hata: `API anahtarı yok: ${degisken} ortam değişkeni boş. Kovan'ı başlatmadan önce ayarla.` };
    }
    return { deger: null, hata: null };
  }

  private baglanti(anahtar: string | null, model = this.ayar.model): BaglantiAyari {
    const a = this.ayar;
    return {
      adres: a.adres.replace(/\/+$/, ""), model, anahtar,
      anahtar_basligi: a.anahtar_basligi || "Authorization", ek_basliklar: a.ek_basliklar ?? {},
      ca: a.ca_dosyasi ? fs.readFileSync(evYolu(a.ca_dosyasi), "utf8") : null,
      arac_bicimi: a.arac_bicimi ?? "otomatik", sicaklik: a.sicaklik ?? null, en_fazla_token: a.en_fazla_token ?? null,
      baglam_token: a.baglam_token ?? 32_768, en_fazla_tur: a.en_fazla_tur ?? 100,
    };
  }

  async saglik(zorla = false): Promise<boolean> {
    if (!zorla && Date.now() - this.sonKontrol < 10_000) return this.hazir;
    this.sonKontrol = Date.now();
    this.hazir = false;
    this.hata = null;
    const a = this.anahtar();
    if (a.hata) { this.hata = a.hata; return false; }
    let b: BaglantiAyari;
    try { b = this.baglanti(a.deger); } catch (e) { this.hata = `ca_dosyasi okunamadı: ${(e as Error).message}`; return false; }
    try {
      const v = await jsonIstek(b, "/models", undefined, { sure_ms: 5000 });
      this.modeller = (Array.isArray(v?.data) ? v.data : []).map((m: { id?: string }) => String(m?.id ?? "")).filter(Boolean);
      if (this.modeller.length && !this.modeller.includes(this.ayar.model)) {
        this.hata = `Model sunucuda yok: ${this.ayar.model}. Sunucudaki modeller: ${this.modeller.slice(0, 8).join(", ")}`;
        return false;
      }
    } catch (e) {
      // /models'i sunmayan ağ geçitleri var: erişim sorunu değilse hazır say
      if (!(e instanceof HttpHatasi && [404, 405].includes(e.durum))) { this.hata = baglantiHatasi(e, b.adres).mesaj; return false; }
    }
    this.hazir = true;
    return true;
  }

  modelSec(kart: AjanKarti): string {
    return kart.yerel_model ?? this.ayar.model;
  }

  async durumOzeti(): Promise<MotorDurumu> {
    return { hazir: await this.saglik(), surum: this.surum, hata: this.hata, yol: null, tur: this.tur, yerel: this.yerel, model: this.ayar.model, adres: this.ayar.adres };
  }

  async calistir(c: AjanCagrisi): Promise<AjanSonucu> {
    if (!(await this.saglik())) return sonuc({ hata: this.hata ?? `${this.ad} hazır değil`, kalici_hata: true });
    const a = this.anahtar();
    const { anahtar: _gizli, ...baglanti } = this.baglanti(null, c.model);
    const girdi = JSON.stringify({
      baglanti,
      istek: {
        sistem: c.sistem, sistem_modu: c.sistem_modu, istem: c.sema ? c.istem + yedekJsonTalimati(c) : c.istem,
        araclar: c.araclar, izinli: c.izinli, cwd: c.cwd, sure_sn: c.sure_sn,
      },
    });
    // Anahtar yalnızca alt sürecin ortamında; stdin'de, günlükte ve Bash'in ortamında yok
    const env: NodeJS.ProcessEnv = { ...process.env, KOVAN_LLM_ANAHTAR: a.deger ?? "" };
    if (this.ayar.anahtar_degiskeni) delete env[this.ayar.anahtar_degiskeni];
    const t0 = Date.now();
    return new Promise<AjanSonucu>((coz) => {
      const p = spawn(process.execPath, ["--import", TSX, AJAN_BETIGI], { cwd: c.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      let cikti = "";
      let hata = "";
      let bitti = false;
      let zamanAsimi = false;
      const sure = () => (Date.now() - t0) / 1000;
      // Alt süreç süreyi kendisi uygular; bu yalnızca takılırsa diye
      const saat = setTimeout(() => { zamanAsimi = true; sureciOldur(p); }, (c.sure_sn + 30) * 1000);
      const kapat = () => { clearTimeout(saat); c.surecCb?.(p, true); };
      p.stdout!.setEncoding("utf8").on("data", (d) => { cikti += d; });
      p.stderr!.setEncoding("utf8").on("data", (d) => { hata += d; });
      p.on("error", (e) => {
        if (bitti) return;
        bitti = true; kapat();
        coz(sonuc({ hata: `Kovan ajanı başlatılamadı: ${e.message}`, sure_sn: sure() }));
      });
      p.on("close", (kod) => {
        if (bitti) return;
        bitti = true; kapat();
        let v: Partial<DonguSonucu> | null = null;
        try { v = JSON.parse(cikti); } catch { /* aşağıda */ }
        if (!v) {
          coz(sonuc({
            sure_sn: sure(), zaman_asimi: zamanAsimi, ham: (cikti || hata).slice(-4000),
            hata: zamanAsimi ? `Süre sınırı aşıldı (${c.sure_sn} sn); süreç durduruldu` : kod === null ? "Süreç durduruldu" : `Kovan ajanı yanıt vermedi (çıkış kodu ${kod}): ${hata.slice(-400) || "boş çıktı"}`,
          }));
          return;
        }
        coz(sonuc({
          ok: Boolean(v.ok), metin: v.metin ?? "", hata: v.hata ?? null, kalici_hata: Boolean(v.kalici_hata), zaman_asimi: Boolean(v.zaman_asimi),
          girdi_token: v.girdi_token ?? 0, cikti_token: v.cikti_token ?? 0, tur_sayisi: v.tur_sayisi ?? 0, izin_retleri: v.izin_retleri ?? [],
          sure_sn: sure(), maliyet: 0, ham: cikti.slice(-4000),
        }));
      });
      c.surecCb?.(p, false);
      p.stdin!.on("error", () => { /* süreç erken kapanırsa EPIPE */ });
      p.stdin!.end(girdi);
    });
  }
}
