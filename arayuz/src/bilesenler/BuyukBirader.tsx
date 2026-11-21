// Büyük Birader: petek şeridinin tepesindeki göz. Her aşamanın sonunda işin tamamına bakar; rengi son hükmünü
// gösterir (uygun, dikkat, veto), bakışı o anki aşamaya döner, değerlendirme yaparken göz kırpar.
// Tıklanınca aşama aşama değerlendirmeleri açılır.
import { useState } from "react";
import type { BiraderDegerlendirmesi } from "../api";
import { HUKUM_ADI, HUKUM_TONU } from "../bicim";

/** bakis: -1 (en soldaki aşama) ile 1 (en sağdaki) arası; göz bebeği o yöne kayar. */
export function Goz({ ton = "bos", bakis = 0, bakiyor = false, boyut = 132 }: { ton?: string; bakis?: number; bakiyor?: boolean; boyut?: number }) {
  const kayma = Math.max(-1, Math.min(1, bakis)) * 15;
  return (
    <svg className={`goz goz--${ton}${bakiyor ? " goz--bakiyor" : ""}`} width={boyut} height={boyut * 0.55} viewBox="0 0 120 66" aria-hidden="true">
      <path className="goz-ak" d="M4 33 Q60 -9 116 33 Q60 75 4 33 Z" />
      <g className="goz-bebek" style={{ transform: `translateX(${kayma}px)` }}>
        <circle className="goz-iris" cx="60" cy="33" r="18" />
        <circle className="goz-merkez" cx="60" cy="33" r="7.5" />
        <circle className="goz-isik" cx="54.5" cy="27.5" r="3" />
      </g>
      <path className="goz-kapak" d="M4 33 Q60 -9 116 33 Q60 75 4 33 Z" />
    </svg>
  );
}

/** Bir değerlendirme: hüküm, özet, bulgular (kanıtıyla) ve öneri. Kapı kartında ve panelde aynı görünür. */
export function BiraderHukmu({ d, baslik = true }: { d: BiraderDegerlendirmesi; baslik?: boolean }) {
  return (
    <div className={`hukum hukum--${HUKUM_TONU[d.hukum]}`}>
      <div className="hukum-ust">
        {baslik && <span className="hukum-asama">{d.asama_ad}<span className="olcu-ek">, tur {d.tur}</span></span>}
        <span className={`rozet rozet--${d.hukum === "UYGUN" ? "iyi" : d.hukum === "VETO" ? "kotu" : "dikkat"}`}>{HUKUM_ADI[d.hukum]}</span>
        {d.dusuruldu && <span className="alan-ipucu">kanıtsız veto, düşürüldü</span>}
      </div>
      {d.ozet && <p className="hukum-ozet">{d.ozet}</p>}
      {d.bulgular.length > 0 && (
        <ul className="hukum-bulgular">
          {d.bulgular.map((b, i) => (
            <li key={i}><b>{b.konu}:</b> {b.aciklama}{b.kanit && <span className="hukum-kanit"> Kanıt: {b.kanit}</span>}</li>
          ))}
        </ul>
      )}
      {d.oneri && <p className="hukum-oneri"><b>Öneri:</b> {d.oneri}</p>}
    </div>
  );
}

interface Props {
  degerlendirmeler: BiraderDegerlendirmesi[];
  bakiyor: boolean;        // şu an bir aşamayı değerlendiriyor
  bakis: number;           // o anki aşamanın şeritteki yeri (-1..1)
}

export function BuyukBirader({ degerlendirmeler, bakiyor, bakis }: Props) {
  const [acik, setAcik] = useState(false);
  const son = degerlendirmeler.at(-1) ?? null;
  const ton = son ? HUKUM_TONU[son.hukum] : "bos";
  const sayi = (h: string) => degerlendirmeler.filter((d) => d.hukum === h).length;
  const durum = bakiyor ? "Büyük Birader bakıyor" : "Büyük Birader izliyor";
  return (
    <section className={`birader birader--${ton}`} aria-label="Büyük Birader">
      <button type="button" className="birader-goz" onClick={() => setAcik((a) => !a)} aria-expanded={acik}
        title={acik ? "Değerlendirmeleri kapat" : "Aşama aşama değerlendirmeleri aç"}>
        <Goz ton={ton} bakis={bakis} bakiyor={bakiyor} />
        <span className="birader-ad">{durum}</span>
      </button>
      <p className="birader-son">
        {son
          ? <><b>{son.asama_ad}:</b> <span className={`birader-hukum birader-hukum--${ton}`}>{HUKUM_ADI[son.hukum]}</span>{son.ozet ? `. ${son.ozet}` : ""}</>
          : "Her aşamanın sonunda işin tamamına bakar: kapsamdan sapma, kararlarla çelişki, uydurma iddia. Beğenmediğini veto eder."}
      </p>
      {degerlendirmeler.length > 0 && (
        <p className="birader-sayac">
          {degerlendirmeler.length} değerlendirme: {sayi("UYGUN")} uygun, {sayi("DIKKAT")} dikkat, {sayi("VETO")} veto
          {!acik && <> · <button type="button" className="dugme--baglanti" onClick={() => setAcik(true)}>hepsini gör</button></>}
        </p>
      )}
      {acik && (
        <div className="birader-panel">
          {degerlendirmeler.length
            ? [...degerlendirmeler].reverse().map((d, i) => <BiraderHukmu key={`${d.asama_id}-${d.tur}-${i}`} d={d} />)
            : <p className="bos-not">Henüz bir aşama bitmedi.</p>}
        </div>
      )}
    </section>
  );
}
