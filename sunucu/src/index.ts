// npm start  -> Kovan sunucusu (http://127.0.0.1:8765)
//   --port 9000   portu değiştir      --deneme   yeni fikirlerde varsayılan mod: deneme
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { kovanKur } from "./sunucu.js";

const { values } = parseArgs({ options: { port: { type: "string" }, deneme: { type: "boolean" } }, strict: false });
if (values.port) process.env.KOVAN_PORT = String(values.port);
if (values.deneme) process.env.KOVAN_MOTOR = "deneme";

const kok = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let kovan;
try {
  kovan = await kovanKur(kok);
} catch (e) {
  console.error(`\nKovan başlatılamadı: ${(e as Error).message}\n`);
  process.exit(1);
}
const { app, cfg, motorlar, ork, surum } = kovan;

try {
  await app.listen({ host: "127.0.0.1", port: cfg.port });
} catch (e) {
  const kod = (e as NodeJS.ErrnoException).code;
  console.error(kod === "EADDRINUSE"
    ? `\nPort ${cfg.port} kullanımda. Kovan zaten açık olabilir; değilse kovan.yaml'da port'u değiştir.\n`
    : `\nSunucu açılamadı: ${(e as Error).message}\n`);
  process.exit(1);
}

console.log("");
console.log(`  Kovan ${surum} çalışıyor  ->  http://127.0.0.1:${cfg.port}`);
for (const [ad, m] of motorlar) {
  if (ad === "deneme") continue;
  const d = await m.durumOzeti();
  const etiket = m.yerel ? `${ad} (${d.model})` : ad;
  console.log(d.hazir ? `  ${etiket}: hazır  ${m.yerel ? `Ollama ${d.ollama_surum ?? ""}` : m.surum}` : `  ${etiket}: HAZIR DEĞİL -> ${d.hata}`);
}
console.log("  (Deneme modu her durumda çalışır.)");
console.log("  Durdurmak için bu pencerede Ctrl+C");
console.log("");

let kapaniyor = false;
const kapat = async () => {
  if (kapaniyor) return;
  kapaniyor = true;
  console.log("\n  Kovan kapanıyor; çalışan ajanlar durduruluyor...");
  await ork.kapat();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", kapat);
process.on("SIGTERM", kapat);
