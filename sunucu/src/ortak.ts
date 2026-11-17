// Küçük yardımcılar: zaman damgası, kısaltma, dosya işlemleri.
import fs from "node:fs";
import path from "node:path";

export function simdi(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function kisalt(metin: string | null | undefined, n: number): string {
  const s = (metin ?? "").trim();
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function kuyruk(metin: string | null | undefined, n: number): string {
  const s = metin ?? "";
  return s.length <= n ? s : "…\n" + s.slice(s.length - n);
}

export const bekle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Önce geçici dosyaya yazar, sonra yeniden adlandırır: yarım yazılmış dosya kalmaz. */
export function atomikYaz(dosya: string, icerik: string): void {
  fs.mkdirSync(path.dirname(dosya), { recursive: true });
  const gecici = `${dosya}.${process.pid}.tmp`;
  fs.writeFileSync(gecici, icerik, "utf8");
  fs.renameSync(gecici, dosya);
}

export function jsonOku<T>(dosya: string, varsayilan: T): T {
  try {
    return JSON.parse(fs.readFileSync(dosya, "utf8")) as T;
  } catch {
    return varsayilan;
  }
}

/** "a/b" yolu "a" yolunun altında mı (ya da kendisi mi)? */
export function altinda(rel: string, yol: string): boolean {
  const y = yol.replace(/\/+$/, "");
  return rel === y || rel.startsWith(y + "/");
}

/** Kullanıcıya gösterilecek, beklenen hata (geçersiz istek, bulunamadı...). kod: HTTP durum kodu. */
export class KovanHatasi extends Error {
  constructor(mesaj: string, readonly kod = 400) {
    super(mesaj);
    this.name = "KovanHatasi";
  }
}
