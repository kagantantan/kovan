// İşletim sisteminin anahtar kasası: Mac'te Anahtar Zinciri (security), Linux'ta Secret Service (secret-tool).
// Ayarlar ekranında "kalıcı" seçilen API anahtarı burada durur; diske düz metin yazılmaz.
// Anahtar hiçbir zaman komut satırı argümanı olmaz (ps'te görünmesin): stdin'den verilir.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface Kasa {
  /** Arayüzde gösterilen ad, ör. "macOS Anahtar Zinciri". */
  readonly ad: string;
  oku(hesap: string): string | null;
  yaz(hesap: string, deger: string): void;
  sil(hesap: string): void;
}

const HIZMET = "kovan";
const HESAP_KALIBI = /^[A-Za-z0-9._-]{1,64}$/;

function hesapDenetle(hesap: string): void {
  if (!HESAP_KALIBI.test(hesap)) throw new Error(`Geçersiz motor adı: ${hesap}`);
}

function komutVar(ad: string): string | null {
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    const tam = path.join(d, ad);
    try { fs.accessSync(tam, fs.constants.X_OK); return tam; } catch { /* sıradaki */ }
  }
  return null;
}

function calistir(komut: string, argumanlar: string[], girdi?: string) {
  return spawnSync(komut, argumanlar, { input: girdi, encoding: "utf8", timeout: 10_000 });
}

class MacKasasi implements Kasa {
  readonly ad = "macOS Anahtar Zinciri";
  constructor(private readonly komut: string) {}

  oku(hesap: string): string | null {
    hesapDenetle(hesap);
    const s = calistir(this.komut, ["find-generic-password", "-s", HIZMET, "-a", hesap, "-w"]);
    return s.status === 0 ? s.stdout.replace(/\r?\n$/, "") || null : null;   // 44: kayıt yok
  }

  yaz(hesap: string, deger: string): void {
    hesapDenetle(hesap);
    // Etkileşimli kip komutu stdin'den okur; tırnak içindeki değer argv'ye düşmez.
    if (/["\\]/.test(deger)) throw new Error("Bu anahtar macOS Anahtar Zinciri'ne yazılamıyor (tırnak ya da ters bölü içeriyor). Kalıcı kaydetmeden kullan.");
    const s = calistir(this.komut, ["-i"], `add-generic-password -U -s ${HIZMET} -a "${hesap}" -l "Kovan: ${hesap}" -w "${deger}"\n`);
    if (s.status !== 0 || this.oku(hesap) !== deger) throw new Error(`macOS Anahtar Zinciri'ne yazılamadı${s.stderr ? `: ${s.stderr.trim().slice(0, 200)}` : ""}`);
  }

  sil(hesap: string): void {
    hesapDenetle(hesap);
    calistir(this.komut, ["delete-generic-password", "-s", HIZMET, "-a", hesap]);
  }
}

class SecretServiceKasasi implements Kasa {
  readonly ad = "Secret Service (secret-tool)";
  constructor(private readonly komut: string) {}

  oku(hesap: string): string | null {
    hesapDenetle(hesap);
    const s = calistir(this.komut, ["lookup", "hizmet", HIZMET, "hesap", hesap]);
    return s.status === 0 ? s.stdout.replace(/\r?\n$/, "") || null : null;
  }

  yaz(hesap: string, deger: string): void {
    hesapDenetle(hesap);
    const s = calistir(this.komut, ["store", `--label=Kovan: ${hesap}`, "hizmet", HIZMET, "hesap", hesap], deger);
    if (s.status !== 0 || this.oku(hesap) !== deger) throw new Error(`Secret Service'e yazılamadı${s.stderr ? `: ${s.stderr.trim().slice(0, 200)}` : ""}`);
  }

  sil(hesap: string): void {
    hesapDenetle(hesap);
    calistir(this.komut, ["clear", "hizmet", HIZMET, "hesap", hesap]);
  }
}

/** Bu makinenin kasası; yoksa null (ör. Windows ya da secret-tool kurulu olmayan Linux). */
export function sistemKasasi(): Kasa | null {
  if (process.env.KOVAN_KASA === "kapali") return null;
  if (process.platform === "darwin") {
    const k = komutVar("security") ?? (fs.existsSync("/usr/bin/security") ? "/usr/bin/security" : null);
    return k ? new MacKasasi(k) : null;
  }
  if (process.platform === "linux") {
    const k = komutVar("secret-tool");
    return k ? new SecretServiceKasasi(k) : null;
  }
  return null;
}

/** Testler için: bellekte duran sahte kasa. */
export class BellekKasasi implements Kasa {
  readonly ad = "test kasası";
  readonly kayitlar = new Map<string, string>();
  oku(hesap: string) { return this.kayitlar.get(hesap) ?? null; }
  yaz(hesap: string, deger: string) { hesapDenetle(hesap); this.kayitlar.set(hesap, deger); }
  sil(hesap: string) { this.kayitlar.delete(hesap); }
}
