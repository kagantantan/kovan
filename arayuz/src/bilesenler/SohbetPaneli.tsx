// Ajanlarla konuşma: belgesi yazılmış bir aşamanın ajanına ya da Büyük Birader'e soru sorarsın. Ajan yalnızca okur,
// hiçbir şeyi değiştirmez. Cevaptan çıkan sonucu "karara bağlarsan" deftere girer ve sonraki bütün ajanlar görür.
import { useEffect, useState } from "react";
import { api, type FikirDetayi, type SohbetMesaji } from "../api";
import { Markdown } from "./Markdown";
import { Simge } from "./Simge";

const anahtar = (h: { id: string; asama_id: string | null }) => `${h.id}@${h.asama_id ?? ""}`;

function Mesaj({ fikirId, m, onBitti }: { fikirId: string; m: SohbetMesaji; onBitti: () => void }) {
  const [bagla, setBagla] = useState(false);
  const [metin, setMetin] = useState("");
  const [hata, setHata] = useState<string | null>(null);
  const [gonderiliyor, setGonderiliyor] = useState(false);
  const kaydet = async () => {
    setGonderiliyor(true); setHata(null);
    try { await api.sohbetKarari(fikirId, m.id, metin.trim()); setBagla(false); onBitti(); }
    catch (e) { setHata((e as Error).message); }
    setGonderiliyor(false);
  };
  return (
    <li className={`sohbet-mesaj sohbet-mesaj--${m.durum}`}>
      <p className="sohbet-soru"><span className="sohbet-kim">Sen</span>{m.soru}</p>
      <div className="sohbet-cevap">
        <span className="sohbet-kim">{m.hedef_ad}</span>
        {m.durum === "bekliyor" ? <p className="bos-not">Cevap yazılıyor...</p>
          : m.durum === "tamam" ? <Markdown metin={m.cevap ?? ""} sinif="belge--kucuk" />
          : <p className="hata-satiri"><Simge ad="uyari" /> {m.cevap}</p>}
      </div>
      {m.durum === "tamam" && (m.karar ? (
        <p className="sohbet-karar"><Simge ad="tamam" /> Karara bağlandı: {m.karar}</p>
      ) : bagla ? (
        <div className="sohbet-bagla">
          <label className="alan">
            <span className="alan-ad">Karar<span className="alan-ipucu"> bir cümleyle; deftere "senin kararın" olarak girer, sonraki bütün ajanlar görür</span></span>
            <input type="text" value={metin} onChange={(e) => setMetin(e.target.value)} maxLength={500} autoFocus
              placeholder="ör. Veri ilk sürümde tarayıcıda kalsın; depolama bir arayüzün arkasında olsun." />
          </label>
          {hata && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {hata}</p>}
          <div className="sohbet-dugmeler">
            <button type="button" className="dugme dugme--birincil dugme--kucuk" disabled={!metin.trim() || gonderiliyor} onClick={kaydet}>Deftere yaz</button>
            <button type="button" className="dugme dugme--sessiz dugme--kucuk" onClick={() => setBagla(false)}>Vazgeç</button>
          </div>
        </div>
      ) : (
        <button type="button" className="dugme dugme--ikincil dugme--kucuk" onClick={() => setBagla(true)}>Karara bağla</button>
      ))}
    </li>
  );
}

export function SohbetPaneli({ fikirId, detay, onBitti }: { fikirId: string; detay: FikirDetayi; onBitti: () => void }) {
  const hedefler = detay.sohbet_hedefleri;
  const calisan = detay.fikir.durum === "calisiyor" || detay.fikir.durum === "sirada";
  const bekleyen = detay.sohbet.some((m) => m.durum === "bekliyor");
  // Varsayılan: kararını bekleyen aşamanın ajanı; yoksa belgesi yazılmış son aşamanın ajanı
  const varsayilan = hedefler.find((h) => h.asama_id && h.asama_id === detay.bekleme?.asama_id) ?? hedefler.filter((h) => h.asama_id).at(-1) ?? hedefler[0];
  const [secili, setSecili] = useState(varsayilan ? anahtar(varsayilan) : "");
  const [soru, setSoru] = useState("");
  const [hata, setHata] = useState<string | null>(null);
  const [gonderiliyor, setGonderiliyor] = useState(false);
  const [acik, setAcik] = useState(detay.sohbet.length > 0);
  useEffect(() => {
    if (!hedefler.some((h) => anahtar(h) === secili) && varsayilan) setSecili(anahtar(varsayilan));
  }, [hedefler.map(anahtar).join(), secili]);
  if (!hedefler.length) return null;

  const hedef = hedefler.find((h) => anahtar(h) === secili) ?? varsayilan!;
  const gonder = async () => {
    setGonderiliyor(true); setHata(null);
    try {
      // Büyük Birader'e sorulurken bağlam, o an bakılan aşamadır
      await api.sor(fikirId, hedef.id, hedef.asama_id ?? detay.bekleme?.asama_id ?? null, soru.trim());
      setSoru("");
      onBitti();
    } catch (e) { setHata((e as Error).message); }
    setGonderiliyor(false);
  };
  const neden = calisan ? "Fikir çalışırken soru sorulamaz; aşama bitince ya da fikri durdurunca sor."
    : bekleyen ? "Önceki sorunun cevabı bekleniyor." : null;

  return (
    <details className="sohbet" open={acik} onToggle={(e) => setAcik(e.currentTarget.open)}>
      <summary className="sohbet-ust"><Simge ad="sohbet" /> Ajanlarla konuş<span className="alan-ipucu"> soru sor, cevap al; ajan hiçbir şeyi değiştirmez</span>
        {detay.sohbet.length > 0 && <span className="sekme-sayi">{detay.sohbet.length}</span>}
      </summary>
      {detay.sohbet.length > 0 && (
        <ol className="sohbet-liste">
          {detay.sohbet.map((m) => <Mesaj key={m.id} fikirId={fikirId} m={m} onBitti={onBitti} />)}
        </ol>
      )}
      <form className="sohbet-form" onSubmit={(e) => { e.preventDefault(); if (soru.trim() && !neden && !gonderiliyor) void gonder(); }}>
        <label className="alan alan--satir">
          <span className="alan-ad">Kime</span>
          <select value={secili} onChange={(e) => setSecili(e.target.value)}>
            {hedefler.map((h) => <option key={anahtar(h)} value={anahtar(h)}>{h.asama_ad ? `${h.ad} · ${h.asama_ad}` : `${h.ad} · işin tamamı`}</option>)}
          </select>
        </label>
        <label className="alan">
          <span className="alan-ad">Sorun</span>
          <textarea rows={2} value={soru} onChange={(e) => setSoru(e.target.value)} maxLength={4000} disabled={Boolean(neden)}
            placeholder={hedef.asama_id ? "ör. Bunu neden böyle seçtin, öbür yol neye mal olurdu?" : "ör. Bu iş nereye gidiyor, en büyük risk ne?"} />
        </label>
        {hata && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {hata}</p>}
        <div className="sohbet-dugmeler">
          <button type="submit" className="dugme dugme--ikincil" disabled={!soru.trim() || Boolean(neden) || gonderiliyor}>{gonderiliyor ? "Gönderiliyor..." : "Sor"}</button>
          {neden && <span className="alan-ipucu">{neden}</span>}
        </div>
      </form>
    </details>
  );
}
