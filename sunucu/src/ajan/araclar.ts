// Kovan'ın kendi ajan döngüsünün araçları: Read, Write, Edit, MultiEdit, Glob, Grep, Bash.
// Adları ve parametreleri Claude Code'unkilerle aynı; ajan kartlarındaki araç ve izin listeleri
// (izinli_komutlar: "Bash(npm test:*)" gibi) değişmeden geçerli. Bütün yollar çalışma dizinine
// hapsedilir; Bash yalnızca izinli kalıplara uyan komutları çalıştırır.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export class AracHatasi extends Error {}

const YOKSAY = new Set([".git", ".svn", ".hg", "node_modules", "target", "dist", "build", ".gradle", ".idea", "__pycache__", ".venv"]);
const OKUMA_SATIRI = 2000;
const SATIR_UZUNLUGU = 2000;
const CIKTI_SINIRI = 30_000;
const LISTE_SINIRI = 500;

/** Kart araç adı → OpenAI function şeması. Desteklenmeyen araçlar (WebFetch, Task...) ajana sunulmaz. */
export const ARAC_SEMALARI: Record<string, { aciklama: string; parametreler: Record<string, unknown> }> = {
  Read: {
    aciklama: "Bir dosyayı satır numaralarıyla okur. Uzun dosyalarda offset (1'den başlayan satır) ve limit ver.",
    parametreler: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Çalışma dizinine göre ya da tam yol" },
        offset: { type: "integer", description: "Okumaya başlanacak satır (1'den başlar)" },
        limit: { type: "integer", description: "En fazla kaç satır" },
      },
      required: ["file_path"],
    },
  },
  Write: {
    aciklama: "Dosyayı verilen içerikle yazar (yoksa oluşturur, varsa üzerine yazar). Klasörler kendiliğinden açılır.",
    parametreler: {
      type: "object",
      properties: { file_path: { type: "string" }, content: { type: "string", description: "Dosyanın tam içeriği" } },
      required: ["file_path", "content"],
    },
  },
  Edit: {
    aciklama: "Dosyadaki old_string metnini new_string ile değiştirir. old_string dosyada tam bir kez geçmeli (replace_all yoksa).",
    parametreler: {
      type: "object",
      properties: {
        file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" },
        replace_all: { type: "boolean", description: "Bütün geçişleri değiştir" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  MultiEdit: {
    aciklama: "Aynı dosyada birden çok Edit'i sırayla ve hep birlikte uygular; biri tutmazsa hiçbiri uygulanmaz.",
    parametreler: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["file_path", "edits"],
    },
  },
  Glob: {
    aciklama: "Kalıba uyan dosyaları listeler (ör. **/*.java, src/**/*.ts). node_modules, .git, target gibi klasörler atlanır.",
    parametreler: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string", description: "Aramanın başlayacağı klasör" } },
      required: ["pattern"],
    },
  },
  Grep: {
    aciklama: "Dosya içeriklerinde düzenli ifade arar. output_mode: files_with_matches (varsayılan), content (satırlar) ya da count.",
    parametreler: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript düzenli ifadesi" },
        path: { type: "string" }, glob: { type: "string", description: "Yalnızca bu kalıba uyan dosyalar (ör. *.pkb)" },
        output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
        case_insensitive: { type: "boolean" }, head_limit: { type: "integer" },
      },
      required: ["pattern"],
    },
  },
  Bash: {
    aciklama: "Çalışma dizininde bir kabuk komutu çalıştırır. Yalnızca izin verilen komutlar çalışır; izin listesi görevde yazar.",
    parametreler: {
      type: "object",
      properties: { command: { type: "string" }, timeout_sn: { type: "integer", description: "En fazla 600" } },
      required: ["command"],
    },
  },
};

export const DESTEKLENEN_ARACLAR = Object.keys(ARAC_SEMALARI);

// ------------------------------------------------------------------------------------------
// Yol hapsi
// ------------------------------------------------------------------------------------------
/** Verilen yolu çalışma dizinine göre çözer; dışarı çıkıyorsa (.., mutlak yol, sembolik bağ) hata. */
export function yolCoz(cwd: string, verilen: unknown): string {
  if (typeof verilen !== "string" || !verilen.trim()) throw new AracHatasi("dosya yolu boş");
  const kok = fs.realpathSync(cwd);
  const tam = path.resolve(kok, verilen.trim());
  const disarida = (p: string) => {
    const rel = path.relative(kok, p);
    return rel.startsWith("..") || path.isAbsolute(rel);
  };
  if (disarida(tam)) throw new AracHatasi(`çalışma dizininin dışı: ${verilen}`);
  // Var olan en yakın ata sembolik bağla dışarıyı gösteriyor olabilir
  let ata = tam;
  while (!fs.existsSync(ata) && ata !== kok) ata = path.dirname(ata);
  if (disarida(fs.realpathSync(ata))) throw new AracHatasi(`çalışma dizininin dışı (sembolik bağ): ${verilen}`);
  return tam;
}

const goreli = (cwd: string, p: string) => path.relative(fs.realpathSync(cwd), p).split(path.sep).join("/") || ".";

function ikiliMi(veri: Buffer): boolean {
  return veri.subarray(0, 8192).includes(0);
}

// ------------------------------------------------------------------------------------------
// Glob
// ------------------------------------------------------------------------------------------
/** Glob kalıbını düzenli ifadeye çevirir: **, *, ?, {a,b}. */
export function globIfadesi(kalip: string): RegExp {
  let r = "";
  for (let i = 0; i < kalip.length; i++) {
    const c = kalip[i];
    if (c === "*") {
      if (kalip[i + 1] === "*") {
        const sonrakiBolu = kalip[i + 2] === "/";
        r += sonrakiBolu ? "(?:.*/)?" : ".*";
        i += sonrakiBolu ? 2 : 1;
      } else r += "[^/]*";
    } else if (c === "?") r += "[^/]";
    else if (c === "{") {
      const son = kalip.indexOf("}", i);
      if (son < 0) { r += "\\{"; continue; }
      r += "(?:" + kalip.slice(i + 1, son).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
      i = son;
    } else r += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${r}$`);
}

function dosyalariGez(kok: string, cb: (p: string) => boolean | void): void {
  const yigin = [kok];
  while (yigin.length) {
    const d = yigin.pop()!;
    let girdiler: fs.Dirent[];
    try { girdiler = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    girdiler.sort((a, b) => b.name.localeCompare(a.name));
    for (const g of girdiler) {
      if (g.isSymbolicLink()) continue;
      const p = path.join(d, g.name);
      if (g.isDirectory()) { if (!YOKSAY.has(g.name)) yigin.push(p); }
      else if (g.isFile() && cb(p) === false) return;
    }
  }
}

// ------------------------------------------------------------------------------------------
// Bash izinleri (Claude Code kural yazımı: "Bash(npm test:*)", "Bash(mvn *)", "Bash(bash test-be.sh)")
// ------------------------------------------------------------------------------------------
/** Komutu tırnak dışındaki &&, ||, ;, | ve satır sonlarından parçalar. Komut ikamesi varsa null. */
export function komutParcala(komut: string): string[] | null {
  const parcalar: string[] = [];
  let tek = false, cift = false, bas = 0;
  for (let i = 0; i < komut.length; i++) {
    const c = komut[i];
    if (c === "\\" && !tek) { i++; continue; }
    if (c === "'" && !cift) { tek = !tek; continue; }
    if (c === '"' && !tek) { cift = !cift; continue; }
    if (tek) continue;
    if (c === "`" || (c === "$" && komut[i + 1] === "(")) return null;
    if (cift) continue;
    const iki = komut.slice(i, i + 2);
    if (iki === "&&" || iki === "||") { parcalar.push(komut.slice(bas, i)); bas = i + 2; i++; continue; }
    // 2>&1, &> gibi yönlendirmeler ayırıcı değil
    if (c === "&" && (komut[i - 1] === ">" || komut[i + 1] === ">")) continue;
    if (c === ";" || c === "|" || c === "\n" || c === "&") { parcalar.push(komut.slice(bas, i)); bas = i + 1; }
  }
  parcalar.push(komut.slice(bas));
  return parcalar.map((p) => p.trim()).filter(Boolean);
}

function kalipUyar(parca: string, kalip: string): boolean {
  if (kalip.endsWith(":*")) {
    const onek = kalip.slice(0, -2).trim();
    return parca === onek || parca.startsWith(onek + " ");
  }
  if (!kalip.includes("*")) return parca === kalip.trim();
  const r = kalip.trim().split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${r}$`, "s").test(parca);
}

/** Komutun her parçası izinli kalıplardan birine uyuyor mu? Uymayan ilk parçayı ya da null döner. */
export function bashIzni(komut: string, izinli: string[]): { izinli: boolean; neden: string | null } {
  const kaliplar = izinli.map((k) => /^Bash\((.*)\)$/s.exec(k.trim())?.[1]).filter((k): k is string => k !== undefined);
  const parcalar = komutParcala(komut);
  if (parcalar === null) return { izinli: false, neden: "komut ikamesi ($( ) ya da ``) izinli değil" };
  if (!parcalar.length) return { izinli: false, neden: "boş komut" };
  for (const p of parcalar) {
    if (!kaliplar.some((k) => kalipUyar(p, k))) return { izinli: false, neden: `izinli değil: ${p}` };
  }
  return { izinli: true, neden: null };
}

// ------------------------------------------------------------------------------------------
// Araçları çalıştırma
// ------------------------------------------------------------------------------------------
export interface AracBaglami {
  cwd: string;
  araclar: string[];
  izinli: string[];
  /** Bash'e verilecek ortam: gizli değişkenler (API anahtarı) çıkarılmış olmalı. */
  ortam: NodeJS.ProcessEnv;
  kalanSn: () => number;
  sinyal?: AbortSignal;
  izinRetleri: string[];
}

const metinMi = (v: unknown): v is string => typeof v === "string";
const kisalt = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}\n... (${s.length - n} karakter daha, kesildi)`);

function oku(b: AracBaglami, g: Record<string, unknown>): string {
  const p = yolCoz(b.cwd, g.file_path);
  if (!fs.existsSync(p)) throw new AracHatasi(`dosya yok: ${g.file_path}`);
  if (fs.statSync(p).isDirectory()) throw new AracHatasi(`bu bir klasör: ${g.file_path} (içindekiler için Glob kullan)`);
  const veri = fs.readFileSync(p);
  if (ikiliMi(veri)) return "(ikili dosya, okunamaz)";
  const satirlar = veri.toString("utf8").split("\n");
  if (satirlar.length > 1 && satirlar.at(-1) === "") satirlar.pop();
  const ilk = Math.max(1, Number(g.offset) || 1);
  const adet = Math.max(1, Math.min(OKUMA_SATIRI, Number(g.limit) || OKUMA_SATIRI));
  const parca = satirlar.slice(ilk - 1, ilk - 1 + adet);
  if (!parca.length) return `(dosya ${satirlar.length} satır; ${ilk}. satırdan sonrası yok)`;
  const govde = parca.map((s, i) => `${String(ilk + i).padStart(6)}\t${s.length > SATIR_UZUNLUGU ? s.slice(0, SATIR_UZUNLUGU) + "..." : s}`).join("\n");
  const kalan = satirlar.length - (ilk - 1 + parca.length);
  return kalan > 0 ? `${govde}\n(dosya ${satirlar.length} satır; devamı için offset=${ilk + parca.length})` : govde;
}

function yaz(b: AracBaglami, g: Record<string, unknown>): string {
  if (!metinMi(g.content)) throw new AracHatasi("content bir metin olmalı");
  const p = yolCoz(b.cwd, g.file_path);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const vardi = fs.existsSync(p);
  fs.writeFileSync(p, g.content);
  return `${vardi ? "Güncellendi" : "Oluşturuldu"}: ${goreli(b.cwd, p)} (${g.content.split("\n").length} satır)`;
}

function degistirUygula(icerik: string, e: Record<string, unknown>, ad: string): string {
  if (!metinMi(e.old_string) || !metinMi(e.new_string)) throw new AracHatasi("old_string ve new_string metin olmalı");
  if (!e.old_string) throw new AracHatasi("old_string boş olamaz (yeni dosya için Write kullan)");
  if (e.old_string === e.new_string) throw new AracHatasi("old_string ile new_string aynı");
  const sayi = icerik.split(e.old_string).length - 1;
  if (!sayi) throw new AracHatasi(`${ad}: old_string dosyada bulunamadı (boşluklar ve girintiler dahil birebir olmalı)`);
  if (sayi > 1 && e.replace_all !== true) throw new AracHatasi(`${ad}: old_string dosyada ${sayi} kez geçiyor; daha uzun bir parça ver ya da replace_all: true`);
  return e.replace_all === true ? icerik.split(e.old_string).join(e.new_string) : icerik.replace(e.old_string, () => e.new_string as string);
}

function duzenle(b: AracBaglami, g: Record<string, unknown>, coklu: boolean): string {
  const p = yolCoz(b.cwd, g.file_path);
  if (!fs.existsSync(p)) throw new AracHatasi(`dosya yok: ${g.file_path} (yeni dosya için Write kullan)`);
  let icerik = fs.readFileSync(p, "utf8");
  const degisiklikler = coklu ? (Array.isArray(g.edits) ? g.edits : null) : [g];
  if (!degisiklikler?.length) throw new AracHatasi("edits boş olamaz");
  degisiklikler.forEach((e, i) => { icerik = degistirUygula(icerik, e as Record<string, unknown>, coklu ? `${i + 1}. değişiklik` : "Edit"); });
  fs.writeFileSync(p, icerik);
  return `Düzenlendi: ${goreli(b.cwd, p)} (${degisiklikler.length} değişiklik)`;
}

function glob(b: AracBaglami, g: Record<string, unknown>): string {
  if (!metinMi(g.pattern) || !g.pattern.trim()) throw new AracHatasi("pattern boş");
  const taban = g.path ? yolCoz(b.cwd, g.path) : fs.realpathSync(b.cwd);
  const ifade = globIfadesi(g.pattern.trim().replace(/^\.\//, ""));
  const bulunan: string[] = [];
  dosyalariGez(taban, (p) => {
    if (ifade.test(path.relative(taban, p).split(path.sep).join("/"))) bulunan.push(goreli(b.cwd, p));
    return bulunan.length < LISTE_SINIRI;
  });
  bulunan.sort();
  if (!bulunan.length) return "(eşleşen dosya yok)";
  return bulunan.join("\n") + (bulunan.length >= LISTE_SINIRI ? `\n(ilk ${LISTE_SINIRI} sonuç; kalıbı daralt)` : "");
}

function grep(b: AracBaglami, g: Record<string, unknown>): string {
  if (!metinMi(g.pattern) || !g.pattern) throw new AracHatasi("pattern boş");
  let ifade: RegExp;
  try { ifade = new RegExp(g.pattern, g.case_insensitive === true ? "i" : ""); } catch (e) { throw new AracHatasi(`düzenli ifade geçersiz: ${(e as Error).message}`); }
  const taban = g.path ? yolCoz(b.cwd, g.path) : fs.realpathSync(b.cwd);
  const mod = g.output_mode === "content" || g.output_mode === "count" ? g.output_mode : "files_with_matches";
  const sinir = Math.max(1, Math.min(1000, Number(g.head_limit) || 200));
  const dosyaKalibi = metinMi(g.glob) && g.glob ? globIfadesi(g.glob.includes("/") ? g.glob : `**/${g.glob}`) : null;
  const sonuclar: string[] = [];
  const tara = (p: string) => {
    if (dosyaKalibi && !dosyaKalibi.test(path.relative(taban, p).split(path.sep).join("/"))) return;
    const st = fs.statSync(p);
    if (st.size > 2_000_000) return;
    const veri = fs.readFileSync(p);
    if (ikiliMi(veri)) return;
    const satirlar = veri.toString("utf8").split("\n");
    let adet = 0;
    for (let i = 0; i < satirlar.length; i++) {
      if (!ifade.test(satirlar[i])) continue;
      adet++;
      if (mod === "content") sonuclar.push(`${goreli(b.cwd, p)}:${i + 1}:${satirlar[i].slice(0, 500)}`);
      if (mod === "files_with_matches") break;
    }
    if (adet && mod === "files_with_matches") sonuclar.push(goreli(b.cwd, p));
    if (adet && mod === "count") sonuclar.push(`${goreli(b.cwd, p)}:${adet}`);
  };
  if (fs.statSync(taban).isFile()) tara(taban);
  else dosyalariGez(taban, (p) => { tara(p); return sonuclar.length < sinir; });
  if (!sonuclar.length) return "(eşleşme yok)";
  return sonuclar.slice(0, sinir).join("\n") + (sonuclar.length > sinir ? `\n(ilk ${sinir} sonuç)` : "");
}

function bash(b: AracBaglami, g: Record<string, unknown>): Promise<string> {
  if (!metinMi(g.command) || !g.command.trim()) throw new AracHatasi("command boş");
  const komut = g.command.trim();
  const izin = bashIzni(komut, b.izinli);
  if (!izin.izinli) {
    b.izinRetleri.push(`Bash(${komut.length > 80 ? komut.slice(0, 80) + "..." : komut})`);
    const liste = b.izinli.filter((k) => k.startsWith("Bash(")).join(", ") || "(hiçbiri)";
    throw new AracHatasi(`İzin yok (${izin.neden}). Yalnızca şu kalıplara uyan komutlar çalışır: ${liste}`);
  }
  const sure = Math.max(1, Math.min(600, Number(g.timeout_sn) || 120, Math.floor(b.kalanSn())));
  return new Promise((coz) => {
    const p = spawn("bash", ["-c", komut], { cwd: b.cwd, env: b.ortam, stdio: ["ignore", "pipe", "pipe"] });
    let cikti = "";
    const ekle = (d: Buffer) => { cikti += d.toString("utf8"); if (cikti.length > CIKTI_SINIRI * 4) cikti = cikti.slice(-CIKTI_SINIRI * 2); };
    p.stdout.on("data", ekle);
    p.stderr.on("data", ekle);
    let zamanAsimi = false;
    const saat = setTimeout(() => { zamanAsimi = true; p.kill("SIGKILL"); }, sure * 1000);
    const iptal = () => p.kill("SIGKILL");
    b.sinyal?.addEventListener("abort", iptal, { once: true });
    p.on("error", (e) => { clearTimeout(saat); coz(`Komut başlatılamadı: ${e.message}`); });
    p.on("close", (kod) => {
      clearTimeout(saat);
      b.sinyal?.removeEventListener("abort", iptal);
      const kuyruk = cikti.length > CIKTI_SINIRI ? `(çıktının son ${CIKTI_SINIRI} karakteri)\n${cikti.slice(-CIKTI_SINIRI)}` : cikti;
      coz(zamanAsimi ? `Süre doldu (${sure} sn), komut durduruldu.\n${kuyruk}` : `Çıkış kodu: ${kod ?? "?"}\n${kuyruk}`.trimEnd());
    });
  });
}

/** Bir araç çağrısını çalıştırır. Hata da modelin okuyacağı bir sonuçtur: döngü durmaz. */
export async function aracCalistir(b: AracBaglami, ad: string, girdi: unknown): Promise<{ metin: string; hata: boolean }> {
  if (!b.araclar.includes(ad) || !(ad in ARAC_SEMALARI)) {
    return { metin: `Bu araç kullanılamaz: ${ad}. Kullanabileceklerin: ${b.araclar.filter((a) => a in ARAC_SEMALARI).join(", ") || "hiçbiri"}`, hata: true };
  }
  const g = (girdi && typeof girdi === "object" ? girdi : {}) as Record<string, unknown>;
  try {
    let metin: string;
    switch (ad) {
      case "Read": metin = oku(b, g); break;
      case "Write": metin = yaz(b, g); break;
      case "Edit": metin = duzenle(b, g, false); break;
      case "MultiEdit": metin = duzenle(b, g, true); break;
      case "Glob": metin = glob(b, g); break;
      case "Grep": metin = grep(b, g); break;
      default: metin = await bash(b, g);
    }
    return { metin: kisalt(metin, CIKTI_SINIRI), hata: false };
  } catch (e) {
    return { metin: `Hata: ${(e as Error).message}`, hata: true };
  }
}
