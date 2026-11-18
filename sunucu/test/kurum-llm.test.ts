// Kurum içi LLM: OpenAI uyumlu motor, Kovan'ın kendi ajan döngüsü, araçlar ve izinler, dış ayar dosyası.
// Sahte bir OpenAI uyumlu sunucuya karşı koşar; gerçek bir modele ya da ağa ihtiyaç yok.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bashIzni, komutParcala, yolCoz } from "../src/ajan/araclar.js";
import { ajanDongusu, baglamKirp, metindenCagrilar, sonMetin, type BaglantiAyari, type DonguIstegi } from "../src/ajan/dongu.js";
import { ayarlariYukle } from "../src/ayarlar.js";
import { bekle, bekliyor, geciciKok, KOK, kovanOlustur, ORNEK_MINI } from "./yardimci/ortam.js";

// ------------------------------------------------------------------------------------------
// Sahte OpenAI uyumlu sunucu
// ------------------------------------------------------------------------------------------
type Istek = { yol: string; basliklar: http.IncomingHttpHeaders; govde: any };
type Yanit = { durum?: number; govde: unknown };

interface SahteSunucu { adres: string; istekler: Istek[]; kapat: () => Promise<void> }
const sunucular: SahteSunucu[] = [];
afterEach(async () => { await Promise.all(sunucular.splice(0).map((s) => s.kapat())); });

async function sahteSunucu(cevap: (g: any, n: number, i: Istek) => Yanit, modeller = ["qwen-test"]): Promise<SahteSunucu> {
  const istekler: Istek[] = [];
  let n = 0;
  const sunucu = http.createServer((req, res) => {
    const parcalar: Buffer[] = [];
    req.on("data", (d) => parcalar.push(d));
    req.on("end", () => {
      const metin = Buffer.concat(parcalar).toString("utf8");
      const istek: Istek = { yol: req.url ?? "", basliklar: req.headers, govde: metin ? JSON.parse(metin) : null };
      let y: Yanit;
      if (req.method === "GET" && req.url === "/v1/models") y = { govde: { data: modeller.map((id) => ({ id })) } };
      else { istekler.push(istek); y = cevap(istek.govde, ++n, istek); }
      res.writeHead(y.durum ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(y.govde));
    });
  });
  await new Promise<void>((coz) => sunucu.listen(0, "127.0.0.1", coz));
  const s: SahteSunucu = {
    adres: `http://127.0.0.1:${(sunucu.address() as { port: number }).port}/v1`, istekler,
    kapat: () => new Promise((coz) => { sunucu.closeAllConnections(); sunucu.close(() => coz()); }),
  };
  sunucular.push(s);
  return s;
}

const yanit = (mesaj: Record<string, unknown>, kullanim = { prompt_tokens: 100, completion_tokens: 20 }): Yanit =>
  ({ govde: { choices: [{ message: { role: "assistant", content: null, ...mesaj }, finish_reason: "stop" }], usage: kullanim } });
const cagri = (ad: string, girdi: unknown, id = `c_${ad}`) => ({ id, type: "function", function: { name: ad, arguments: JSON.stringify(girdi) } });
const sonMesaj = (g: any) => g.messages.at(-1);
const gecici = () => fs.mkdtempSync(path.join(os.tmpdir(), "kovan-kurum-"));

function baglanti(adres: string, ek: Partial<BaglantiAyari> = {}): BaglantiAyari {
  return {
    adres, model: "qwen-test", anahtar: "gizli-anahtar", anahtar_basligi: "Authorization", ek_basliklar: {}, ca: null,
    arac_bicimi: "otomatik", sicaklik: 0.2, en_fazla_token: null, baglam_token: 32_768, en_fazla_tur: 20, ...ek,
  };
}
function istek(cwd: string, ek: Partial<DonguIstegi> = {}): DonguIstegi {
  return { sistem: "Sen bir test ajanısın.", sistem_modu: "ekle", istem: "Görevi yap.", araclar: ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash"], izinli: [], cwd, sure_sn: 60, ...ek };
}

// ------------------------------------------------------------------------------------------
describe("Ajan döngüsü", () => {
  it("araç çağırır, sonucu modele verir; araç çağırmadan verilen yanıt ajanın çıktısıdır", async () => {
    const s = await sahteSunucu((g, n) => n === 1 ? yanit({ tool_calls: [cagri("Write", { file_path: "notlar/a.txt", content: "merhaba\ndünya" })] })
      : n === 2 ? yanit({ tool_calls: [cagri("Read", { file_path: "notlar/a.txt" })] })
        : yanit({ content: "Bitti: notlar/a.txt yazıldı." }));
    const cwd = gecici();
    const r = await ajanDongusu(baglanti(s.adres), istek(cwd, { araclar: ["Read", "Write"] }));

    expect(r).toMatchObject({ ok: true, metin: "Bitti: notlar/a.txt yazıldı.", tur_sayisi: 3, girdi_token: 300, cikti_token: 60, arac_bicimi: "otomatik" });
    expect(fs.readFileSync(path.join(cwd, "notlar/a.txt"), "utf8")).toBe("merhaba\ndünya");
    const [ilk, ikinci, ucuncu] = s.istekler;
    expect(ilk.yol).toBe("/v1/chat/completions");
    expect(ilk.basliklar.authorization).toBe("Bearer gizli-anahtar");
    expect(ilk.govde.tools.map((t: any) => t.function.name)).toEqual(["Read", "Write"]);
    expect(ilk.govde.messages[0]).toMatchObject({ role: "system" });
    expect(ilk.govde.messages[0].content).toMatch(/Çalışma dizinin: .*\n?[\s\S]*Sen bir test ajanısın\./);
    expect(sonMesaj(ikinci.govde)).toMatchObject({ role: "tool", tool_call_id: "c_Write", content: "Oluşturuldu: notlar/a.txt (2 satır)" });
    expect(sonMesaj(ucuncu.govde).content).toBe("     1\tmerhaba\n     2\tdünya");
  });

  it("sunucu araç çağrısını ayrıştırmazsa Qwen'in metin biçimini okur; düşünme bloğunu çıktıdan ayıklar", async () => {
    const s = await sahteSunucu((g, n) => n === 1
      ? yanit({ content: "Dosyayı yazıyorum.\n<tool_call>\n<function=Write>\n<parameter=file_path>\nx.md\n</parameter>\n<parameter=content>\n# Başlık\nsatır\n</parameter>\n</function>\n</tool_call>" })
      : n === 2 ? yanit({ content: '<tool_call>\n{"name": "Read", "arguments": {"file_path": "x.md", "limit": 1}}\n</tool_call>' })
        : yanit({ content: "<think>Kontrol ettim.</think>\nTamam, yazıldı." }));
    const cwd = gecici();
    const r = await ajanDongusu(baglanti(s.adres), istek(cwd));
    expect(r).toMatchObject({ ok: true, metin: "Tamam, yazıldı." });
    expect(fs.readFileSync(path.join(cwd, "x.md"), "utf8")).toBe("# Başlık\nsatır");
    expect(sonMesaj(s.istekler[1].govde)).toMatchObject({ role: "user", content: "<tool_response>\nOluşturuldu: x.md (2 satır)\n</tool_response>" });
    expect(sonMesaj(s.istekler[2].govde).content).toBe("<tool_response>\n     1\t# Başlık\n(dosya 2 satır; devamı için offset=2)\n</tool_response>");
  });

  it("sunucu araçları reddederse (vLLM'de tool parser kapalı) araçları metinle anlatarak sürdürür", async () => {
    const s = await sahteSunucu((g) => g.tools
      ? { durum: 400, govde: { error: { message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set' } } }
      : g.messages.length === 2 ? yanit({ content: "<tool_call>\n<function=Write>\n<parameter=file_path>\nb.txt\n</parameter>\n<parameter=content>\n42\n</parameter>\n</function>\n</tool_call>" })
        : yanit({ content: "Yazdım." }));
    const cwd = gecici();
    const r = await ajanDongusu(baglanti(s.adres), istek(cwd));
    expect(r).toMatchObject({ ok: true, metin: "Yazdım.", arac_bicimi: "metin", tur_sayisi: 2 });
    expect(fs.readFileSync(path.join(cwd, "b.txt"), "utf8")).toBe("42");     // içerik metin kalır, sayıya çevrilmez
    expect(s.istekler.map((i) => Boolean(i.govde.tools))).toEqual([true, false, false]);
    expect(s.istekler[1].govde.messages[0].content).toContain("Kullanabileceğin araçlar:\n- Read(file_path: string, offset?: integer, limit?: integer)");
  });

  it("Bash yalnızca izinli kalıplara uyan komutları çalıştırır; reddedilenler kaydedilir", async () => {
    const komutlar = ['node -e "console.log(40+2)"', "rm -rf /tmp/kovan-yok", "node -v && curl http://ornek.invalid", 'node -e "console.log(1)" 2>&1'];
    const s = await sahteSunucu((g, n) => n === 1 ? yanit({ tool_calls: komutlar.map((c, i) => cagri("Bash", { command: c }, `b${i}`)) }) : yanit({ content: "tamam" }));
    const r = await ajanDongusu(baglanti(s.adres), istek(gecici(), { izinli: ["Bash(node *)", "Bash(npm test:*)"] }));
    const sonuclar = s.istekler[1].govde.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(sonuclar[0]).toBe("Çıkış kodu: 0\n42");
    expect(sonuclar[1]).toMatch(/^Hata: İzin yok \(izinli değil: rm -rf \/tmp\/kovan-yok\)\. Yalnızca şu kalıplara uyan komutlar çalışır: Bash\(node \*\), Bash\(npm test:\*\)$/);
    expect(sonuclar[2]).toMatch(/^Hata: İzin yok \(izinli değil: curl http:\/\/ornek\.invalid\)/);
    expect(sonuclar[3]).toBe("Çıkış kodu: 0\n1");
    expect(r.izin_retleri).toEqual(["Bash(rm -rf /tmp/kovan-yok)", "Bash(node -v && curl http://ornek.invalid)"]);
  });

  it("çalışma dizininin dışına okuyamaz ve yazamaz; sembolik bağla da çıkamaz", async () => {
    const dis = gecici();
    const cwd = gecici();
    fs.symlinkSync(dis, path.join(cwd, "kacis"));
    const denemeler = [["Write", { file_path: "../disari.txt", content: "x" }], ["Write", { file_path: path.join(dis, "mutlak.txt"), content: "x" }],
      ["Write", { file_path: "kacis/bag.txt", content: "x" }], ["Read", { file_path: "/etc/passwd" }]] as const;
    const s = await sahteSunucu((g, n) => n === 1 ? yanit({ tool_calls: denemeler.map(([a, g], i) => cagri(a, g, `y${i}`)) }) : yanit({ content: "tamam" }));
    await ajanDongusu(baglanti(s.adres), istek(cwd));
    const sonuclar = s.istekler[1].govde.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(sonuclar).toEqual([
      "Hata: çalışma dizininin dışı: ../disari.txt", `Hata: çalışma dizininin dışı: ${path.join(dis, "mutlak.txt")}`,
      "Hata: çalışma dizininin dışı (sembolik bağ): kacis/bag.txt", "Hata: çalışma dizininin dışı: /etc/passwd",
    ]);
    expect(fs.readdirSync(dis)).toEqual([]);
    expect(() => yolCoz(cwd, "alt/../../x")).toThrow(/dışı/);
  });

  it("Edit birebir ve tek eşleşme ister; MultiEdit ya hep ya hiç uygular; Glob ve Grep kaynakta arar", async () => {
    const cwd = gecici();
    fs.mkdirSync(path.join(cwd, "kaynak/pkg"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "kaynak/pkg/GUNSONU.pkb"), "c_gun := 365;\nv := ROUND(x, 2);\nv := ROUND(y, 2);\n");
    fs.writeFileSync(path.join(cwd, "kaynak/pkg/notlar.md"), "ROUND burada değil\n");
    const s = await sahteSunucu((g, n) => n === 1 ? yanit({
      tool_calls: [
        cagri("Edit", { file_path: "kaynak/pkg/GUNSONU.pkb", old_string: "365", new_string: "360" }, "e1"),
        cagri("Edit", { file_path: "kaynak/pkg/GUNSONU.pkb", old_string: "ROUND", new_string: "TRUNC" }, "e2"),
        cagri("MultiEdit", { file_path: "kaynak/pkg/GUNSONU.pkb", edits: [{ old_string: "360", new_string: "361" }, { old_string: "YOK", new_string: "x" }] }, "e3"),
        cagri("Glob", { pattern: "**/*.pkb" }, "g1"),
        cagri("Grep", { pattern: "ROUND\\(", glob: "*.pkb", output_mode: "content" }, "g2"),
      ],
    }) : yanit({ content: "tamam" }));
    await ajanDongusu(baglanti(s.adres), istek(cwd));
    const sonuclar = s.istekler[1].govde.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(sonuclar).toEqual([
      "Düzenlendi: kaynak/pkg/GUNSONU.pkb (1 değişiklik)",
      "Hata: Edit: old_string dosyada 2 kez geçiyor; daha uzun bir parça ver ya da replace_all: true",
      "Hata: 2. değişiklik: old_string dosyada bulunamadı (boşluklar ve girintiler dahil birebir olmalı)",
      "kaynak/pkg/GUNSONU.pkb",
      "kaynak/pkg/GUNSONU.pkb:2:v := ROUND(x, 2);\nkaynak/pkg/GUNSONU.pkb:3:v := ROUND(y, 2);",
    ]);
    expect(fs.readFileSync(path.join(cwd, "kaynak/pkg/GUNSONU.pkb"), "utf8")).toBe("c_gun := 360;\nv := ROUND(x, 2);\nv := ROUND(y, 2);\n");
  });

  it("geçici hatada tekrar dener; anahtar reddi ve ulaşılamayan sunucu kalıcı hatadır; tur sınırında durur", async () => {
    const yogun = await sahteSunucu((g, n) => n === 1 ? { durum: 429, govde: { error: "yoğun" } } : yanit({ content: "oldu" }));
    expect(await ajanDongusu(baglanti(yogun.adres), istek(gecici()))).toMatchObject({ ok: true, metin: "oldu" });

    const ret = await sahteSunucu(() => ({ durum: 401, govde: { error: "invalid api key" } }));
    expect(await ajanDongusu(baglanti(ret.adres), istek(gecici()))).toMatchObject({ ok: false, kalici_hata: true, hata: expect.stringMatching(/^API anahtarı reddedildi \(HTTP 401\)/) });

    const kapali = await sahteSunucu(() => yanit({ content: "-" }));
    await kapali.kapat();
    expect(await ajanDongusu(baglanti(kapali.adres), istek(gecici()))).toMatchObject({ ok: false, kalici_hata: true, hata: expect.stringMatching(/ulaşılamadı \(ECONNREFUSED\)/) });

    const durmayan = await sahteSunucu(() => yanit({ tool_calls: [cagri("Glob", { pattern: "*" })] }));
    expect(await ajanDongusu(baglanti(durmayan.adres, { en_fazla_tur: 3 }), istek(gecici()))).toMatchObject({ ok: false, hata: "Ajan 3 turda bitiremedi (araç çağırmayı sürdürdü)", tur_sayisi: 3 });
  }, 20_000);

  it("araçsız ajan (belge yazan) araç almaz; bağlam dolunca eski araç çıktıları kısaltılır", async () => {
    const s = await sahteSunucu(() => yanit({ content: "# Brif" }));
    const r = await ajanDongusu(baglanti(s.adres), istek(gecici(), { araclar: [], sistem_modu: "degistir" }));
    expect(r.metin).toBe("# Brif");
    expect(s.istekler[0].govde.tools).toBeUndefined();
    expect(s.istekler[0].govde.messages[0].content).toBe("Sen bir test ajanısın.");

    const mesajlar = [{ role: "system", content: "s" }, { role: "user", content: "g" },
      { role: "tool", content: "x".repeat(5000), arac_sonucu: true }, { role: "tool", content: "y".repeat(5000), arac_sonucu: true },
      { role: "assistant", content: "a" }, { role: "tool", content: "z".repeat(5000), arac_sonucu: true }] as any[];
    expect(baglamKirp(mesajlar, 8000)).toBe(2);
    expect(mesajlar[2].content).toMatch(/^\[kısaltıldı: önceki araç çıktısı, 5000 karakter/);
    expect(mesajlar[5].content).toHaveLength(5000);                       // son mesajlar korunur
  });
});

describe("Komut izinleri ve metin biçimi", () => {
  it("komutu tırnaklara ve yönlendirmelere dikkat ederek parçalar; komut ikamesine izin vermez", () => {
    expect(komutParcala('node -e "a; b" && npm test 2>&1 | tail -5')).toEqual(['node -e "a; b"', "npm test 2>&1", "tail -5"]);
    expect(komutParcala("echo $(whoami)")).toBeNull();
    expect(komutParcala("echo 'tek $(tırnak)'")).toEqual(["echo 'tek $(tırnak)'"]);
    const izinli = ["Bash(npm --prefix backend:*)", "Bash(mvn *)", "Bash(bash test-be.sh)"];
    expect(bashIzni("npm --prefix backend test", izinli).izinli).toBe(true);
    expect(bashIzni("npm --prefix backendx test", izinli).izinli).toBe(false);
    expect(bashIzni("mvn -q -DskipTests=false verify", izinli).izinli).toBe(true);
    expect(bashIzni("bash test-be.sh", izinli).izinli).toBe(true);
    expect(bashIzni("bash test-be.sh; rm -rf .", izinli)).toEqual({ izinli: false, neden: "izinli değil: rm -rf ." });
  });

  it("Hermes JSON ve Qwen3-Coder XML biçimlerini okur; parametre tiplerini araç şemasından çözer", () => {
    expect(metindenCagrilar('<tool_call>{"name":"Glob","arguments":"{\\"pattern\\":\\"*.ts\\"}"}</tool_call>')).toEqual([{ ad: "Glob", girdi: { pattern: "*.ts" } }]);
    expect(metindenCagrilar("<tool_call><function=Read><parameter=file_path>a.ts</parameter><parameter=offset>10</parameter></function></tool_call>"))
      .toEqual([{ ad: "Read", girdi: { file_path: "a.ts", offset: 10 } }]);
    // kesilmiş yanıt: kapanmamış blok
    expect(metindenCagrilar('<tool_call>\n<function=MultiEdit>\n<parameter=file_path>\na.ts\n</parameter>\n<parameter=edits>\n[{"old_string":"a","new_string":"b"}]\n</parameter>'))
      .toEqual([{ ad: "MultiEdit", girdi: { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b" }] } }]);
    expect(sonMetin("<think>uzun düşünce</think>\n\nSonuç")).toBe("Sonuç");
    expect(sonMetin("şablonda açılmış düşünce</think>Sonuç")).toBe("Sonuç");
  });
});

// ------------------------------------------------------------------------------------------
// Dış ayar dosyası ve uçtan uca Hepsi yerel
// ------------------------------------------------------------------------------------------
const TEK_AKIS = `ad: Tek
aciklama: Kurum LLM testi için iki aşamalı akış.
fikir_butcesi_usd: 1
ortak_karar: false
asamalar:
  - id: brif
    ad: Brif
    ajan: urun-sahibi
    gorev: Fikri kısa bir brife çevir.
    girdiler: [fikir]
    cikti: brif
    dogrulama:
      - ad: Analist onayı
        inceleyen: analist
        odak: Brif anlaşılır mı?
  - id: not
    ad: Not
    ajan: be-yazilimci
    calisma_dizini: kod
    gorev: notlar/ozet.md dosyasına kısa bir not yaz.
    girdiler: [brif]
    cikti: not
    yazabilir: [notlar]
  - id: kabul
    ad: Kabul
    tur: insan
    soru: Bitti mi?
    geri_donus: not
`;

function disAyar(adres: string, ek = ""): string {
  const d = gecici();
  const yol = path.join(d, "kurum.yaml");
  fs.writeFileSync(yol, `claude: false
modlar: [yerel, deneme]
yerel_motor: kurum-llm
motorlar:
  kurum-llm:
    tur: openai
    adres: ${adres}
    model: qwen-test
    anahtar_degiskeni: KOVAN_TEST_KURUM_ANAHTAR
    baglam_token: 32768
ajanlar:
  "*":
    motor: kurum-llm
  mimar:
    yerel_model: qwen-buyuk
    sure_dk: 45
${ek}`);
  return yol;
}

describe("Dış ayar dosyası", () => {
  it("repodaki ayarların üstüne biner: motorlar yerine geçer, Claude kapanır, modlar daralır, ajanlar yönlendirilir", async () => {
    const s = await sahteSunucu(() => yanit({ content: "-" }));
    const yol = disAyar(s.adres);
    const cfg = ayarlariYukle(geciciKok(), yol);
    expect(Object.keys(cfg.motorlar)).toEqual(["kurum-llm"]);                // repodaki Ollama tanımı gelmez
    expect([cfg.claude, cfg.modlar, cfg.motor, cfg.yerel_motor, cfg.dis_ayar]).toEqual([false, ["yerel", "deneme"], "yerel", "kurum-llm", yol]);
    expect(cfg.motorlar["kurum-llm"]).toMatchObject({ tur: "openai", anahtar_basligi: "Authorization", arac_bicimi: "otomatik", yerel: true });

    process.env.KOVAN_TEST_KURUM_ANAHTAR = "gizli-123";
    try {
      const k = await kovanOlustur({ motorlar: null, dis_ayar: yol });
      expect([...k.motorlar.keys()]).toEqual(["deneme", "kurum-llm"]);       // claude komutu hiç aranmadı
      expect(new Set([...k.ork.kartlar.values()].map((x) => x.motor))).toEqual(new Set(["kurum-llm"]));
      expect(k.ork.kartlar.get("mimar")).toMatchObject({ yerel_model: "qwen-buyuk", sure_dk: 45 });
      const durum = (await k.app.inject({ url: "/api/durum", headers: { host: "127.0.0.1:8765" } })).json();
      expect(durum).toMatchObject({ modlar: ["yerel", "deneme"], yerel_motor: "kurum-llm", dis_ayar: yol, varsayilan_motor: "yerel" });
      expect(durum.motorlar["kurum-llm"]).toMatchObject({ hazir: true, tur: "openai", yerel: true, model: "qwen-test", adres: s.adres });
      expect(JSON.stringify(durum)).not.toContain("gizli-123");
      await expect(k.ork.yeniFikir("", ORNEK_MINI, "mini", "hibrit")).rejects.toThrow(/'hibrit' modu bu kurulumda kapalı/);
      await k.ork.kapat();
    } finally {
      delete process.env.KOVAN_TEST_KURUM_ANAHTAR;
    }
  });

  it("anahtarı ayar dosyasına yazdırmaz; dışarıdan yalnızca motor, model, süre ve bütçe değişir; yanlış adlar söylenir", async () => {
    const kok = geciciKok();
    const s = await sahteSunucu(() => yanit({ content: "-" }));
    expect(() => ayarlariYukle(kok, disAyar(s.adres).replace("kurum.yaml", "yok.yaml"))).toThrow(/Dış ayar dosyası bulunamadı/);
    const anahtarli = disAyar(s.adres);
    fs.writeFileSync(anahtarli, fs.readFileSync(anahtarli, "utf8").replace("    baglam_token", "    anahtar: sk-123\n    baglam_token"));
    expect(() => ayarlariYukle(kok, anahtarli)).toThrow(/anahtarın kendisini ayar dosyasına yazma/);
    expect(() => ayarlariYukle(kok, disAyar(s.adres, "  analist:\n    araclar: [Bash]\n"))).toThrow(/araclar dışarıdan değiştirilemez/);
    expect(() => ayarlariYukle(kok, disAyar(s.adres, "motor: hibrit\n"))).toThrow(/varsayılan mod 'hibrit' açık modlar arasında değil/);
    await expect(kovanOlustur({ motorlar: null, dis_ayar: disAyar(s.adres, "  mimarr:\n    sure_dk: 5\n") })).rejects.toThrow(/bilinmeyen ajan: mimarr/);

    // anahtar yoksa motor hazır değil ve sebebi söylenir; anahtar dosyadan da okunabilir
    const k = await kovanOlustur({ motorlar: null, dis_ayar: disAyar(s.adres) });
    const durum = await k.motorlar.get("kurum-llm")!.durumOzeti();
    expect(durum).toMatchObject({ hazir: false, hata: "API anahtarı yok: KOVAN_TEST_KURUM_ANAHTAR ortam değişkeni boş. Kovan'ı başlatmadan önce ayarla." });
    await expect(k.ork.yeniFikir("", ORNEK_MINI, "mini", "yerel")).rejects.toThrow(/'kurum-llm' motoru hazır değil: API anahtarı yok.*Adresi, modeli ve API anahtarını dış ayar dosyasında kontrol et/);
    const anahtarDosyasi = path.join(gecici(), "anahtar");
    fs.writeFileSync(anahtarDosyasi, "dosyadaki-anahtar\n");
    const dosyali = disAyar(s.adres);
    fs.writeFileSync(dosyali, fs.readFileSync(dosyali, "utf8").replace("anahtar_degiskeni: KOVAN_TEST_KURUM_ANAHTAR", `anahtar_dosyasi: ${anahtarDosyasi}`));
    const k2 = await kovanOlustur({ motorlar: null, dis_ayar: dosyali });
    expect((await k2.motorlar.get("kurum-llm")!.durumOzeti()).hazir).toBe(true);
    await k.ork.kapat();
    await k2.ork.kapat();
  });

  it("ornekler/kurum-ayar.ornek.yaml olduğu gibi yüklenir: bütün ajanlar kurum LLM'ine gider, anahtar yoksa ağa çıkmadan söylenir", async () => {
    const yol = path.join(KOK, "ornekler", "kurum-ayar.ornek.yaml");
    const cfg = ayarlariYukle(geciciKok(), yol);
    expect([cfg.claude, cfg.modlar, cfg.motor, cfg.yerel_motor]).toEqual([false, ["yerel", "deneme"], "yerel", "kurum-llm"]);
    expect(Object.keys(cfg.motorlar)).toEqual(["kurum-llm"]);
    expect(cfg.motorlar["kurum-llm"]).toMatchObject({ tur: "openai", model: "qwen3-coder", anahtar_degiskeni: "KURUM_LLM_ANAHTAR", baglam_token: 65536, yerel: true });
    const onceki = process.env.KURUM_LLM_ANAHTAR;
    delete process.env.KURUM_LLM_ANAHTAR;
    try {
      const k = await kovanOlustur({ motorlar: null, dis_ayar: yol });
      expect(new Set([...k.ork.kartlar.values()].map((x) => x.motor))).toEqual(new Set(["kurum-llm"]));
      expect(await k.motorlar.get("kurum-llm")!.durumOzeti()).toMatchObject({ hazir: false, hata: expect.stringMatching(/^API anahtarı yok: KURUM_LLM_ANAHTAR/) });
      await k.ork.kapat();
    } finally {
      if (onceki !== undefined) process.env.KURUM_LLM_ANAHTAR = onceki;
    }
  });

  it("Hepsi yerel: bütün ajanlar kurum LLM'inde, kendi döngüsüyle ve ayrı süreçte; anahtar Bash'e sızmaz", async () => {
    const s = await sahteSunucu((g) => {
      const kullanici = g.messages[1].content as string;
      if (/"karar": "ONAY" \| "DUZELT"/.test(kullanici)) return yanit({ content: 'Brif net.\n```json\n{"karar": "ONAY", "gerekce": "Anlaşılır.", "bulgular": []}\n```' });
      if (kullanici.startsWith("# Görev: Brif")) return yanit({ content: "# Brif\n\nNotları özetleyen küçük bir araç." });
      if (kullanici.startsWith("# Görev: Not")) {
        const son = g.messages.at(-1);
        if (son.role === "user") {
          return yanit({ tool_calls: [cagri("Write", { file_path: "notlar/ozet.md", content: "# Özet\n" }, "w"),
            cagri("Bash", { command: 'node -e "console.log(process.env.KOVAN_LLM_ANAHTAR ?? \'yok\', process.env.KOVAN_TEST_KURUM_ANAHTAR ?? \'yok\')"' }, "b")] });
        }
        return yanit({ content: `Not yazıldı. Ortam: ${son.content}` });
      }
      return yanit({ content: "?" });
    });
    process.env.KOVAN_TEST_KURUM_ANAHTAR = "gizli-123";
    try {
      const k = await kovanOlustur({ kok: geciciKok({ tek: TEK_AKIS }), motorlar: null, dis_ayar: disAyar(s.adres) });
      const fid = await k.ork.yeniFikir("Not aracı", "Notları özetleyen küçük bir araç.", "tek", "yerel");
      await bekle(k, fid, bekliyor("insan"), 60_000);
      const d = k.ork.fikirDetayi(fid);
      expect(d.adimlar.filter((a) => a.tip !== "sistem").map((a) => `${a.asama_id}:${a.tip}:${a.durum}:${a.motor}`)).toEqual([
        "brif:uret:tamam:kurum-llm", "brif:inceleme:onay:kurum-llm", "not:uret:tamam:kurum-llm",
      ]);
      expect(Object.keys(d.motor_cagrilari)).toEqual(["kurum-llm"]);
      expect(fs.readFileSync(path.join(k.calisma, fid, "kod/notlar/ozet.md"), "utf8")).toBe("# Özet\n");
      expect(fs.readFileSync(path.join(k.calisma, fid, "belgeler/not.md"), "utf8")).toContain("Ortam: Çıkış kodu: 0\nyok yok");
      expect(s.istekler.every((i) => i.basliklar.authorization === "Bearer gizli-123")).toBe(true);
      expect(new Set(s.istekler.map((i) => i.govde.model))).toEqual(new Set(["qwen-test"]));
      await k.ork.kapat();
    } finally {
      delete process.env.KOVAN_TEST_KURUM_ANAHTAR;
    }
  }, 60_000);
});
