// Kovan'ın kendi ajan döngüsü: OpenAI uyumlu /chat/completions (vLLM, TGI, LM Studio, Ollama /v1,
// kurum ağ geçitleri). Claude Code CLI gerekmez. Model araç çağırdıkça araçlar çalışır, sonuçlar geri
// verilir; model araç çağırmadan yanıt verince o yanıt ajanın çıktısıdır.
//
// Araç çağrısı biçimi:
//   openai   : istekte tools gönderilir, yanıttaki tool_calls okunur
//   metin    : araçlar sistem isteminde anlatılır, model <tool_call> blokları yazar (Qwen biçimi)
//   otomatik : openai ile başlar; sunucu tools'u reddederse (vLLM'de tool parser kapalı) metne geçer.
// Her durumda tool_calls boş gelip metinde <tool_call> varsa (parser kapalı, sessiz hata) o da okunur.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

import { ARAC_SEMALARI, aracCalistir, type AracBaglami } from "./araclar.js";

export type AracBicimi = "otomatik" | "openai" | "metin";

export interface BaglantiAyari {
  adres: string;                     // ".../v1"; sonuna /chat/completions eklenir
  model: string;
  anahtar: string | null;
  anahtar_basligi: string;           // Authorization -> "Bearer <anahtar>"; başka ad -> anahtarın kendisi
  ek_basliklar: Record<string, string>;
  ca: string | null;                 // ek kök sertifika (PEM), kurum içi HTTPS için
  arac_bicimi: AracBicimi;
  sicaklik: number | null;
  en_fazla_token: number | null;
  baglam_token: number;
  en_fazla_tur: number;
}

export interface DonguIstegi {
  sistem: string;
  sistem_modu: "degistir" | "ekle";
  istem: string;
  araclar: string[];
  izinli: string[];
  cwd: string;
  sure_sn: number;
}

export interface DonguSonucu {
  ok: boolean;
  metin: string;
  hata: string | null;
  kalici_hata: boolean;
  zaman_asimi: boolean;
  girdi_token: number;
  cikti_token: number;
  tur_sayisi: number;
  izin_retleri: string[];
  arac_bicimi: AracBicimi;
}

// ------------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------------
export class HttpHatasi extends Error {
  constructor(public durum: number, public govde: string) {
    super(`HTTP ${durum}: ${govde.slice(0, 400)}`);
  }
}

export function basliklar(b: Pick<BaglantiAyari, "anahtar" | "anahtar_basligi" | "ek_basliklar">): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json", ...b.ek_basliklar };
  if (b.anahtar) h[b.anahtar_basligi] = b.anahtar_basligi.toLowerCase() === "authorization" ? `Bearer ${b.anahtar}` : b.anahtar;
  return h;
}

/** JSON isteği. Kurum içi HTTPS için ek kök sertifika varsayılan köklere eklenir (yerine geçmez). */
export function jsonIstek(b: Pick<BaglantiAyari, "adres" | "anahtar" | "anahtar_basligi" | "ek_basliklar" | "ca">, yol: string,
  govde: unknown, secenek: { yontem?: "GET" | "POST"; sure_ms: number; sinyal?: AbortSignal }): Promise<any> {
  const url = new URL(b.adres.replace(/\/+$/, "") + yol);
  const istemci = url.protocol === "https:" ? https : http;
  const veri = govde === undefined ? undefined : JSON.stringify(govde);
  const h = basliklar(b);
  if (veri !== undefined) { h["content-type"] = "application/json"; h["content-length"] = String(Buffer.byteLength(veri)); }
  return new Promise((coz, red) => {
    const istek = istemci.request(url, {
      method: secenek.yontem ?? (veri === undefined ? "GET" : "POST"), headers: h, signal: secenek.sinyal,
      ...(url.protocol === "https:" && b.ca ? { ca: [...tls.rootCertificates, b.ca] } : {}),
    }, (yanit) => {
      const parcalar: Buffer[] = [];
      yanit.on("data", (d: Buffer) => parcalar.push(d));
      yanit.on("end", () => {
        const metin = Buffer.concat(parcalar).toString("utf8");
        const durum = yanit.statusCode ?? 0;
        if (durum < 200 || durum >= 300) return red(new HttpHatasi(durum, metin));
        try { coz(metin ? JSON.parse(metin) : {}); } catch { red(new HttpHatasi(durum, `JSON olmayan yanıt: ${metin.slice(0, 200)}`)); }
      });
      yanit.on("error", red);
    });
    istek.setTimeout(secenek.sure_ms, () => istek.destroy(Object.assign(new Error("istek zaman aşımına uğradı"), { code: "ETIMEDOUT" })));
    istek.on("error", red);
    istek.end(veri);
  });
}

const TLS_HATALARI = ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"];
const AG_HATALARI = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"];
const GECICI_HATALAR = ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"];

/** Bağlantı hatasını insanın anlayacağı bir mesaja çevirir. kalici: aynı istek tekrar denense de düzelmez. */
export function baglantiHatasi(e: unknown, adres: string): { mesaj: string; kalici: boolean; gecici: boolean } {
  const kod = String((e as NodeJS.ErrnoException)?.code ?? "");
  const host = (() => { try { return new URL(adres).host; } catch { return adres; } })();
  if (e instanceof HttpHatasi) {
    const d = e.durum;
    if (d === 401 || d === 403) return { mesaj: `API anahtarı reddedildi (HTTP ${d}). Anahtarı ve anahtar_basligi ayarını kontrol et.`, kalici: true, gecici: false };
    if (d === 404) return { mesaj: `Adres bulunamadı (HTTP 404): ${adres}. Adres genelde /v1 ile biter; model adını da kontrol et.`, kalici: true, gecici: false };
    if (d === 429 || d >= 500) return { mesaj: `Sunucu şu an yanıt veremiyor (HTTP ${d}): ${e.govde.slice(0, 200)}`, kalici: false, gecici: true };
    if (/context|maximum.*length|too long|token/i.test(e.govde)) return { mesaj: `Modelin bağlamı yetmedi (HTTP ${d}): ${e.govde.slice(0, 200)}`, kalici: false, gecici: false };
    return { mesaj: `Sunucu isteği reddetti (HTTP ${d}): ${e.govde.slice(0, 300)}`, kalici: true, gecici: false };
  }
  if (TLS_HATALARI.includes(kod)) return { mesaj: `${host} sertifikası doğrulanamadı (${kod}). Kurumun kök sertifikasını ca_dosyasi ile ver.`, kalici: true, gecici: false };
  if (AG_HATALARI.includes(kod)) return { mesaj: `${host} adresine ulaşılamadı (${kod}). Adres doğru mu, bu makine o ağa erişebiliyor mu?`, kalici: true, gecici: false };
  if (GECICI_HATALAR.includes(kod) || /socket hang up/i.test(String((e as Error)?.message))) {
    return { mesaj: `Bağlantı koptu (${kod || (e as Error).message})`, kalici: false, gecici: true };
  }
  return { mesaj: `İstek başarısız: ${(e as Error)?.message ?? String(e)}`, kalici: false, gecici: false };
}

// ------------------------------------------------------------------------------------------
// Metin biçiminde araç çağrıları (Qwen): Hermes JSON ya da Qwen3-Coder XML
// ------------------------------------------------------------------------------------------
export interface MetinCagrisi { ad: string; girdi: Record<string, unknown> }

function parametreCoz(arac: string, ad: string, ham: string): unknown {
  const sema = (ARAC_SEMALARI[arac]?.parametreler as { properties?: Record<string, { type?: string }> } | undefined)?.properties?.[ad];
  const deger = ham.replace(/^\n/, "").replace(/\n$/, "");
  switch (sema?.type) {
    case "integer": case "number": return Number(deger.trim());
    case "boolean": return deger.trim() === "true";
    case "array": case "object": try { return JSON.parse(deger); } catch { return deger; }
    default: return deger;
  }
}

/**
 * Yanıt metnindeki <tool_call> bloklarını okur. İki biçim:
 *   <tool_call>{"name": "Write", "arguments": {...}}</tool_call>                       (Hermes / Qwen2.5-Qwen3)
 *   <tool_call><function=Write><parameter=file_path>a</parameter>...</function></tool_call> (Qwen3-Coder)
 * Kapanmamış son blok da okunur (yanıt kesildiyse).
 */
export function metindenCagrilar(metin: string): MetinCagrisi[] {
  const bloklar = [...(metin ?? "").matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)].map((m) => m[1].trim()).filter(Boolean);
  const sonuc: MetinCagrisi[] = [];
  for (const govde of bloklar) {
    if (govde.startsWith("{")) {
      try {
        const j = JSON.parse(govde);
        const girdi = typeof j.arguments === "string" ? JSON.parse(j.arguments) : (j.arguments ?? j.parameters ?? {});
        if (j.name) sonuc.push({ ad: String(j.name), girdi });
        continue;
      } catch { /* XML biçimini dene */ }
    }
    const f = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(govde);
    if (!f) continue;
    const girdi: Record<string, unknown> = {};
    for (const p of f[2].matchAll(/<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g)) girdi[p[1]] = parametreCoz(f[1], p[1], p[2]);
    sonuc.push({ ad: f[1], girdi });
  }
  return sonuc;
}

/** Son yanıttan düşünme ve araç bloklarını ayıklar. */
export function sonMetin(metin: string): string {
  return (metin ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*?<\/think>/, "")          // açılışı şablonda kalmış düşünme
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, "")
    .trim();
}

// ------------------------------------------------------------------------------------------
// İstem
// ------------------------------------------------------------------------------------------
function aracListesi(araclar: string[]): string {
  return araclar.map((a) => {
    const s = ARAC_SEMALARI[a];
    const p = s.parametreler as { properties: Record<string, { type?: string }>; required?: string[] };
    const params = Object.entries(p.properties).map(([ad, v]) => `${ad}${p.required?.includes(ad) ? "" : "?"}: ${v.type}`).join(", ");
    return `- ${a}(${params}): ${s.aciklama}`;
  }).join("\n");
}

function metinAracTalimati(araclar: string[]): string {
  return [
    "## Araçlar",
    "Bir araç çağırmak için yanıtına şu bloğu yaz (bir yanıtta birden çok blok olabilir):",
    "<tool_call>\n<function=ARAÇ_ADI>\n<parameter=PARAMETRE_ADI>\ndeğer\n</parameter>\n</function>\n</tool_call>",
    "Değerleri olduğu gibi yaz (dosya içeriği dahil; kaçış karakteri gerekmez). Dizi ya da nesne değerleri JSON olarak yaz.",
    "Araç sonuçları sana <tool_response> içinde gelir. İşin bitince araç çağırmadan son yanıtını yaz.",
    "", "Kullanabileceğin araçlar:", aracListesi(araclar),
  ].join("\n");
}

function sistemMetni(i: DonguIstegi, araclar: string[], metinBicimi: boolean): string {
  const temel = araclar.length
    ? `Bir yazılım ekibinde görevli bir ajansın. Çalışma dizinin: ${i.cwd}. Dosyaları araçlarla okuyup yazarsın; ` +
      "dizinin dışına çıkamazsın. Araçları gerektiği kadar kullan, sonuçlarını dikkate al. İşin bitince araç çağırmadan " +
      "son yanıtını yaz: son yanıtın, görevin istediği çıktıdır."
    : "";
  const parcalar = i.sistem_modu === "ekle" ? [temel, i.sistem] : [i.sistem, araclar.length ? temel : ""];
  if (araclar.length && metinBicimi) parcalar.push(metinAracTalimati(araclar));
  return parcalar.filter(Boolean).join("\n\n");
}

// ------------------------------------------------------------------------------------------
// Bağlam: eski araç çıktıları kısaltılır (sistem, görev ve son mesajlar korunur)
// ------------------------------------------------------------------------------------------
type Mesaj = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: unknown[]; tool_call_id?: string; arac_sonucu?: boolean };

function boyut(m: Mesaj): number {
  return (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
}

export function baglamKirp(mesajlar: Mesaj[], sinirKarakter: number): number {
  let toplam = mesajlar.reduce((t, m) => t + boyut(m), 0);
  let kirpilan = 0;
  for (let i = 2; i < mesajlar.length - 2 && toplam > sinirKarakter; i++) {
    const m = mesajlar[i];
    if (!m.arac_sonucu || m.content.length < 400) continue;
    const yeni = `[kısaltıldı: önceki araç çıktısı, ${m.content.length} karakter; gerekirse aracı yeniden çağır]`;
    toplam -= m.content.length - yeni.length;
    m.content = yeni;
    kirpilan++;
  }
  return kirpilan;
}

// ------------------------------------------------------------------------------------------
// Döngü
// ------------------------------------------------------------------------------------------
const bekle = (ms: number, sinyal?: AbortSignal) => new Promise<void>((coz) => {
  const t = setTimeout(coz, ms);
  sinyal?.addEventListener("abort", () => { clearTimeout(t); coz(); }, { once: true });
});

const aracMetniMi = (govde: string) => /tool|function/i.test(govde);

export async function ajanDongusu(b: BaglantiAyari, i: DonguIstegi, secenek: { sinyal?: AbortSignal; ortam?: NodeJS.ProcessEnv } = {}): Promise<DonguSonucu> {
  const bitis = Date.now() + i.sure_sn * 1000;
  const kalanMs = () => bitis - Date.now();
  const araclar = i.araclar.filter((a) => a in ARAC_SEMALARI);
  let bicim: AracBicimi = b.arac_bicimi;
  const sonuc: DonguSonucu = {
    ok: false, metin: "", hata: null, kalici_hata: false, zaman_asimi: false, girdi_token: 0, cikti_token: 0,
    tur_sayisi: 0, izin_retleri: [], arac_bicimi: bicim,
  };
  const baglam: AracBaglami = {
    cwd: i.cwd, araclar, izinli: i.izinli, ortam: secenek.ortam ?? process.env, kalanSn: () => kalanMs() / 1000,
    sinyal: secenek.sinyal, izinRetleri: sonuc.izin_retleri,
  };
  const mesajlar: Mesaj[] = [
    { role: "system", content: sistemMetni(i, araclar, bicim === "metin") },
    { role: "user", content: i.istem },
  ];
  const sinirKarakter = Math.max(20_000, Math.floor(b.baglam_token * 3 * 0.7));
  const bitir = (alanlar: Partial<DonguSonucu>) => Object.assign(sonuc, { arac_bicimi: bicim }, alanlar);

  for (let tur = 1; tur <= b.en_fazla_tur; tur++) {
    if (secenek.sinyal?.aborted) return bitir({ hata: "Durduruldu" });
    if (kalanMs() <= 0) return bitir({ zaman_asimi: true, hata: `Süre sınırı aşıldı (${i.sure_sn} sn)` });
    baglamKirp(mesajlar, sinirKarakter);
    const yerelAraclar = araclar.length && bicim !== "metin";
    const govde = {
      model: b.model,
      messages: mesajlar.map(({ arac_sonucu: _a, ...m }) => m),
      ...(yerelAraclar ? { tools: araclar.map((a) => ({ type: "function", function: { name: a, description: ARAC_SEMALARI[a].aciklama, parameters: ARAC_SEMALARI[a].parametreler } })) } : {}),
      ...(b.sicaklik !== null ? { temperature: b.sicaklik } : {}),
      ...(b.en_fazla_token ? { max_tokens: b.en_fazla_token } : {}),
      stream: false,
    };

    let yanit: any = null;
    for (let deneme = 1; ; deneme++) {
      try {
        yanit = await jsonIstek(b, "/chat/completions", govde, { sure_ms: Math.max(1000, kalanMs()), sinyal: secenek.sinyal });
        break;
      } catch (e) {
        if (secenek.sinyal?.aborted) return bitir({ hata: "Durduruldu" });
        if (kalanMs() <= 0) return bitir({ zaman_asimi: true, hata: `Süre sınırı aşıldı (${i.sure_sn} sn)` });
        // vLLM'de tool parser kapalıysa tools içeren istek 400 alır: araçları metinle anlatarak sürdür
        if (e instanceof HttpHatasi && (e.durum === 400 || e.durum === 422) && yerelAraclar && bicim === "otomatik" && aracMetniMi(e.govde)) {
          bicim = "metin";
          mesajlar[0].content = sistemMetni(i, araclar, true);
          tur--;
          yanit = null;
          break;
        }
        const h = baglantiHatasi(e, b.adres);
        if (h.gecici && deneme < 3) { await bekle(Math.min([2000, 5000][deneme - 1], Math.max(0, kalanMs() - 1000)), secenek.sinyal); continue; }
        return bitir({ hata: h.mesaj, kalici_hata: h.kalici });
      }
    }
    if (!yanit) continue;    // biçim değişti, aynı turu metin biçimiyle tekrarla

    sonuc.tur_sayisi = tur;
    sonuc.girdi_token += Number(yanit.usage?.prompt_tokens ?? 0);
    sonuc.cikti_token += Number(yanit.usage?.completion_tokens ?? 0);
    const mesaj = yanit.choices?.[0]?.message ?? {};
    const icerik: string = typeof mesaj.content === "string" ? mesaj.content
      : Array.isArray(mesaj.content) ? mesaj.content.map((p: { text?: string }) => p?.text ?? "").join("") : "";
    const yerel: { id: string; ad: string; argumanlar: unknown }[] = (Array.isArray(mesaj.tool_calls) ? mesaj.tool_calls : [])
      .map((c: { id?: string; function?: { name?: string; arguments?: unknown } }, n: number) => ({
        id: String(c.id || `cagri_${tur}_${n}`), ad: String(c.function?.name ?? ""), argumanlar: c.function?.arguments,
      }));
    const metinden = yerel.length || !araclar.length ? [] : metindenCagrilar(icerik);

    if (!yerel.length && !metinden.length) {
      const metin = sonMetin(icerik);
      if (!metin) return bitir({ hata: "Model boş yanıt verdi" });
      return bitir({ ok: true, metin });
    }

    if (yerel.length) {
      mesajlar.push({ role: "assistant", content: icerik ?? "", tool_calls: yerel.map((c) => ({ id: c.id, type: "function", function: { name: c.ad, arguments: typeof c.argumanlar === "string" ? c.argumanlar : JSON.stringify(c.argumanlar ?? {}) } })) });
      for (const c of yerel) {
        let girdi: unknown = c.argumanlar;
        let s: { metin: string };
        if (typeof girdi === "string") {
          try { girdi = girdi.trim() ? JSON.parse(girdi) : {}; } catch { girdi = undefined; }
        }
        if (girdi === undefined) s = { metin: "Hata: araç argümanları JSON olarak okunamadı (yanıt kesilmiş olabilir; daha küçük parçalar halinde yaz)" };
        else s = await aracCalistir(baglam, c.ad, girdi);
        mesajlar.push({ role: "tool", tool_call_id: c.id, content: s.metin, arac_sonucu: true });
      }
    } else {
      // Sunucu araç çağrısını ayrıştırmadı: model metinle çağırdı, sonuçları da metinle ver
      mesajlar.push({ role: "assistant", content: icerik });
      const sonuclar: string[] = [];
      for (const c of metinden) sonuclar.push(`<tool_response>\n${(await aracCalistir(baglam, c.ad, c.girdi)).metin}\n</tool_response>`);
      mesajlar.push({ role: "user", content: sonuclar.join("\n"), arac_sonucu: true });
    }
  }
  return bitir({ hata: `Ajan ${b.en_fazla_tur} turda bitiremedi (araç çağırmayı sürdürdü)` });
}
