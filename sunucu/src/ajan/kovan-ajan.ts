// Kovan ajanı: tek bir ajan çağrısını ayrı bir süreçte çalıştırır (claude -p gibi).
// stdin: { baglanti, istek } JSON   ·   API anahtarı: KOVAN_LLM_ANAHTAR ortam değişkeni
// stdout: DonguSonucu JSON
// Ayrı süreç: Kovan "Durdur" deyince süreç grubu (Bash'in açtığı komutlar dahil) birlikte kapanır.
import { ajanDongusu, type BaglantiAyari, type DonguIstegi } from "./dongu.js";

async function stdinOku(): Promise<string> {
  const parcalar: Buffer[] = [];
  for await (const p of process.stdin) parcalar.push(p as Buffer);
  return Buffer.concat(parcalar).toString("utf8");
}

const iptal = new AbortController();
for (const sinyal of ["SIGTERM", "SIGINT"] as const) process.on(sinyal, () => { iptal.abort(); setTimeout(() => process.exit(143), 1000).unref(); });

try {
  const { baglanti, istek } = JSON.parse(await stdinOku()) as { baglanti: Omit<BaglantiAyari, "anahtar">; istek: DonguIstegi };
  const anahtar = process.env.KOVAN_LLM_ANAHTAR || null;
  // Bash komutlarının ortamında anahtar olmasın
  const ortam = { ...process.env };
  delete ortam.KOVAN_LLM_ANAHTAR;
  const sonuc = await ajanDongusu({ ...baglanti, anahtar }, istek, { sinyal: iptal.signal, ortam });
  process.stdout.write(JSON.stringify(sonuc));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, metin: "", hata: `Kovan ajanı çalışmadı: ${(e as Error).message}`, kalici_hata: true }));
}
