// Sistem kararları: teslim, tur sınırı, hata, bütçe, kesinti. Seçenekler açıklamalı, önerilen ilk sırada.
import { useState } from "react";
import { api, type Bekleme } from "../api";
import { BEKLEME_BASLIGI } from "../bicim";
import { Markdown } from "./Markdown";
import { Secenek } from "./Secenek";
import { Simge } from "./Simge";

function notYeri(secim: string): string {
  switch (secim) {
    case "geri_gonder": return "Ajan bu notu düzeltme isteği olarak görür.";
    case "bir_tur_daha": case "claude_devral": case "tekrar_dene": return "Ajan bir sonraki denemede bu notu görür.";
    case "durdur": return "Neden durdurduğunu yazabilirsin; kayda geçer.";
    default: return "Notun zaman çizelgesine kayda geçer.";
  }
}

export function KararPaneli({ fikirId, bekleme, onBitti }: { fikirId: string; bekleme: Bekleme; onBitti: () => void }) {
  const baslangic = bekleme.secenekler.find((s) => s.onerilen) ?? bekleme.secenekler[0];
  const [secim, setSecim] = useState(baslangic?.anahtar ?? "");
  const [not, setNot] = useState("");
  const [hedef, setHedef] = useState(bekleme.varsayilan_hedef ?? bekleme.geri_hedefler?.at(-1)?.id ?? "");
  const [gonderiliyor, setGonderiliyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);

  const secili = bekleme.secenekler.find((s) => s.anahtar === secim);
  const geriGonder = secim === "geri_gonder";
  const notZorunlu = geriGonder;
  const hazir = Boolean(secili) && !gonderiliyor && (!notZorunlu || not.trim().length > 0);

  const gonder = async () => {
    if (!secili) return;
    setGonderiliyor(true);
    setHata(null);
    try {
      await api.karar(fikirId, secili.anahtar, not.trim(), geriGonder ? hedef : null);
      onBitti();
    } catch (e) {
      setHata((e as Error).message);
      setGonderiliyor(false);
    }
  };

  return (
    <section className="yuva" aria-labelledby="yuva-baslik">
      <header className="yuva-ust">
        <h2 id="yuva-baslik" className="yuva-baslik">{BEKLEME_BASLIGI[bekleme.sebep]}</h2>
        {bekleme.asama_ad && <span className="yuva-asama">{bekleme.asama_ad} aşaması</span>}
      </header>
      <p className="yuva-mesaj">{bekleme.mesaj}</p>

      {bekleme.detay && (
        <details className="yuva-detay" open={bekleme.sebep === "tur_siniri" || bekleme.sebep === "insan"}>
          <summary>{bekleme.sebep === "insan" ? "Teslim özeti" : bekleme.sebep === "tur_siniri" ? "Onaycıların bulguları" : "Ayrıntı"}</summary>
          {bekleme.sebep === "tur_siniri" ? <Markdown metin={bekleme.detay} sinif="belge--kucuk" />
            : bekleme.sebep === "insan" ? <p className="yuva-ozet">{bekleme.detay}</p>
            : <pre className="kod kod--kucuk">{bekleme.detay}</pre>}
        </details>
      )}

      <fieldset className="secenekler" disabled={gonderiliyor}>
        <legend className="gizli">Kararın</legend>
        {bekleme.secenekler.map((s) => (
          <Secenek key={s.anahtar} grup={`karar-${bekleme.adim_id}`} tip="radio" secili={secim === s.anahtar} onDegis={() => setSecim(s.anahtar)}
            etiket={s.etiket} aciklama={s.aciklama} onerilen={s.onerilen} tehlikeli={s.tehlikeli} />
        ))}
      </fieldset>

      {geriGonder && bekleme.geri_hedefler && bekleme.geri_hedefler.length > 0 && (
        <label className="alan alan--satir">
          <span className="alan-ad">Hangi aşamaya</span>
          <select value={hedef} onChange={(e) => setHedef(e.target.value)} disabled={gonderiliyor}>
            {bekleme.geri_hedefler.map((h) => <option key={h.id} value={h.id}>{h.ad}</option>)}
          </select>
        </label>
      )}

      <label className="alan">
        <span className="alan-ad">{notZorunlu ? "Ne değişsin?" : "Not"}{!notZorunlu && <span className="alan-ipucu"> isteğe bağlı</span>}</span>
        <textarea rows={notZorunlu ? 3 : 2} value={not} onChange={(e) => setNot(e.target.value)} disabled={gonderiliyor}
          placeholder={notYeri(secim)} />
      </label>

      {hata && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {hata}</p>}

      <div className="yuva-alt">
        <button type="button" className={`dugme ${secili?.tehlikeli ? "dugme--tehlikeli" : "dugme--birincil"}`} disabled={!hazir} onClick={gonder}>
          {gonderiliyor ? "Gönderiliyor..." : secili?.etiket ?? "Seç"}
        </button>
        {notZorunlu && !not.trim() && <span className="alan-ipucu">Geri göndermek için ne istediğini yaz.</span>}
      </div>
    </section>
  );
}
