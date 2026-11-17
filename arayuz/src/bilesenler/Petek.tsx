// Petek şeridi: akışın aşamaları birbirine yapışık altıgen hücreler.
// Çalışan hücre balla dolar, seni bekleyen hücre bal rengidir, onaylanan hücre mumla sırlanır.
// Kilitlenen aşamada sırın altında küçük bir kilit görünür.
import { useId } from "react";
import type { AkisOzeti, AsamaDurumu, OnayRozeti } from "../api";
import { Altigen } from "./Simge";

export interface PetekHucresi {
  id: string;
  ad: string;
  tur: "ajan" | "insan";
  durum: AsamaDurumu;
  ajan: string;               // kısaltma
  ajan_ad: string;
  motor: string | null;
  kilitle: string[];
  en_fazla_tur: number;
  onaylar: OnayRozeti[];
}

/** Bir akışın boş (henüz çalışmamış) petek hücreleri: akış önizlemesi için. */
export function akisHucreleri(akis: AkisOzeti): PetekHucresi[] {
  return akis.asamalar.map((s) => ({
    id: s.id, ad: s.ad, tur: s.tur, durum: "bekleyen", ajan: s.ajan_kisa ?? "Sen", ajan_ad: s.ajan_ad ?? "Sen", motor: null,
    kilitle: s.kilitle, en_fazla_tur: s.en_fazla_tur,
    onaylar: s.dogrulama.map((d) => ({ ad: d.inceleyen_ad ? `${d.ad}, ${d.inceleyen_ad}` : d.ad, kisa: "", durum: null })),
  }));
}

const DIS = "50,2.5 97.8,30.1 97.8,85.4 50,113 2.2,85.4 2.2,30.1";
const SIR = "50,17 85,37.2 85,78.3 50,98.5 15,78.3 15,37.2";

const DURUM_ADI: Record<AsamaDurumu, string> = {
  tamam: "tamamlandı", atlandi: "atlandı", bekliyor: "kararını bekliyor", aktif: "çalışıyor",
  sirada: "sırada", durdu: "durduruldu", bekleyen: "henüz başlamadı",
};

export function onayTonu(durum: string | null): string {
  if (durum === "onay" || durum === "yesil") return "iyi";
  if (durum === "duzelt" || durum === "kirmizi" || durum === "hata" || durum === "takildi") return "kotu";
  if (durum === "soru") return "dikkat";
  if (durum === "calisiyor") return "calisan";
  return "bos";
}

const ONAY_ADI: Record<string, string> = {
  onay: "onayladı", yesil: "yeşil", duzelt: "düzeltme istedi", kirmizi: "kırmızı", soru: "soru sordu",
  hata: "hata", takildi: "süre doldu", calisiyor: "inceliyor",
};

interface Props {
  hucreler: PetekHucresi[];
  tur?: number;                // çalışan aşamanın turu
  ekTur?: number;
  yerelMi?: (motor: string) => boolean;
  odak?: string | null;
  onSec?: (asamaId: string) => void;
  etiket?: string;
}

export function Petek({ hucreler, tur, ekTur = 0, yerelMi = () => false, odak, onSec, etiket = "Aşamalar" }: Props) {
  const kimlik = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <ol className="petek" aria-label={etiket}>
      {hucreler.map((a, i) => {
        const kesit = `pk-${kimlik}-${i}`;
        const simdi = a.durum === "aktif" || a.durum === "bekliyor" || a.durum === "sirada" || a.durum === "durdu";
        const kilitli = a.durum === "tamam" && a.kilitle.length > 0;
        const motorTuru = !a.motor ? null : a.motor === "claude" ? "claude" : a.motor === "deneme" ? "deneme" : yerelMi(a.motor) ? "yerel" : "claude";
        const motorEtiketi = motorTuru === "claude" ? "Claude" : motorTuru === "yerel" ? `yerel model (${a.motor})` : motorTuru === "deneme" ? "deneme motoru" : "";
        const icerik = (
          <svg className="hucre-svg" viewBox="0 0 100 115.47" aria-hidden="true">
            <defs><clipPath id={kesit}><polygon points={DIS} /></clipPath></defs>
            <polygon className="hucre-zemin" points={DIS} />
            <g clipPath={`url(#${kesit})`}>
              <rect className="hucre-bal" x="0" y="0" width="100" height="115.47" />
            </g>
            {a.durum === "tamam" && <polygon className="hucre-sir" points={SIR} />}
            <polygon className="hucre-kenar" points={DIS} />
            {motorTuru && <circle className={`hucre-motor hucre-motor--${motorTuru}`} cx="50" cy="25" r="5.5" />}
            <text className="hucre-kisa" x="50" y={kilitli ? 58 : 64}>{a.tur === "insan" ? "Sen" : a.ajan}</text>
            {kilitli && (
              <g className="hucre-kilit" transform="translate(43.5 70) scale(0.55)">
                <rect x="1" y="9" width="22" height="15" rx="3" />
                <path d="M6 9V6.5a6 6 0 0 1 12 0V9" />
              </g>
            )}
          </svg>
        );
        const aciklama = `${a.ad}: ${DURUM_ADI[a.durum]}${a.tur === "insan" ? " (senin onayın)" : `, ${a.ajan_ad}`}${motorEtiketi ? `, ${motorEtiketi}` : ""}`;
        return (
          <li key={a.id} className={`hucre hucre--${a.durum}${odak === a.id ? " hucre--odak" : ""}`} aria-current={simdi ? "step" : undefined}>
            {onSec ? (
              <button type="button" className="hucre-dugme" onClick={() => onSec(a.id)} aria-label={aciklama} title={aciklama}>{icerik}</button>
            ) : (
              <div className="hucre-dugme" role="img" aria-label={aciklama} title={aciklama}>{icerik}</div>
            )}
            <div className="hucre-ad">{a.ad}</div>
            {simdi && a.tur === "ajan" && tur !== undefined && (
              <div className="hucre-tur">tur {tur}/{a.en_fazla_tur + ekTur}</div>
            )}
            {a.onaylar.length > 0 && (
              <div className="hucre-kurul">
                {a.onaylar.map((o) => (
                  <Altigen key={o.ad} ton={onayTonu(o.durum)} boyut={10} dolu={Boolean(o.durum)}
                    baslik={`${o.ad}: ${o.durum ? ONAY_ADI[o.durum] ?? o.durum : "henüz bakmadı"}`} />
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
