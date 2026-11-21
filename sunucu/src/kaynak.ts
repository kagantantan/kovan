// Mevcut sistem kaynakları (replatform): eski sistemin kodu ve dokümanları fikrin kod/kaynak/ klasörüne
// kopyalanır. Klasör kilitlenir (salt okunur): ajanlar okur, kimse değiştiremez. Word belgeleri ajanların
// okuyabileceği HTML'e çevrilir; dosyaların dökümü "kaynak-envanteri" belgesi olur.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mammoth from "mammoth";
import { KovanHatasi } from "./ortak.js";

export const KAYNAK_KLASORU = "kaynak";
export const EN_FAZLA_DOSYA = 5000;
export const EN_FAZLA_BOYUT = 200 * 1024 * 1024;        // toplam
export const EN_FAZLA_DOSYA_BOYUTU = 20 * 1024 * 1024;  // tek dosya

/** Kopyalanmayan klasörler: sürüm kontrolü, bağımlılıklar, derleme çıktıları, editör ayarları. */
export const ATLA_KLASOR = new Set([".git", ".svn", ".hg", "node_modules", "target", "build", "dist", "out", ".gradle", ".idea", ".vscode",
  "__pycache__", ".venv", "venv", ".mvn"]);
const IKILI = new Set([".class", ".jar", ".war", ".ear", ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".lib", ".obj", ".pyc", ".zip",
  ".tar", ".gz", ".tgz", ".7z", ".rar", ".dmp", ".bak", ".mdb", ".sqlite", ".db"]);

export const TURLER: Record<string, string> = {
  ".sql": "SQL", ".pks": "PL/SQL", ".pkb": "PL/SQL", ".pkg": "PL/SQL", ".prc": "PL/SQL", ".fnc": "PL/SQL", ".trg": "PL/SQL",
  ".pls": "PL/SQL", ".plb": "PL/SQL", ".plsql": "PL/SQL", ".typ": "PL/SQL", ".tps": "PL/SQL", ".tpb": "PL/SQL",
  ".java": "Java", ".kt": "Kotlin", ".scala": "Scala", ".cs": "C#", ".vb": "VB.NET", ".c": "C", ".h": "C/C++ başlık", ".cpp": "C++",
  ".cc": "C++", ".hpp": "C++", ".pc": "Pro*C", ".cbl": "COBOL", ".cob": "COBOL", ".cpy": "COBOL", ".pco": "Pro*COBOL",
  ".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".ts": "TypeScript", ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".php": "PHP",
  ".sh": "Shell", ".ksh": "Shell", ".bash": "Shell", ".csh": "Shell", ".bat": "Batch", ".cmd": "Batch", ".ps1": "PowerShell",
  ".xml": "XML", ".xsd": "XML", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".properties": "Properties", ".ini": "INI",
  ".conf": "Ayar", ".cfg": "Ayar", ".ctl": "SQL*Loader", ".jcl": "JCL",
  ".md": "Doküman", ".txt": "Doküman", ".html": "HTML", ".htm": "HTML", ".docx": "Word", ".doc": "Word (eski)", ".pdf": "PDF",
  ".xlsx": "Excel", ".xls": "Excel (eski)", ".csv": "Veri (CSV)", ".tsv": "Veri (TSV)", ".png": "Görsel", ".jpg": "Görsel", ".jpeg": "Görsel",
};

export interface KaynakDosyasi {
  yol: string;      // kod/ köküne göre: kaynak/...
  tur: string;
  satir: number | null;
  boyut: number;
}

export interface KaynakOzeti {
  yollar: string[];          // verilen yollar (kullanıcının makinesindeki)
  dosya_sayisi: number;
  boyut: number;
  satir: number;
  dosyalar: KaynakDosyasi[];
  donusturulen: { kaynak: string; hedef: string }[];
  kodlama: { yol: string; kodlama: string }[];   // UTF-8'e çevrilenler
  atlanan: { yol: string; neden: string }[];
}

export function genislet(ham: string): string {
  const y = ham.trim().replace(/^["']|["']$/g, "");
  return path.resolve(y === "~" || y.startsWith("~/") ? path.join(os.homedir(), y.slice(1)) : y);
}

export function ikiliMi(dosya: string): boolean {
  const fd = fs.openSync(dosya, "r");
  try {
    const tampon = Buffer.alloc(8192);
    const n = fs.readSync(fd, tampon, 0, tampon.length, 0);
    return tampon.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Eski sistem dosyaları çoğu zaman UTF-8 değildir (Türkçe Windows-1254, UTF-16). Ajanlar Türkçe yorumları
 * doğru okusun diye kopya UTF-8'e çevrilir; satırlar aynı kalır, atıflar bozulmaz. Çevrilen kodlamayı döner.
 */
function utf8eCevir(dosya: string): string | null {
  const veri = fs.readFileSync(dosya);
  const bom16 = veri.length >= 2 && ((veri[0] === 0xff && veri[1] === 0xfe) || (veri[0] === 0xfe && veri[1] === 0xff));
  let kodlama: string;
  if (bom16) kodlama = veri[0] === 0xff ? "utf-16le" : "utf-16be";
  else {
    if (veri.subarray(0, 8192).includes(0)) return null;        // ikili
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(veri);
      return null;                                               // zaten UTF-8
    } catch {
      kodlama = "windows-1254";
    }
  }
  fs.writeFileSync(dosya, new TextDecoder(kodlama).decode(veri), "utf8");
  return kodlama;
}

export function satirSay(dosya: string): number {
  const veri = fs.readFileSync(dosya);
  let n = 0;
  for (const b of veri) if (b === 10) n++;
  return veri.length && veri[veri.length - 1] !== 10 ? n + 1 : n;
}

/** Hedefte çakışmayan bir ad: rapor, rapor-2, rapor-3 */
function bosAd(dizin: string, ad: string): string {
  let aday = ad;
  for (let i = 2; fs.existsSync(path.join(dizin, aday)); i++) aday = `${ad}-${i}`;
  return aday;
}

/**
 * Verilen klasörleri, .zip dosyalarını ya da tek dosyaları hedef klasöre (kod/kaynak) kopyalar.
 * Sınırlar aşılırsa hiçbir şey bırakmadan hata verir.
 */
export async function kaynakIceAl(hamYollar: string[], hedef: string): Promise<KaynakOzeti> {
  const yollar = [...new Set(hamYollar.map((y) => y.trim()).filter(Boolean).map(genislet))];
  if (!yollar.length) throw new KovanHatasi("Mevcut sistemin kaynak klasörünü ya da dosyasını yaz.");
  for (const y of yollar) if (!fs.existsSync(y)) throw new KovanHatasi(`Kaynak bulunamadı: ${y}`);
  const ust = path.dirname(path.resolve(hedef));
  const hedefGercek = path.join(fs.existsSync(ust) ? fs.realpathSync(ust) : ust, path.basename(hedef));
  for (const y of yollar) {
    const g = fs.realpathSync(y);
    if (hedefGercek === g || hedefGercek.startsWith(g + path.sep)) {
      throw new KovanHatasi(`Kaynak, Kovan'ın çalışma klasörünü içeriyor: ${y}. Yalnızca taşınacak işin klasörünü seç.`);
    }
  }
  fs.mkdirSync(hedef, { recursive: true });
  const ozet: KaynakOzeti = { yollar, dosya_sayisi: 0, boyut: 0, satir: 0, dosyalar: [], donusturulen: [], kodlama: [], atlanan: [] };
  const geciciler: string[] = [];
  const kokRel = (p: string) => `${KAYNAK_KLASORU}/${path.relative(hedef, p).split(path.sep).join("/")}`;

  const kopyala = (kaynak: string, varis: string) => {
    const st = fs.lstatSync(kaynak);
    if (st.isSymbolicLink()) { ozet.atlanan.push({ yol: kokRel(varis), neden: "sembolik bağ" }); return; }
    if (st.isDirectory()) {
      const ad = path.basename(kaynak);
      if (ATLA_KLASOR.has(ad)) { ozet.atlanan.push({ yol: `${kokRel(varis)}/`, neden: "derleme çıktısı, bağımlılık ya da sürüm kontrolü klasörü" }); return; }
      fs.mkdirSync(varis, { recursive: true });
      for (const g of fs.readdirSync(kaynak).sort()) kopyala(path.join(kaynak, g), path.join(varis, g));
      return;
    }
    if (!st.isFile()) return;
    const ad = path.basename(kaynak);
    const uz = path.extname(ad).toLowerCase();
    if (ad === ".DS_Store" || ad.startsWith("~$")) return;
    if (IKILI.has(uz)) { ozet.atlanan.push({ yol: kokRel(varis), neden: "ikili ya da arşiv dosyası" }); return; }
    if (st.size > EN_FAZLA_DOSYA_BOYUTU) { ozet.atlanan.push({ yol: kokRel(varis), neden: `çok büyük (${Math.round(st.size / 1048576)} MB)` }); return; }
    ozet.dosya_sayisi++;
    ozet.boyut += st.size;
    if (ozet.dosya_sayisi > EN_FAZLA_DOSYA || ozet.boyut > EN_FAZLA_BOYUT) {
      throw new KovanHatasi(`Kaynak çok büyük (en fazla ${EN_FAZLA_DOSYA} dosya ve ${EN_FAZLA_BOYUT / 1048576} MB). ` +
        "Yalnızca taşınacak işin klasörlerini seç (ör. gün sonu paketleri ve analiz dokümanı).");
    }
    fs.mkdirSync(path.dirname(varis), { recursive: true });
    fs.copyFileSync(kaynak, varis);
    const belgeMi = [".docx", ".doc", ".pdf", ".xlsx", ".xls", ".png", ".jpg", ".jpeg"].includes(uz);
    const kodlama = belgeMi ? null : utf8eCevir(varis);
    if (kodlama) ozet.kodlama.push({ yol: kokRel(varis), kodlama });
    const metin = !belgeMi && !ikiliMi(varis);
    const satir = metin ? satirSay(varis) : null;
    if (satir) ozet.satir += satir;
    ozet.dosyalar.push({ yol: kokRel(varis), tur: TURLER[uz] ?? (metin ? "Metin" : "Diğer"), satir, boyut: st.size });
  };

  try {
    for (const y of yollar) {
      const st = fs.statSync(y);
      if (st.isFile() && path.extname(y).toLowerCase() === ".zip") {
        const gecici = fs.mkdtempSync(path.join(os.tmpdir(), "kovan-kaynak-"));
        geciciler.push(gecici);
        const r = spawnSync("unzip", ["-q", "-o", y, "-d", gecici], { encoding: "utf8" });
        if (r.error || r.status !== 0) throw new KovanHatasi(`Zip açılamadı: ${y} (${r.error?.message ?? r.stderr?.trim() ?? "unzip hatası"}). Klasör olarak vermeyi dene.`);
        kopyala(gecici, path.join(hedef, bosAd(hedef, path.basename(y, path.extname(y)))));
      } else {
        kopyala(y, path.join(hedef, bosAd(hedef, path.basename(y))));
      }
    }
    if (!ozet.dosya_sayisi) throw new KovanHatasi("Kaynakta okunabilir dosya bulunamadı.");
    // Word belgeleri ajanların okuyabileceği HTML'e çevrilir (tablolar korunur); asıl dosya da yerinde kalır.
    for (const d of ozet.dosyalar.filter((x) => x.yol.toLowerCase().endsWith(".docx"))) {
      const tam = path.join(hedef, d.yol.slice(KAYNAK_KLASORU.length + 1));
      try {
        const sonuc = await mammoth.convertToHtml({ path: tam });
        // Blok öğeleri ayrı satırlara: ajanlar belgeye de satır numarasıyla atıf verebilsin
        // (tablo satırı tek satırda kalır: "Gün esası | 360" aynı atıfta görünsün)
        const govde = sonuc.value.replace(/(<\/(?:p|h[1-6]|tr|table|li|ul|ol)>)/g, "$1\n").replace(/(<table>)/g, "$1\n")
          .replace(/<tr>[\s\S]*?<\/tr>/g, (tr) => tr.replace(/\n/g, ""));
        const html = `<!doctype html>\n<html lang="tr"><head><meta charset="utf-8"><title>${path.basename(tam)}</title></head><body>\n${govde}\n</body></html>\n`;
        fs.writeFileSync(`${tam}.html`, html, "utf8");
        const hedefYol = `${d.yol}.html`;
        ozet.donusturulen.push({ kaynak: d.yol, hedef: hedefYol });
        ozet.dosyalar.push({ yol: hedefYol, tur: "Word (HTML'e çevrildi)", satir: satirSay(`${tam}.html`), boyut: Buffer.byteLength(html) });
      } catch (e) {
        ozet.atlanan.push({ yol: d.yol, neden: `Word belgesi çevrilemedi: ${(e as Error).message}` });
      }
    }
    for (const d of ozet.dosyalar.filter((x) => /\.(doc|xls)$/i.test(x.yol))) {
      ozet.atlanan.push({ yol: d.yol, neden: "eski Office biçimi okunamaz; .docx ya da .xlsx olarak kaydedip yeniden ver" });
    }
    ozet.dosyalar.sort((a, b) => a.yol.localeCompare(b.yol));
    return ozet;
  } catch (e) {
    fs.rmSync(hedef, { recursive: true, force: true });
    throw e;
  } finally {
    for (const g of geciciler) fs.rmSync(g, { recursive: true, force: true });
  }
}

const binlik = (n: number) => n.toLocaleString("tr-TR");
const kb = (b: number) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(1).replace(".", ",")} KB` : `${(b / 1048576).toFixed(1).replace(".", ",")} MB`);

/** Ajanların ilk okuyacağı döküm: türlere göre özet, dosya listesi, çevrilenler, atlananlar. */
export function envanterBelgesi(o: KaynakOzeti, giris?: string): string {
  const p = ["# Kaynak envanteri", "",
    (giris ?? `Mevcut sistemin kodu ve dokümanları \`${KAYNAK_KLASORU}/\` klasöründe (salt okunur, kilitli).`) + " " +
    `Toplam ${binlik(o.dosya_sayisi)} dosya, ${binlik(o.satir)} satır, ${kb(o.boyut)}.`, "",
    "## Türlere göre", "| Tür | Dosya | Satır |", "|---|---|---|"];
  const turler = new Map<string, { dosya: number; satir: number }>();
  for (const d of o.dosyalar) {
    const t = turler.get(d.tur) ?? { dosya: 0, satir: 0 };
    t.dosya++;
    t.satir += d.satir ?? 0;
    turler.set(d.tur, t);
  }
  for (const [tur, t] of [...turler].sort((a, b) => b[1].satir - a[1].satir || b[1].dosya - a[1].dosya)) {
    p.push(`| ${tur} | ${binlik(t.dosya)} | ${t.satir ? binlik(t.satir) : "-"} |`);
  }
  p.push("", "## Dosyalar", "| Dosya | Tür | Satır | Boyut |", "|---|---|---|---|");
  for (const d of o.dosyalar.slice(0, 400)) p.push(`| ${d.yol} | ${d.tur} | ${d.satir ?? "-"} | ${kb(d.boyut)} |`);
  if (o.dosyalar.length > 400) p.push("", `(+${o.dosyalar.length - 400} dosya daha; Glob ile listele)`);
  if (o.donusturulen.length) {
    p.push("", "## Çevrilen belgeler", "Word belgeleri okunabilsin diye HTML'e çevrildi; tablolar korunur.");
    for (const c of o.donusturulen) p.push(`- ${c.kaynak} → ${c.hedef}`);
  }
  if (o.kodlama.length) {
    p.push("", "## Karakter kodlaması", "Şu dosyalar UTF-8 değildi; okunabilsin diye UTF-8'e çevrildi (satırlar aynı, atıflar geçerli):");
    for (const k of o.kodlama.slice(0, 100)) p.push(`- ${k.yol} (${k.kodlama})`);
    if (o.kodlama.length > 100) p.push(`- (+${o.kodlama.length - 100} dosya daha)`);
  }
  if (o.atlanan.length) {
    p.push("", "## Alınmayanlar");
    for (const a of o.atlanan.slice(0, 100)) p.push(`- ${a.yol}: ${a.neden}`);
  }
  return p.join("\n") + "\n";
}

/** Kaynak atıfları: "kaynak/<yol>:<satır>" ya da "kaynak/<yol>:<ilk>-<son>". onekler: atıf verilebilen üst klasörler (mevcut projede proje/ de). */
export function atiflariDenetle(belge: string, kodKoku: string, onekler: string[] = [KAYNAK_KLASORU]): { gecerli: number; hatalar: string[] } {
  const hatalar: string[] = [];
  const satirSayilari = new Map<string, number | null>();
  let gecerli = 0;
  const desen = new RegExp(`(?<![\\w/])((?:${onekler.join("|")})/[^\\s\`'"()\\[\\]<>|,;]+?):(\\d+)(?:-(\\d+))?(?!\\d)`, "g");
  const gorulen = new Set<string>();
  for (const m of belge.matchAll(desen)) {
    const [atif, rel, a, b] = m;
    if (gorulen.has(atif)) continue;
    gorulen.add(atif);
    const ilk = Number(a);
    const son = b ? Number(b) : ilk;
    const tam = path.resolve(kodKoku, rel);
    if (!onekler.some((o) => tam.startsWith(path.resolve(kodKoku, o) + path.sep)) || !fs.existsSync(tam) || !fs.statSync(tam).isFile()) {
      hatalar.push(`${atif}: böyle bir dosya yok`);
      continue;
    }
    if (!satirSayilari.has(rel)) satirSayilari.set(rel, ikiliMi(tam) ? null : satirSay(tam));
    const n = satirSayilari.get(rel);
    if (n === null || n === undefined) { hatalar.push(`${atif}: metin dosyası değil, satır atfı verilemez`); continue; }
    if (ilk < 1 || son < ilk || son > n) { hatalar.push(`${atif}: dosya ${n} satır; bu satırlar yok`); continue; }
    gecerli++;
  }
  if (!gecerli && !hatalar.length) hatalar.push(`Belgede hiç kod atfı yok. Her kuralı \`${onekler[0]}/<dosya>:<satır>\` biçiminde koda bağla.`);
  return { gecerli, hatalar };
}
