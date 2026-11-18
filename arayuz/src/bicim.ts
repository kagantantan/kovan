// Biçimlendirme ve durum sözlüğü: arayüzün dili tek yerde.
import type { Adim, BeklemeSebebi, FikirDurumu, Mod } from "./api";

export function para(usd: number | null | undefined): string {
  const v = usd ?? 0;
  if (v === 0) return "$0";
  return v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

export function sure(sn: number | null | undefined): string {
  const s = Math.round(sn ?? 0);
  if (s < 60) return `${s} sn`;
  const dk = Math.floor(s / 60);
  if (dk < 60) return s % 60 ? `${dk} dk ${s % 60} sn` : `${dk} dk`;
  return `${Math.floor(dk / 60)} sa ${dk % 60} dk`;
}

const AYLAR = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

/** "2026-11-17 22:57:46" -> bugünse "22:57", değilse "17 Kas 22:57" */
export function zaman(s: string | null | undefined): string {
  if (!s) return "";
  const [tarih, saat = ""] = s.split(" ");
  const [y, a, g] = tarih.split("-").map(Number);
  const simdi = new Date();
  const hhmm = saat.slice(0, 5);
  if (y === simdi.getFullYear() && a === simdi.getMonth() + 1 && g === simdi.getDate()) return hhmm;
  return `${g} ${AYLAR[a - 1] ?? ""} ${hhmm}`;
}

export function boyut(bayt: number): string {
  if (bayt < 1024) return `${bayt} B`;
  if (bayt < 1024 * 1024) return `${(bayt / 1024).toFixed(1)} KB`;
  return `${(bayt / 1024 / 1024).toFixed(1)} MB`;
}

export const FIKIR_DURUMU: Record<FikirDurumu, string> = {
  sirada: "Sırada",
  calisiyor: "Çalışıyor",
  bekliyor: "Kararını bekliyor",
  tamamlandi: "Tamamlandı",
  durduruldu: "Durduruldu",
};

export const MOD_ADI: Record<Mod, string> = { hibrit: "Hibrit", claude: "Hepsi Claude", yerel: "Hepsi yerel", deneme: "Deneme" };

export const MOD_ACIKLAMA: Record<Mod, string> = {
  hibrit: "Kodu yerel model yazar; analiz, tasarım ve onaylar Claude'da.",
  claude: "Bütün ajanlar Claude'da. Yerel motor hazır değilse ya da kıyas için.",
  yerel: "Bütün ajanlar yerel motorda; hiçbir çağrı Claude'a gitmez. Kurum içi kod için. Daha yavaş, daha fazla düzeltme turu.",
  deneme: "Gerçek ajan çalışmaz, token harcanmaz. Akışı ve soruları görmek için.",
};

export const BEKLEME_BASLIGI: Record<BeklemeSebebi, string> = {
  insan: "Teslim senin onayında",
  tur_siniri: "Onay kurulu ikna olmadı",
  hata: "Bir adım tamamlanamadı",
  butce: "Fikrin bütçesi doldu",
  kesildi: "Yarım kalan bir iş var",
  ajan_sorusu: "Ajan soruyor",
};

export const BEKLEME_ETIKETI: Record<BeklemeSebebi, string> = {
  insan: "Teslim",
  tur_siniri: "Tur sınırı",
  hata: "Hata",
  butce: "Bütçe",
  kesildi: "Kesinti",
  ajan_sorusu: "Soru",
};

export type Ton = "iyi" | "kotu" | "dikkat" | "calisan" | "sessiz";

/** Adım durumunun okunur adı ve tonu. */
export function adimDurumu(a: Adim): { ad: string; ton: Ton } {
  const d = a.durum;
  switch (d) {
    case "calisiyor": return { ad: "çalışıyor", ton: "calisan" };
    case "tamam": return { ad: a.tip === "uret" ? "yazdı" : "tamam", ton: "iyi" };
    case "onay": return { ad: "onayladı", ton: "iyi" };
    case "duzelt": return { ad: "düzeltme istedi", ton: "kotu" };
    case "soru": return { ad: "soru sordu", ton: "dikkat" };
    case "yesil": return { ad: "yeşil", ton: "iyi" };
    case "kirmizi": return { ad: "kırmızı", ton: "kotu" };
    case "takildi": return { ad: "süre doldu", ton: "kotu" };
    case "hata": return { ad: "hata", ton: "kotu" };
    case "ihlal": return { ad: "sınır ihlali", ton: "kotu" };
    case "uyari": return { ad: "uyarı", ton: "dikkat" };
    case "kilit": return { ad: "kilitlendi", ton: "sessiz" };
    case "bekliyor": return { ad: "seni bekliyor", ton: "dikkat" };
    case "karar": return { ad: "karar verildi", ton: "sessiz" };
    case "atlandi": return { ad: "atlandı", ton: "sessiz" };
    case "durduruldu": return { ad: "durduruldu", ton: "sessiz" };
    case "kesildi": return { ad: "yarıda kaldı", ton: "kotu" };
    case "yeniden": return { ad: "yeniden doğrulama", ton: "sessiz" };
    case "oy": return { ad: "oy verdi", ton: "sessiz" };
    case "insana": return { ad: "sana bıraktı", ton: "dikkat" };
    case "ekip": return { ad: "ekip karar verdi", ton: "iyi" };
    case "kapsam": return { ad: "kapsam dışı", ton: "sessiz" };
    default: return { ad: d, ton: "sessiz" };
  }
}

/** "claude" / "qwen-yerel" / "deneme" / "sistem" -> kısa, okunur motor adı */
export function motorAdi(motor: string | null | undefined, yerel: boolean): string {
  if (!motor || motor === "sistem") return "";
  if (motor === "claude") return "Claude";
  if (motor === "deneme") return "deneme";
  return yerel ? "yerel" : motor;
}

/** Seçenek etiketinin sonundaki "(Önerilen)" işaretini ayırır. */
export function onerilenAyir(etiket: string): { metin: string; onerilen: boolean } {
  const m = /\s*\((önerilen|onerilen|recommended)\)\s*$/i.exec(etiket);
  return m ? { metin: etiket.slice(0, m.index).trim(), onerilen: true } : { metin: etiket, onerilen: false };
}
