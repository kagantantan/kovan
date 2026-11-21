// Mevcut proje üzerinde iş: verilen proje klasörü fikrin kod/proje/ klasörüne BİREBİR kopyalanır (kodlama çevirisi yok;
// yama aslına uymalı). Dokunulmamış ikinci bir kopya (.kovan/proje-asil) saklanır; iş bitince ikisinin farkı yama
// dosyası olarak çıkar. Verilen klasöre ve sürüm kontrolüne hiç dokunulmaz.
import fs from "node:fs";
import path from "node:path";
import { structuredPatch } from "diff";
import { ATLA_KLASOR, EN_FAZLA_BOYUT, EN_FAZLA_DOSYA, EN_FAZLA_DOSYA_BOYUTU, TURLER, genislet, ikiliMi, satirSay } from "./kaynak.js";
import { KovanHatasi } from "./ortak.js";

export const PROJE_KLASORU = "proje";

/** Kopyalanmayan klasörler: sürüm kontrolü, bağımlılıklar, derleme çıktıları. Kaynak içe almadan farkı: .mvn kalır (./mvnw ona bakar). */
const PROJE_ATLA = new Set([...ATLA_KLASOR].filter((k) => k !== ".mvn"));
/** Yamaya girmeyenler: yukarıdakiler ve testlerin geride bıraktığı rapor ve önbellek klasörleri, günlük dosyaları. */
const YAMA_ATLA = new Set([...PROJE_ATLA, "coverage", "test-results", "playwright-report", ".pytest_cache", ".cache", ".next", ".vite", ".turbo", ".parcel-cache"]);
const YAMA_ATLA_UZANTI = new Set([".log", ".tsbuildinfo", ".pyc", ".pyo"]);

/** Sır taşıyabilecek dosyalar kopyalanmaz: ajanların önüne (ve Claude modlarında makine dışına) çıkmasın. */
const SIR_UZANTILARI = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdb"]);
const ornekMi = (ad: string) => /\.(example|ornek|sample|template|dist)$/i.test(ad);
export function sirDosyasiMi(ad: string): boolean {
  const k = ad.toLowerCase();
  if (SIR_UZANTILARI.has(path.extname(k))) return true;
  return (k === ".env" || k.startsWith(".env.")) && !ornekMi(k);
}

export interface ProjeOzeti {
  yol: string;                 // kullanıcının makinesindeki asıl klasör
  dosya_sayisi: number;
  boyut: number;
  satir: number;
  turler: { tur: string; dosya: number; satir: number }[];
  ust_duzey: string[];         // kökteki klasör ve dosyalar
  utf8_olmayan: string[];      // proje/ köküne göre; ajan değiştirirse yamaya girmez, ayrı dosya olarak çıkar
  atlanan: { yol: string; neden: string }[];
  test_komutu: string | null;  // deterministik öneri; koşacak komutu kullanıcı onaylar
}

function utf8Mi(veri: Buffer): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(veri); return true; } catch { return false; }
}

/** Henüz var olmayan bir yolun gerçek hali: var olan en yakın üst klasör çözülür (macOS'ta /var -> /private/var gibi bağlar için). */
function gercekYol(yol: string): string {
  let ust = path.resolve(yol);
  const kalan: string[] = [];
  while (!fs.existsSync(ust) && path.dirname(ust) !== ust) { kalan.unshift(path.basename(ust)); ust = path.dirname(ust); }
  return path.join(fs.realpathSync(ust), ...kalan);
}

/** Proje klasörünü hedef (çalışma kopyası) ve asil (dokunulmamış kopya) klasörlerine birebir kopyalar. */
export function projeIceAl(hamYol: string, hedef: string, asil: string): ProjeOzeti {
  const yol = genislet(hamYol ?? "");
  if (!hamYol?.trim()) throw new KovanHatasi("Projenin bu makinedeki klasörünü yaz.");
  if (!fs.existsSync(yol)) throw new KovanHatasi(`Proje klasörü bulunamadı: ${yol}`);
  if (!fs.statSync(yol).isDirectory()) throw new KovanHatasi(`Proje yolu bir klasör olmalı: ${yol}`);
  const kaynakGercek = fs.realpathSync(yol);
  const hedefGercek = gercekYol(hedef);
  if (hedefGercek === kaynakGercek || hedefGercek.startsWith(kaynakGercek + path.sep)) {
    throw new KovanHatasi(`Proje klasörü Kovan'ın çalışma klasörünü içeriyor: ${yol}. Yalnızca projenin kendi klasörünü ver.`);
  }
  const ozet: ProjeOzeti = { yol, dosya_sayisi: 0, boyut: 0, satir: 0, turler: [], ust_duzey: [], utf8_olmayan: [], atlanan: [], test_komutu: null };
  const turler = new Map<string, { dosya: number; satir: number }>();

  const kopyala = (kaynak: string, rel: string) => {
    const st = fs.lstatSync(kaynak);
    const ad = path.basename(kaynak);
    if (st.isSymbolicLink()) { ozet.atlanan.push({ yol: rel, neden: "sembolik bağ" }); return; }
    if (st.isDirectory()) {
      if (rel && PROJE_ATLA.has(ad)) { ozet.atlanan.push({ yol: `${rel}/`, neden: "derleme çıktısı, bağımlılık ya da sürüm kontrolü klasörü" }); return; }
      for (const g of fs.readdirSync(kaynak).sort()) kopyala(path.join(kaynak, g), rel ? `${rel}/${g}` : g);
      return;
    }
    if (!st.isFile() || ad === ".DS_Store") return;
    if (sirDosyasiMi(ad)) { ozet.atlanan.push({ yol: rel, neden: "sır taşıyabilir (anahtar, sertifika ya da ortam dosyası)" }); return; }
    if (st.size > EN_FAZLA_DOSYA_BOYUTU) { ozet.atlanan.push({ yol: rel, neden: `çok büyük (${Math.round(st.size / 1048576)} MB)` }); return; }
    ozet.dosya_sayisi++;
    ozet.boyut += st.size;
    if (ozet.dosya_sayisi > EN_FAZLA_DOSYA || ozet.boyut > EN_FAZLA_BOYUT) {
      throw new KovanHatasi(`Proje çok büyük (en fazla ${EN_FAZLA_DOSYA} dosya ve ${EN_FAZLA_BOYUT / 1048576} MB; derleme çıktıları ve bağımlılık klasörleri sayılmaz). ` +
        "İşin geçtiği modülün klasörünü ver.");
    }
    for (const kok of [hedef, asil]) {
      fs.mkdirSync(path.dirname(path.join(kok, rel)), { recursive: true });
      fs.copyFileSync(kaynak, path.join(kok, rel));
    }
    const metin = !ikiliMi(kaynak);
    const satir = metin ? satirSay(kaynak) : 0;
    ozet.satir += satir;
    if (metin && !utf8Mi(fs.readFileSync(kaynak))) ozet.utf8_olmayan.push(rel);
    const tur = TURLER[path.extname(ad).toLowerCase()] ?? (metin ? "Metin" : "Diğer");
    const t = turler.get(tur) ?? { dosya: 0, satir: 0 };
    t.dosya++;
    t.satir += satir;
    turler.set(tur, t);
  };

  try {
    fs.mkdirSync(hedef, { recursive: true });
    fs.mkdirSync(asil, { recursive: true });
    kopyala(yol, "");
    if (!ozet.dosya_sayisi) throw new KovanHatasi(`Proje klasöründe dosya bulunamadı: ${yol}`);
  } catch (e) {
    fs.rmSync(hedef, { recursive: true, force: true });
    fs.rmSync(asil, { recursive: true, force: true });
    throw e;
  }
  ozet.turler = [...turler].map(([tur, t]) => ({ tur, ...t })).sort((a, b) => b.satir - a.satir || b.dosya - a.dosya);
  ozet.ust_duzey = fs.readdirSync(hedef, { withFileTypes: true }).map((g) => (g.isDirectory() ? `${g.name}/` : g.name)).sort();
  ozet.test_komutu = testKomutuSapta(hedef);
  return ozet;
}

/** Projenin test komutu için deterministik öneri (proje kökünde koşar). Bulunamazsa null; kullanıcı kartta yazar. */
export function testKomutuSapta(kok: string): string | null {
  const var_ = (ad: string) => fs.existsSync(path.join(kok, ad));
  if (var_("mvnw")) return "./mvnw -q test";
  if (var_("pom.xml")) return "mvn -q test";
  if (var_("gradlew")) return "./gradlew test";
  if (var_("build.gradle") || var_("build.gradle.kts")) return "gradle test";
  if (var_("package.json")) {
    try {
      const test = String(JSON.parse(fs.readFileSync(path.join(kok, "package.json"), "utf8"))?.scripts?.test ?? "");
      if (test && !/no test specified/i.test(test)) return "npm test";
    } catch { /* bozuk package.json: öneri yok */ }
  }
  return null;
}

const binlik = (n: number) => n.toLocaleString("tr-TR");

/** Ajanların ilk okuyacağı döküm: proje nerede, ne büyüklükte, hangi türler, kökte neler var. */
export function projeEnvanteri(o: ProjeOzeti): string {
  const p = ["# Proje envanteri", "",
    `Üzerinde çalışılan proje \`${PROJE_KLASORU}/\` klasöründe: ${binlik(o.dosya_sayisi)} dosya, ${binlik(o.satir)} satır. ` +
    "Bu bir çalışma kopyası; asıl klasöre dokunulmaz, iş bitince fark yama dosyası olarak çıkar.", "",
    `Test komutu önerisi (proje kökünde): ${o.test_komutu ? `\`${o.test_komutu}\`` : "saptanamadı"}`, "",
    "## Kökte", ...o.ust_duzey.map((x) => `- ${PROJE_KLASORU}/${x}`), "",
    "## Türlere göre", "| Tür | Dosya | Satır |", "|---|---|---|",
    ...o.turler.map((t) => `| ${t.tur} | ${binlik(t.dosya)} | ${t.satir ? binlik(t.satir) : "-"} |`)];
  if (o.utf8_olmayan.length) {
    p.push("", "## UTF-8 olmayan dosyalar", "Bu dosyalar asıl kodlamasıyla duruyor. Değiştirmen gerekiyorsa belgende açıkça yaz; yamaya girmez, ayrı dosya olarak teslim edilir.");
    for (const y of o.utf8_olmayan.slice(0, 100)) p.push(`- ${PROJE_KLASORU}/${y}`);
    if (o.utf8_olmayan.length > 100) p.push(`- (+${o.utf8_olmayan.length - 100} dosya daha)`);
  }
  if (o.atlanan.length) {
    p.push("", "## Alınmayanlar");
    for (const a of o.atlanan.slice(0, 100)) p.push(`- ${a.yol}: ${a.neden}`);
    if (o.atlanan.length > 100) p.push(`- (+${o.atlanan.length - 100} öğe daha)`);
  }
  return p.join("\n") + "\n";
}

export interface YamaDosyasi {
  yol: string;                                   // proje köküne göre
  durum: "eklendi" | "silindi" | "degisti";
  ayri: boolean;                                 // ikili ya da UTF-8 değil: yamada yok, dosyalar/ altında
}

export interface Yama {
  yama: string;                                  // birleşik diff (git apply ya da patch -p1 ile uygulanır)
  dosyalar: YamaDosyasi[];
}

function agac(kok: string): string[] {
  const sonuc: string[] = [];
  const gez = (dizin: string, rel: string) => {
    for (const g of fs.readdirSync(dizin, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${g.name}` : g.name;
      if (g.isSymbolicLink()) continue;
      if (g.isDirectory()) { if (!YAMA_ATLA.has(g.name)) gez(path.join(dizin, g.name), r); }
      else if (g.isFile() && g.name !== ".DS_Store" && !YAMA_ATLA_UZANTI.has(path.extname(g.name).toLowerCase())) sonuc.push(r);
    }
  };
  if (fs.existsSync(kok)) gez(kok, "");
  return sonuc;
}

const metinMi = (veri: Buffer | null) => veri === null || (!veri.subarray(0, 8192).includes(0) && utf8Mi(veri));

/** Dokunulmamış kopya ile çalışma kopyasının farkı. Derleme çıktıları ve bağımlılık klasörleri farka girmez. */
export function yamaUret(asil: string, calisan: string): Yama {
  const yollar = [...new Set([...agac(asil), ...agac(calisan)])].sort();
  const parcalar: string[] = [];
  const dosyalar: YamaDosyasi[] = [];
  for (const rel of yollar) {
    const oku = (kok: string) => (fs.existsSync(path.join(kok, rel)) ? fs.readFileSync(path.join(kok, rel)) : null);
    const [eski, yeni] = [oku(asil), oku(calisan)];
    if (eski && yeni && eski.equals(yeni)) continue;
    const durum = !eski ? "eklendi" : !yeni ? "silindi" : "degisti";
    if (!metinMi(eski) || !metinMi(yeni)) { dosyalar.push({ yol: rel, durum, ayri: true }); continue; }
    dosyalar.push({ yol: rel, durum, ayri: false });
    const p = structuredPatch(`a/${rel}`, `b/${rel}`, eski?.toString("utf8") ?? "", yeni?.toString("utf8") ?? "", "", "", { context: 3 });
    parcalar.push(`diff --git a/${rel} b/${rel}`);
    if (durum === "eklendi") parcalar.push("new file mode 100644");
    if (durum === "silindi") parcalar.push("deleted file mode 100644");
    if (!p.hunks.length) continue;   // boş dosya eklendi ya da silindi: başlık yeter
    parcalar.push(`--- ${durum === "eklendi" ? "/dev/null" : `a/${rel}`}`, `+++ ${durum === "silindi" ? "/dev/null" : `b/${rel}`}`);
    for (const h of p.hunks) {
      // Birleşik diff kuralı: satır sayısı 0 ise başlangıç bir eksik yazılır (ör. yeni dosyada -0,0)
      const eskiBas = h.oldLines === 0 ? h.oldStart - 1 : h.oldStart;
      const yeniBas = h.newLines === 0 ? h.newStart - 1 : h.newStart;
      parcalar.push(`@@ -${eskiBas},${h.oldLines} +${yeniBas},${h.newLines} @@`, ...h.lines);
    }
  }
  return { yama: parcalar.length ? parcalar.join("\n") + "\n" : "", dosyalar };
}

export const YAMA_DOSYASI = "degisiklik.patch";

/** Yamayı ve yamaya girmeyen dosyaları çıktı klasörüne yazar; klasör her seferinde baştan kurulur. */
export function yamaYaz(asil: string, calisan: string, cikti: string): Yama {
  const y = yamaUret(asil, calisan);
  fs.rmSync(cikti, { recursive: true, force: true });
  fs.mkdirSync(cikti, { recursive: true });
  fs.writeFileSync(path.join(cikti, YAMA_DOSYASI), y.yama, "utf8");
  for (const d of y.dosyalar.filter((x) => x.ayri && x.durum !== "silindi")) {
    const hedef = path.join(cikti, "dosyalar", d.yol);
    fs.mkdirSync(path.dirname(hedef), { recursive: true });
    fs.copyFileSync(path.join(calisan, d.yol), hedef);
  }
  return y;
}

/** Çıktı klasöründeki OKU dosyası: yama nasıl uygulanır, hangi dosyalar elle kopyalanır. */
export function yamaOkuBeni(y: Yama, asilYol: string): string {
  const etiket = { eklendi: "eklendi", silindi: "silindi", degisti: "değişti" } as const;
  const p = ["# Değişiklik yaması", "",
    `Proje: \`${asilYol}\``, "",
    "## Uygulama", "Projenin kökünde:", "", "```", `git apply ${YAMA_DOSYASI}`, "```", "",
    `Git yoksa: \`patch -p1 < ${YAMA_DOSYASI}\`. Önce denemek için: \`git apply --check ${YAMA_DOSYASI}\`.`, "",
    "## Dosyalar", ...(y.dosyalar.length ? y.dosyalar.map((d) => `- ${d.yol} (${etiket[d.durum]}${d.ayri ? "; yamada değil" : ""})`) : ["Değişiklik yok."])];
  const ayri = y.dosyalar.filter((d) => d.ayri);
  if (ayri.length) {
    p.push("", "## Yamaya girmeyenler", "İkili ya da UTF-8 olmayan dosyalar satır satır karşılaştırılamaz. Yeni halleri `dosyalar/` altında; projeye elle kopyala" +
      (ayri.some((d) => d.durum === "silindi") ? ", silinenleri elle sil" : "") + ". UTF-8 olmayan bir dosyada kodlamanın bozulmadığını gözle kontrol et.");
  }
  return p.join("\n") + "\n";
}
