// Ajan soruları: her soru kısa bir başlık, net bir soru ve açıklamalı seçeneklerle gelir.
// Soru önce ekipte oylanır; sana geldiyse ya ekip anlaşamamıştır (oylar seçeneklerin yanında görünür)
// ya da karar yalnızca senin verebileceğin türdendir. Gelişim önerileri de bu panelde "olmalı mı?" diye gelir.
import { useState } from "react";
import { api, type AjanSorusu, type Bekleme, type Oy } from "../api";
import { onerilenAyir } from "../bicim";
import { Markdown } from "./Markdown";
import { Secenek } from "./Secenek";
import { Simge } from "./Simge";

interface Durum {
  secilenler: string[];
  serbest: string;
}

/** Soru neden sana geldi: tek satır, insan diliyle. */
function neden(s: AjanSorusu): string | null {
  if (!s.oylar?.length) return s.neden ?? null;
  if (s.oylar.some((o) => o.insana)) return s.neden ?? null;
  return "Ekip anlaşamadı; kimin neyi seçtiği seçeneklerin yanında.";
}

function OyCipleri({ oylar }: { oylar: Oy[] }) {
  if (!oylar.length) return null;
  return (
    <span className="oy-cipleri">
      <span className="oy-etiket">oy</span>
      {oylar.map((o) => (
        <span key={o.ajan} className={`oy-cip${o.soran ? " oy-cip--soran" : ""}`} title={`${o.ajan_ad}${o.soran ? " (soruyu soran)" : ""}: ${o.gerekce}`}>
          {o.kisa}
        </span>
      ))}
    </span>
  );
}

export function SoruPaneli({ fikirId, bekleme, onBitti }: { fikirId: string; bekleme: Bekleme; onBitti: () => void }) {
  const sorular = bekleme.sorular ?? [];
  const gelisim = bekleme.kaynak === "gelisim";
  const [cevaplar, setCevaplar] = useState<Durum[]>(() => sorular.map(() => ({ secilenler: [], serbest: "" })));
  const [gonderiliyor, setGonderiliyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);

  const guncelle = (i: number, f: (d: Durum) => Durum) => setCevaplar((liste) => liste.map((d, j) => (j === i ? f(d) : d)));
  const cevaplandi = (d: Durum) => d.secilenler.length > 0 || d.serbest.trim().length > 0;
  const sayi = cevaplar.filter(cevaplandi).length;
  const hepsi = sayi === sorular.length;

  const gonder = async () => {
    setGonderiliyor(true);
    setHata(null);
    try {
      await api.cevap(fikirId, cevaplar.map((d) => ({ secilenler: d.secilenler, serbest: d.serbest.trim() })));
      onBitti();
    } catch (e) {
      setHata((e as Error).message);
      setGonderiliyor(false);
    }
  };

  const karar = async (secim: string) => {
    setGonderiliyor(true);
    try { await api.karar(fikirId, secim, ""); onBitti(); }
    catch (e) { setHata((e as Error).message); setGonderiliyor(false); }
  };

  const kimler = [...new Set(sorular.map((s) => s.soran_ad))];
  const baslik = gelisim
    ? `${kimler.join(" ve ")} ${sorular.length} gelişim önerisi getirdi`
    : `${kimler.join(" ve ")} ${sorular.length > 1 ? "kararını soruyor" : "soruyor"}`;
  const sonra = gelisim
    ? "Her öneri için karar ver: sence bu özellik olmalı mı? Notun önerinin nasıl ele alınacağını belirler. Kararların gelişim defterine yazılır; kabul ettiklerinle yeni sürümü başlatabilirsin."
    : (bekleme.kaynak === "inceleme"
      ? "Cevabından sonra üretici ajan kararını ve aynı turdaki bulguları işler, onay kurulu yeniden bakar."
      : "Cevabından sonra aynı ajan, kararını bilerek işine devam eder.") + " Kararın karar defterine yazılır; sonraki bütün ajanlar görür.";

  return (
    <section className={`yuva yuva--soru${gelisim ? " yuva--gelisim" : ""}`} aria-labelledby="yuva-baslik">
      <header className="yuva-ust">
        <h2 id="yuva-baslik" className="yuva-baslik">{baslik}</h2>
        {bekleme.asama_ad && <span className="yuva-asama">{bekleme.asama_ad} aşaması</span>}
      </header>
      <p className="yuva-mesaj">{sonra}</p>

      {bekleme.ekip_kararlari && bekleme.ekip_kararlari.length > 0 && (
        <p className="ekip-karari-not">
          <Simge ad="tamam" /> Aynı turda ekip şunlara kendisi karar verdi:{" "}
          {bekleme.ekip_kararlari.map((k) => `${k.baslik}: ${k.cevap}`).join("; ")}.
        </p>
      )}

      {bekleme.detay && (
        <details className="yuva-detay">
          <summary>Aynı turdaki diğer bulgular</summary>
          <Markdown metin={bekleme.detay} sinif="belge--kucuk" />
        </details>
      )}

      {sorular.map((s, i) => {
        const d = cevaplar[i];
        const grup = `soru-${bekleme.adim_id}-${i}`;
        const sebep = neden(s);
        const oylar = s.oylar ?? [];
        return (
          <fieldset key={grup} className="soru" disabled={gonderiliyor}>
            <legend className="soru-ust">
              <span className="soru-cip">{gelisim && s.oneri_id ? `${s.oneri_id} ${s.baslik}` : s.baslik}</span>
              <span className="soru-kim">{s.soran_ad}{s.coklu ? ", birden çok seçebilirsin" : ""}</span>
            </legend>
            <p className="soru-metni">{s.soru}</p>
            {sebep && !gelisim && <p className="soru-neden"><Simge ad={oylar.length ? "insan" : "uyari"} /> {sebep}</p>}
            <div className={`secenekler${gelisim ? " secenekler--izgara" : ""}`}>
              {s.secenekler.map((o) => {
                const { metin, onerilen } = onerilenAyir(o.etiket);
                const secili = d.secilenler.includes(metin);
                return (
                  <Secenek key={o.etiket} grup={grup} tip={s.coklu ? "checkbox" : "radio"} secili={secili}
                    etiket={metin} aciklama={o.aciklama} onerilen={onerilen}
                    onDegis={(acik) => guncelle(i, (x) => ({
                      ...x,
                      secilenler: s.coklu ? (acik ? [...x.secilenler, metin] : x.secilenler.filter((y) => y !== metin)) : [metin],
                    }))}>
                    <OyCipleri oylar={oylar.filter((v) => v.secim.includes(metin))} />
                  </Secenek>
                );
              })}
            </div>
            {oylar.length > 0 && (
              <details className="oy-gerekce">
                <summary>Ekibin gerekçeleri</summary>
                <ul>
                  {oylar.map((o) => (
                    <li key={o.ajan}>
                      <b>{o.ajan_ad}</b>{o.soran ? " (soran)" : ""}: {o.insana ? "kararı sana bıraktı" : o.secim.join(", ")}
                      {o.gerekce && !o.soran ? <span className="oy-gerekce-metin">. {o.gerekce}</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <label className="alan soru-serbest">
              <span className="alan-ad">{gelisim ? "Yorumun" : "Kendi cevabın"}<span className="alan-ipucu">{gelisim ? " (ne değişsin, neden)" : " ya da seçimine ek not"}</span></span>
              <input type="text" value={d.serbest} onChange={(e) => guncelle(i, (x) => ({ ...x, serbest: e.target.value }))}
                placeholder={gelisim ? "Ör. yalnızca balkon bitkileri için olsun" : d.secilenler.length ? "İstersen bir not ekle" : "Seçeneklerin hiçbiri uymuyorsa buraya yaz"} />
            </label>
          </fieldset>
        );
      })}

      {hata && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {hata}</p>}

      <div className="yuva-alt">
        <button type="button" className="dugme dugme--birincil" disabled={!hepsi || gonderiliyor} onClick={gonder}>
          {gonderiliyor ? "Gönderiliyor..." : gelisim ? "Kararlarımı gönder" : sorular.length > 1 ? "Cevapları gönder" : "Cevabı gönder"}
        </button>
        {sorular.length > 1 && <span className="alan-ipucu">{sayi}/{sorular.length} {gelisim ? "öneri" : "soru"} cevaplandı</span>}
        {gelisim
          ? <button type="button" className="dugme dugme--sessiz dugme--sag" disabled={gonderiliyor} onClick={() => karar("atla")}>Şimdi değerlendirmeyeceğim</button>
          : <button type="button" className="dugme dugme--sessiz dugme--sag" disabled={gonderiliyor} onClick={() => karar("durdur")}>Fikri durdur</button>}
      </div>
    </section>
  );
}
