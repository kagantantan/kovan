// Ortak karar: ajan soruları önce ekipte oylanır. Oybirliği -> ekip kararı; anlaşmazlık, "insana bırak",
// okunamayan oy ya da para/hukuk gibi sahibine ait kararlar -> insana gelir.
import { describe, expect, it } from "vitest";
import type { AjanCagrisi, AjanSonucu, Motor } from "../src/motor.js";
import type { Ayarlar } from "../src/ayarlar.js";
import { BetikMotor, bekle, bekliyor, geciciKok, istemi, KISA_BRIF, kovanOlustur, oyCevabi, ORNEK_MINI, SahteMotor, soruBlogu } from "./yardimci/ortam.js";

type Betik = (c: AjanCagrisi) => Partial<AjanSonucu> | null;

async function kur(betik: Betik, ayar: Partial<Ayarlar> = {}, ekAkislar: Record<string, string> = {}) {
  const motorlar = new Map<string, Motor>([
    ["deneme", new BetikMotor("deneme", betik)],
    ["claude", new SahteMotor("claude")],
    ["qwen-yerel", new SahteMotor("qwen-yerel", true)],
  ]);
  return kovanOlustur({ kok: geciciKok({ "kisa-brif": KISA_BRIF, ...ekAkislar }), motorlar, ayar });
}

const oy = (rol: string, ...secim: (number | "insan")[]): Betik => (c) => (c.gorev_turu === "karar" && c.rol === rol ? oyCevabi(...secim) : null);

describe("Ortak karar", () => {
  it("oybirliği: karar ekibin olur, sana sorulmaz; defterde oylarıyla durur", async () => {
    const k = await kur(() => null);
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-brif", "deneme");
    const f = await bekle(k, fid, (x) => x.durum === "bekliyor");
    expect(f.bekleme!.sebep).toBe("insan");
    const d = k.ork.fikirDetayi(fid);
    expect(d.kararlar).toEqual([expect.objectContaining({ baslik: "Arayüz dili", cevap: "Türkçe", karar_veren: "ekip", kural: "oybirligi" })]);
    expect(d.kararlar[0].oylar!.map((o) => [o.kisa, o.secim[0], Boolean(o.soran)])).toEqual([["PO", "Türkçe", true], ["TKM", "Türkçe", false], ["ANLZ", "Türkçe", false]]);
    // Kurul üyeleri bağlamla ve seçenek numaralarıyla oy verdi; soran PO kendi sorusuna çağrılmadı
    const oyAdimlari = d.adimlar.filter((a) => a.tip === "oy");
    expect(oyAdimlari.map((a) => a.ajan)).toEqual(["mimar", "analist"]);
    const oyIstemi = istemi(k, fid, oyAdimlari[0].id);
    expect(oyIstemi).toContain("## Soru 1: Arayüz dili (soran: Ürün Sahibi)");
    expect(oyIstemi).toContain("1. Türkçe (Önerilen) — ");
    expect(oyIstemi).toContain("### fikir");
    expect(d.ajan_cagrisi).toBe(4);
  });

  it("anlaşmazlık: soru oylarla sana gelir; cevabın ekibin oylarıyla birlikte deftere girer", async () => {
    const k = await kur(oy("mimar", 2));
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-brif", "deneme");
    const f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    const s = f.bekleme!.sorular![0];
    expect(s.oylar!.map((o) => `${o.kisa}:${o.secim[0]}`)).toEqual(["PO:Türkçe", "TKM:İngilizce", "ANLZ:Türkçe"]);
    expect(s.neden).toBe("Ekip anlaşamadı: PO, ANLZ → Türkçe · TKM → İngilizce");
    k.ork.cevapla(fid, [{ secilenler: ["İki dilli (TR/EN)"] }]);
    await bekle(k, fid, bekliyor("insan"));
    const karar = k.ork.fikirDetayi(fid).kararlar[0];
    expect(karar).toMatchObject({ cevap: "İki dilli (TR/EN)", karar_veren: "insan" });
    expect(karar.oylar).toHaveLength(3);
  });

  it("çoğunluk kuralında 2'ye 1 ekip kararıdır", async () => {
    const k = await kur(oy("mimar", 2), { ortak_karar: { acik: true, kurul: ["urun-sahibi", "mimar", "analist"], kural: "cogunluk" } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-brif", "deneme");
    await bekle(k, fid, bekliyor("insan"));
    expect(k.ork.fikirDetayi(fid).kararlar[0]).toMatchObject({ cevap: "Türkçe", karar_veren: "ekip", kural: "cogunluk" });
  });

  it("bir üye kararı sahibine bırakırsa soru sana gelir", async () => {
    const k = await kur(oy("analist", "insan"));
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-brif", "deneme");
    const f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.sorular![0].neden).toMatch(/^Ekip kararı sana bıraktı: ANLZ/);
    expect(k.ork.fikirDetayi(fid).adimlar.find((a) => a.tip === "oy" && a.ajan === "analist")!.durum).toBe("insana");
  });

  it("oy okunamazsa güvenli tarafta kalır: soru sana gelir", async () => {
    const k = await kur((c) => (c.gorev_turu === "karar" && c.rol === "analist" ? { metin: "bence Türkçe" } : null));
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-brif", "deneme");
    const f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    const analist = f.bekleme!.sorular![0].oylar!.find((o) => o.kisa === "ANLZ")!;
    expect(analist).toMatchObject({ insana: true, secim: [] });
    expect(analist.gerekce).toMatch(/^Oy alınamadı/);
    expect(k.ork.fikirDetayi(fid).adimlar.filter((a) => a.tip === "oy" && a.ajan === "analist").map((a) => a.durum)).toEqual(["hata", "hata"]);
  });

  it('"insan": true sorusu (para, hukuk, geri dönüşsüz) ekibe uğramadan sana gelir', async () => {
    const k = await kur((c) => (c.rol === "urun-sahibi" && c.gorev_turu === "uret" && !c.istem.includes("### Premium fiyatı")
      ? soruBlogu([{ baslik: "Premium fiyatı", soru: "Premium aylık kaç TL olsun?", insan: true,
        secenekler: [{ etiket: "49 TL (Önerilen)", aciklama: "Rakiplerle aynı" }, { etiket: "99 TL", aciklama: "Daha az kullanıcı, daha çok gelir" }] }])
      : null));
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-brif", "deneme");
    const f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    const s = f.bekleme!.sorular![0];
    expect([s.baslik, s.insan, s.oylar]).toEqual(["Premium fiyatı", true, undefined]);
    expect(s.neden).toContain("yalnızca sen verebilirsin");
    expect(k.ork.fikirDetayi(fid).adimlar.some((a) => a.tip === "oy")).toBe(false);
  });

  it("ortak karar kapalıysa soru doğrudan sana gelir; istem ekipten söz etmez", async () => {
    const k = await kur(() => null, { ortak_karar: { acik: false, kurul: ["urun-sahibi", "mimar", "analist"], kural: "oybirligi" } });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-brif", "deneme");
    const f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.sorular![0].oylar).toBeUndefined();
    const sistem = (k.motorlar.get("deneme") as BetikMotor).cagrilar[0].sistem;
    expect(sistem).toContain("Soruların doğrudan projenin sahibine gider.");
    expect(sistem).not.toContain('"insan": true yalnızca');
  });

  it("soru hakkı dolduktan sonra gelen soru ekibe uğramadan sana gelir (başıboş döngü olmaz)", async () => {
    const k = await kur((c) => (c.rol === "urun-sahibi" && c.gorev_turu === "uret" && c.istem.includes("### Arayüz dili") && !c.istem.includes("### Tema")
      ? soruBlogu([{ baslik: "Tema", soru: "Renk teması?", secenekler: [{ etiket: "Yeşil (Önerilen)", aciklama: "-" }, { etiket: "Mavi", aciklama: "-" }] }])
      : null), { en_fazla_soru_turu: 1 });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-brif", "deneme");
    const f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.sorular![0].baslik).toBe("Tema");
    expect(f.bekleme!.sorular![0].neden).toContain("soru hakkı dolmuştu");
    expect(k.ork.fikirDetayi(fid).kararlar.map((x) => x.karar_veren)).toEqual(["ekip"]);
  });

  it("aynı turda ekip bir soruya karar verir, diğerini sorar; ikisi de deftere girer", async () => {
    const k = await kur((c) => {
      if (c.rol === "urun-sahibi" && c.gorev_turu === "uret" && !c.istem.includes("### Arayüz dili")) {
        return soruBlogu([
          { baslik: "Arayüz dili", soru: "Dil?", secenekler: [{ etiket: "Türkçe (Önerilen)", aciklama: "-" }, { etiket: "İngilizce", aciklama: "-" }] },
          { baslik: "Bildirim", soru: "Bildirim saati?", secenekler: [{ etiket: "Sabah (Önerilen)", aciklama: "-" }, { etiket: "Akşam", aciklama: "-" }] },
        ]);
      }
      if (c.gorev_turu === "karar") return oyCevabi(1, c.rol === "mimar" ? 2 : 1);
      return null;
    });
    const fid = await k.ork.yeniFikir("", ORNEK_MINI, "kisa-brif", "deneme");
    const f = await bekle(k, fid, bekliyor("ajan_sorusu"));
    expect(f.bekleme!.sorular!.map((s) => s.baslik)).toEqual(["Bildirim"]);
    expect(f.bekleme!.ekip_kararlari!.map((x) => `${x.baslik}:${x.cevap}`)).toEqual(["Arayüz dili:Türkçe"]);
    k.ork.cevapla(fid, [{ secilenler: ["Akşam"] }]);
    await bekle(k, fid, bekliyor("insan"));
    expect(k.ork.fikirDetayi(fid).kararlar.map((x) => `${x.baslik}:${x.karar_veren}`)).toEqual(["Arayüz dili:ekip", "Bildirim:insan"]);
  });
});
