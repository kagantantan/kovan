// Açıklamalı seçenek satırı: gerçek radio/checkbox, klavyeyle de seçilir.
import type { ReactNode } from "react";

interface Props {
  grup: string;
  tip: "radio" | "checkbox";
  secili: boolean;
  onDegis: (secili: boolean) => void;
  etiket: string;
  aciklama?: string;
  onerilen?: boolean;
  tehlikeli?: boolean;
  children?: ReactNode;
}

export function Secenek({ grup, tip, secili, onDegis, etiket, aciklama, onerilen, tehlikeli, children }: Props) {
  return (
    <label className={`secenek${secili ? " secenek--secili" : ""}${tehlikeli ? " secenek--tehlikeli" : ""}`}>
      <input className="secenek-girdi" type={tip} name={grup} checked={secili} onChange={(e) => onDegis(e.target.checked)} />
      <span className={`secenek-isaret secenek-isaret--${tip}`} aria-hidden="true" />
      <span className="secenek-govde">
        <span className="secenek-etiket">
          {etiket}
          {onerilen && <span className="rozet rozet--oneri">Önerilen</span>}
        </span>
        {aciklama && <span className="secenek-aciklama">{aciklama}</span>}
        {children}
      </span>
    </label>
  );
}
