// Satır içi SVG simgeler (dış dosya yok, CSP ile uyumlu). Renk currentColor'dan gelir.
import type { ReactElement } from "react";

const YOLLAR: Record<string, ReactElement> = {
  kalem: <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />,
  buyutec: <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></>,
  tup: <path d="M9 3h6M10 3v6.5L5.2 18a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3L14 9.5V3M7.5 15h9" />,
  disli: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></>,
  kilit: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  soru: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" /></>,
  zil: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0" />,
  zilKapali: <><path d="M6 16V11a6 6 0 0 1 9.3-5M18 11v5l1.5 2h-15M10 20.5a2 2 0 0 0 4 0" /><path d="M3 3l18 18" /></>,
  arti: <path d="M12 5v14M5 12h14" />,
  dur: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />,
  oynat: <path d="M8 5.5v13l10.5-6.5L8 5.5z" />,
  disari: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  klasor: <path d="M3.5 6.5a1 1 0 0 1 1-1h4.8l2 2h8.2a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />,
  cop: <><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" /><path d="M10 11v5.5M14 11v5.5" /></>,
  dosya: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  insan: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  uyari: <><path d="M12 3.5L2.5 20h19L12 3.5z" /><path d="M12 10v4.5M12 17.5h.01" /></>,
  tamam: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  geri: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  oy: <><path d="M4 13h16v7H4z" /><path d="M8 13V5h8v8M10.5 9l1.3 1.3L14 8" /></>,
  goz: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  sohbet: <path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H11l-4.5 3.5v-3.5h-2a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />,
  ekip: <><circle cx="8" cy="9" r="3" /><circle cx="16.5" cy="9" r="2.5" /><path d="M2.5 19a5.5 5.5 0 0 1 11 0M14 14.2a4.5 4.5 0 0 1 7 3.8" /></>,
};

export type SimgeAdi = keyof typeof YOLLAR;

export function Simge({ ad, boyut = 16, baslik }: { ad: SimgeAdi; boyut?: number; baslik?: string }) {
  return (
    <svg className="simge" width={boyut} height={boyut} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={baslik ? undefined : true} role={baslik ? "img" : undefined}>
      {baslik && <title>{baslik}</title>}
      {YOLLAR[ad]}
    </svg>
  );
}

/** Küçük altıgen durum işareti (fikir listesi, onay kurulu rozetleri). */
export function Altigen({ ton, boyut = 12, baslik, dolu = true }: { ton: string; boyut?: number; baslik?: string; dolu?: boolean }) {
  return (
    <svg className={`altigen altigen--${ton}${dolu ? "" : " altigen--bos"}`} width={boyut} height={boyut * 1.1547} viewBox="0 0 100 115.47"
      role={baslik ? "img" : undefined} aria-hidden={baslik ? undefined : true}>
      {baslik && <title>{baslik}</title>}
      <polygon points="50,4 96,30.6 96,84.9 50,111.5 4,84.9 4,30.6" />
    </svg>
  );
}
