// Ajan soruları: her soru kısa bir başlık, net bir soru ve açıklamalı seçeneklerle gelir.
// Önerilen seçenek ilk sıradadır; her zaman kendi cevabını da yazabilirsin.
import { useState } from "react";
import { api, type Bekleme } from "../api";
import { onerilenAyir } from "../bicim";
import { Markdown } from "./Markdown";
import { Secenek } from "./Secenek";
import { Simge } from "./Simge";

interface Durum {
  secilenler: string[];
  serbest: string;
}

export function SoruPaneli({ fikirId, bekleme, onBitti }: { fikirId: string; bekleme: Bekleme; onBitti: () => void }) {
  const sorular = bekleme.sorular ?? [];
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

  const durdur = async () => {
    setGonderiliyor(true);
    try { await api.karar(fikirId, "durdur", ""); onBitti(); }
    catch (e) { setHata((e as Error).message); setGonderiliyor(false); }
  };

  const kimler = [...new Set(sorular.map((s) => s.soran_ad))];
  const sonra = bekleme.kaynak === "inceleme"
    ? "Cevabından sonra üretici ajan kararını ve aynı turdaki bulguları işler, onay kurulu yeniden bakar."
    : "Cevabından sonra aynı ajan, kararını bilerek işine devam eder.";

  return (
    <section className="yuva yuva--soru" aria-labelledby="yuva-baslik">
      <header className="yuva-ust">
        <h2 id="yuva-baslik" className="yuva-baslik">{kimler.join(" ve ")} {sorular.length > 1 ? "kararını soruyor" : "soruyor"}</h2>
        {bekleme.asama_ad && <span className="yuva-asama">{bekleme.asama_ad} aşaması</span>}
      </header>
      <p className="yuva-mesaj">{sonra} Kararın karar defterine yazılır; sonraki bütün ajanlar görür.</p>

      {bekleme.detay && (
        <details className="yuva-detay">
          <summary>Aynı turdaki diğer bulgular</summary>
          <Markdown metin={bekleme.detay} sinif="belge--kucuk" />
        </details>
      )}

      {sorular.map((s, i) => {
        const d = cevaplar[i];
        const grup = `soru-${bekleme.adim_id}-${i}`;
        return (
          <fieldset key={grup} className="soru" disabled={gonderiliyor}>
            <legend className="soru-ust">
              <span className="soru-cip">{s.baslik}</span>
              <span className="soru-kim">{s.soran_ad}{s.coklu ? ", birden çok seçebilirsin" : ""}</span>
            </legend>
            <p className="soru-metni">{s.soru}</p>
            <div className="secenekler">
              {s.secenekler.map((o) => {
                const { metin, onerilen } = onerilenAyir(o.etiket);
                const secili = d.secilenler.includes(metin);
                return (
                  <Secenek key={o.etiket} grup={grup} tip={s.coklu ? "checkbox" : "radio"} secili={secili}
                    etiket={metin} aciklama={o.aciklama} onerilen={onerilen}
                    onDegis={(acik) => guncelle(i, (x) => ({
                      ...x,
                      secilenler: s.coklu ? (acik ? [...x.secilenler, metin] : x.secilenler.filter((y) => y !== metin)) : [metin],
                    }))} />
                );
              })}
            </div>
            <label className="alan soru-serbest">
              <span className="alan-ad">Kendi cevabın<span className="alan-ipucu"> ya da seçimine ek not</span></span>
              <input type="text" value={d.serbest} onChange={(e) => guncelle(i, (x) => ({ ...x, serbest: e.target.value }))}
                placeholder={d.secilenler.length ? "İstersen bir not ekle" : "Seçeneklerin hiçbiri uymuyorsa buraya yaz"} />
            </label>
          </fieldset>
        );
      })}

      {hata && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {hata}</p>}

      <div className="yuva-alt">
        <button type="button" className="dugme dugme--birincil" disabled={!hepsi || gonderiliyor} onClick={gonder}>
          {gonderiliyor ? "Gönderiliyor..." : sorular.length > 1 ? "Cevapları gönder" : "Cevabı gönder"}
        </button>
        {sorular.length > 1 && <span className="alan-ipucu">{sayi}/{sorular.length} soru cevaplandı</span>}
        <button type="button" className="dugme dugme--sessiz dugme--sag" disabled={gonderiliyor} onClick={durdur}>Fikri durdur</button>
      </div>
    </section>
  );
}
