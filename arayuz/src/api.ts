// Kovan sunucusunun JSON API'si. Tipler sunucuyla ortak (sunucu/src/tipler.ts).
import type {
  AjanOzeti, AkisOzeti, Cevap, DosyaIcerigi, DurumYaniti, FikirDetayi, FikirOzeti, Mod,
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
  akislar: () => istek<AkisOzeti[]>("/api/akislar"),
  fikirler: () => istek<FikirOzeti[]>("/api/fikirler"),
  fikir: (id: string) => istek<FikirDetayi>(yolu(id)),
  dosya: (id: string, yol: string) => istek<DosyaIcerigi>(`${yolu(id)}/dosya?yol=${encodeURIComponent(yol)}`),
  yeniFikir: (g: { baslik: string; metin: string; profil: string; motor: Mod }) => istek<{ id: string }>("/api/fikirler", g),
  karar: (id: string, secim: string, not: string, hedef?: string | null) => istek<{ ok: true }>(`${yolu(id)}/karar`, { secim, not, hedef }),
  cevap: (id: string, cevaplar: Cevap[]) => istek<{ ok: true }>(`${yolu(id)}/cevap`, { cevaplar }),
  durdur: (id: string) => istek<{ ok: true }>(`${yolu(id)}/durdur`, {}),
  devam: (id: string) => istek<{ ok: true }>(`${yolu(id)}/devam`, {}),
};

export const onizlemeAdresi = (id: string, yol: string) =>
  `/onizle/${encodeURIComponent(id)}/${yol.split("/").map(encodeURIComponent).join("/")}`;
