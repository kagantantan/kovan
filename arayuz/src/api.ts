// Kovan sunucusunun JSON API'si. Tipler sunucuyla ortak (sunucu/src/tipler.ts).
import type {
  AjanOzeti, AkisOzeti, BaglantiSonucu, Cevap, DosyaIcerigi, DurumYaniti, FikirDetayi, FikirOzeti, Katilim, Mod,
} from "../../sunucu/src/tipler";

export type * from "../../sunucu/src/tipler";

export class ApiHatasi extends Error {
  constructor(mesaj: string, readonly durum: number) {
    super(mesaj);
  }
}

async function istek<T>(yol: string, govde?: unknown): Promise<T> {
  let yanit: Response;
  try {
    yanit = await fetch(yol, govde === undefined ? undefined : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(govde),
    });
  } catch {
    throw new ApiHatasi("Kovan sunucusuna ulaşılamıyor. Baslat.command penceresi açık mı?", 0);
  }
  const metin = await yanit.text();
  let veri: unknown = null;
  try { veri = metin ? JSON.parse(metin) : null; } catch { /* JSON değil */ }
  if (!yanit.ok) {
    const detay = (veri as { detail?: string } | null)?.detail;
    throw new ApiHatasi(detay ?? `İstek başarısız (${yanit.status})`, yanit.status);
  }
  return veri as T;
}

const yolu = (id: string) => `/api/fikirler/${encodeURIComponent(id)}`;

export const api = {
  durum: () => istek<DurumYaniti>("/api/durum"),
  ajanlar: () => istek<AjanOzeti[]>("/api/ajanlar"),
  ajanSecimi: (id: string, motor: string, model: string) => istek<{ ok: true }>(`/api/ajanlar/${encodeURIComponent(id)}/secim`, { motor, model }),
  ajanSecimiSil: (id: string) => istek<{ ok: true }>(`/api/ajanlar/${encodeURIComponent(id)}/secim-sil`, {}),
  incelemeModeli: (model: string) => istek<{ ok: true; model: string | null }>("/api/inceleme-modeli", { model }),
  modeller: () => istek<Record<string, string[]>>("/api/motorlar/modeller"),
  akislar: () => istek<AkisOzeti[]>("/api/akislar"),
  fikirler: () => istek<FikirOzeti[]>("/api/fikirler"),
  fikir: (id: string) => istek<FikirDetayi>(yolu(id)),
  dosya: (id: string, yol: string) => istek<DosyaIcerigi>(`${yolu(id)}/dosya?yol=${encodeURIComponent(yol)}`),
  yeniFikir: (g: { baslik: string; metin: string; profil: string; motor: Mod; kaynaklar?: string[]; hedef_yigin?: string; proje?: string; katilim?: Katilim }) =>
    istek<{ id: string }>("/api/fikirler", g),
  karar: (id: string, secim: string, not: string, hedef?: string | null) => istek<{ ok: true }>(`${yolu(id)}/karar`, { secim, not, hedef }),
  cevap: (id: string, cevaplar: Cevap[]) => istek<{ ok: true }>(`${yolu(id)}/cevap`, { cevaplar }),
  durdur: (id: string) => istek<{ ok: true }>(`${yolu(id)}/durdur`, {}),
  devam: (id: string) => istek<{ ok: true }>(`${yolu(id)}/devam`, {}),
  modDegistir: (id: string, mod: Mod) => istek<{ ok: true }>(`${yolu(id)}/mod`, { mod }),
  katilimDegistir: (id: string, katilim: Katilim) => istek<{ ok: true }>(`${yolu(id)}/katilim`, { katilim }),
  sor: (id: string, hedef: string, asama: string | null, soru: string) => istek<{ id: number }>(`${yolu(id)}/sor`, { hedef, asama, soru }),
  sohbetKarari: (id: string, mesaj: number, metin: string) => istek<{ ok: true }>(`${yolu(id)}/sohbet/${mesaj}/karar`, { metin }),
  yolSec: (tur: "klasor" | "dosya") => istek<{ yollar: string[] }>("/api/yol-sec", { tur }),
  sil: (id: string) => istek<{ ok: true; cop: string }>(`${yolu(id)}/sil`, {}),
  klasorAc: (id: string, alt: "" | "kod" | "belgeler" | "cikti" = "") => istek<{ ok: true; yol: string }>(`${yolu(id)}/klasor-ac`, { alt }),
  yeniSurum: (id: string, metin: string) => istek<{ id: string }>(`${yolu(id)}/surum`, { metin }),
  anahtarAyarla: (motor: string, anahtar: string, kalici: boolean) =>
    istek<BaglantiSonucu>(`/api/motorlar/${encodeURIComponent(motor)}/anahtar`, { anahtar, kalici }),
  anahtarSil: (motor: string) => istek<BaglantiSonucu>(`/api/motorlar/${encodeURIComponent(motor)}/anahtar-sil`, {}),
  baglantiDene: (motor: string) => istek<BaglantiSonucu>(`/api/motorlar/${encodeURIComponent(motor)}/dene`, {}),
};

export const onizlemeAdresi = (id: string, yol: string) =>
  `/onizle/${encodeURIComponent(id)}/${yol.split("/").map(encodeURIComponent).join("/")}`;
