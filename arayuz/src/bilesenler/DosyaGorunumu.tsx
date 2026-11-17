// Fikrin dosyaları: ajanların belgeleri, onay kurulu incelemeleri, kod ve karar defteri.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, onizlemeAdresi, type Adim, type FikirDetayi } from "../api";
import { adimDurumu, boyut, zaman } from "../bicim";
import { useYokla } from "../kullan";
import { Markdown } from "./Markdown";
import { Simge } from "./Simge";

type Sekme = "belgeler" | "incelemeler" | "kod" | "kararlar";

const BELGE_ADI: Record<string, string> = {
  fikir: "Fikir metni", brif: "Brif", analiz: "Analiz", "ux-ozeti": "UX özeti", "teknik-plan": "Teknik plan",
  "test-senaryolari": "Test senaryoları", "test-ozeti": "Test özeti", "be-notu": "Backend notu", "fe-notu": "Frontend notu",
  kararlar: "Kararların",
};
const BELGE_SIRASI = Object.keys(BELGE_ADI);

const belgeAnahtari = (yol: string) => yol.replace(/^belgeler\//, "").replace(/\.md$/, "");
const sekmesi = (yol: string): Sekme | null =>
  yol.startsWith("belgeler/") ? "belgeler" : yol.startsWith("incelemeler/") ? "incelemeler" : yol.startsWith("kod/") ? "kod" : null;

/** incelemeler/analiz-tur1-urun-sahibi-adim5.md -> parçalar */
function incelemeCoz(yol: string) {
  const m = /^incelemeler\/(.+?)-tur(\d+)-(.+)-adim(\d+)\.md$/.exec(yol);
  return m ? { asama: m[1], tur: Number(m[2]), ajan: m[3], adim: Number(m[4]) } : null;
}

interface Props {
  fikirId: string;
  detay: FikirDetayi;
  secili: string | null;
  onSec: (yol: string) => void;
  ajanAdlari: Map<string, string>;
  canli: boolean;
}

export function DosyaGorunumu({ fikirId, detay, secili, onSec, ajanAdlari, canli }: Props) {
  const [sekme, setSekme] = useState<Sekme>(() => (secili && sekmesi(secili)) || "belgeler");
  useEffect(() => {
    const s = secili ? sekmesi(secili) : null;
    if (s) setSekme(s);
  }, [secili]);

  const asamaAdlari = useMemo(() => new Map(detay.asamalar.map((a) => [a.id, a.ad])), [detay.asamalar]);
  const adimlar = useMemo(() => new Map<number, Adim>(detay.adimlar.map((a) => [a.id, a])), [detay.adimlar]);
  const { belgeler, incelemeler, kod } = detay.dosyalar;

  const sekmeler: { id: Sekme; ad: string; sayi: number }[] = [
    { id: "belgeler", ad: "Belgeler", sayi: belgeler.length },
    { id: "incelemeler", ad: "İncelemeler", sayi: incelemeler.length },
    { id: "kod", ad: "Kod", sayi: kod.length },
    ...(detay.kararlar.length ? [{ id: "kararlar" as Sekme, ad: "Kararların", sayi: detay.kararlar.length }] : []),
  ];

  const siraliBelgeler = [...belgeler].sort((a, b) => {
    const ia = BELGE_SIRASI.indexOf(belgeAnahtari(a.yol));
    const ib = BELGE_SIRASI.indexOf(belgeAnahtari(b.yol));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.yol.localeCompare(b.yol);
  });

  // İncelemeler: aşama ve tura göre
  const incelemeGruplari = useMemo(() => {
    const gruplar = new Map<string, { baslik: string; ogeler: { yol: string; ad: string; adim?: Adim }[] }>();
    for (const d of incelemeler) {
      const c = incelemeCoz(d.yol);
      const anahtar = c ? `${c.asama}#${c.tur}` : "diger";
      const baslik = c ? `${asamaAdlari.get(c.asama) ?? c.asama}, tur ${c.tur}` : "Diğer";
      if (!gruplar.has(anahtar)) gruplar.set(anahtar, { baslik, ogeler: [] });
      gruplar.get(anahtar)!.ogeler.push({ yol: d.yol, ad: c ? ajanAdlari.get(c.ajan) ?? c.ajan : d.yol, adim: c ? adimlar.get(c.adim) : undefined });
    }
    const sira = detay.asamalar.map((a) => a.id);
    return [...gruplar.entries()].sort(([a], [b]) => {
      const [aa, at] = a.split("#");
      const [ba, bt] = b.split("#");
      return sira.indexOf(aa) - sira.indexOf(ba) || Number(at) - Number(bt);
    }).map(([, g]) => g);
  }, [incelemeler, asamaAdlari, ajanAdlari, adimlar, detay.asamalar]);

  return (
    <div className="dosyalar">
      <div className="dosyalar-ust">
        <div className="sekmeler" role="tablist" aria-label="Dosyalar">
          {sekmeler.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={sekme === s.id} className="sekme" onClick={() => setSekme(s.id)}>
              {s.ad} <span className="sekme-sayi">{s.sayi}</span>
            </button>
          ))}
        </div>
        {detay.onizlemeler.length > 0 && (
          <div className="onizlemeler">
            {detay.onizlemeler.map((o) => (
              <a key={o.yol} className="dugme dugme--ikincil dugme--kucuk" href={onizlemeAdresi(fikirId, o.yol)} target="_blank" rel="noopener noreferrer">
                {o.ad} <Simge ad="disari" boyut={14} />
              </a>
            ))}
          </div>
        )}
      </div>

      {sekme === "kararlar" ? (
        <KararDefteri detay={detay} />
      ) : (
        <div className="dosyalar-govde">
          <nav className="dosya-listesi" aria-label="Dosya listesi">
            {sekme === "belgeler" && (
              <ul>
                {siraliBelgeler.map((d) => (
                  <li key={d.yol}>
                    <button type="button" className="dosya-oge" aria-current={secili === d.yol} onClick={() => onSec(d.yol)}>
                      {BELGE_ADI[belgeAnahtari(d.yol)] ?? belgeAnahtari(d.yol)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {sekme === "incelemeler" && (incelemeGruplari.length ? incelemeGruplari.map((g) => (
              <div key={g.baslik} className="dosya-grup">
                <div className="dosya-grup-ad">{g.baslik}</div>
                <ul>
                  {g.ogeler.map((o) => {
                    const d = o.adim ? adimDurumu(o.adim) : null;
                    return (
                      <li key={o.yol}>
                        <button type="button" className="dosya-oge" aria-current={secili === o.yol} onClick={() => onSec(o.yol)}>
                          <span>{o.ad}</span>
                          {d && <span className={`rozet rozet--${d.ton}`}>{d.ad}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )) : <p className="bos-not">Onay kurulu henüz bir şey incelemedi.</p>)}
            {sekme === "kod" && (kod.length ? (
              <ul>
                {kod.map((d) => {
                  const rel = d.yol.replace(/^kod\//, "");
                  const bol = rel.lastIndexOf("/");
                  return (
                    <li key={d.yol}>
                      <button type="button" className="dosya-oge dosya-oge--kod" aria-current={secili === d.yol} onClick={() => onSec(d.yol)}>
                        {bol > 0 && <span className="dosya-klasor">{rel.slice(0, bol + 1)}</span>}
                        <span>{rel.slice(bol + 1)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="bos-not">Kod aşamaları başlayınca dosyalar burada görünür.</p>)}
          </nav>
          <DosyaIcerigi fikirId={fikirId} yol={secili} canli={canli} />
        </div>
      )}
    </div>
  );
}

function DosyaIcerigi({ fikirId, yol, canli }: { fikirId: string; yol: string | null; canli: boolean }) {
  const { veri, hata } = useYokla(() => (yol ? api.dosya(fikirId, yol) : Promise.resolve(null)), yol && canli ? 4000 : null, `${fikirId}:${yol}`);
  if (!yol) return <div className="dosya-icerik"><p className="bos-not">Soldan bir dosya seç ya da zaman çizelgesinde bir adıma tıkla.</p></div>;
  const uzanti = yol.split(".").pop()?.toLowerCase() ?? "";
  let govde: ReactNode = <p className="bos-not">Yükleniyor...</p>;
  if (hata) govde = <p className="hata-satiri"><Simge ad="uyari" /> {hata}</p>;
  else if (veri) {
    if (uzanti === "md") govde = <Markdown metin={veri.icerik} />;
    else if (uzanti === "json") {
      let metin = veri.icerik;
      try { metin = JSON.stringify(JSON.parse(veri.icerik), null, 2); } catch { /* olduğu gibi */ }
      govde = <pre className="kod">{metin}</pre>;
    } else govde = <pre className="kod">{veri.icerik}</pre>;
  }
  const html = yol.startsWith("kod/") && (uzanti === "html" || uzanti === "htm");
  return (
    <article className="dosya-icerik" aria-label={yol}>
      <header className="dosya-baslik">
        <span className="dosya-yol">{yol}</span>
        {veri && <span className="dosya-boyut">{boyut(veri.boyut)}{veri.kesildi ? ", ilk 300 KB gösteriliyor" : ""}</span>}
        {html && (
          <a className="dugme dugme--ikincil dugme--kucuk" href={onizlemeAdresi(fikirId, yol)} target="_blank" rel="noopener noreferrer">
            Tarayıcıda aç <Simge ad="disari" boyut={14} />
          </a>
        )}
      </header>
      <div className="dosya-govde">{govde}</div>
    </article>
  );
}

function KararDefteri({ detay }: { detay: FikirDetayi }) {
  return (
    <div className="defter">
      <p className="defter-not">Ajanların sorduğu ve senin cevapladığın kararlar. Sonraki bütün ajanlar bunları bağlayıcı kural olarak görür.</p>
      <ol className="defter-liste">
        {detay.kararlar.map((k, i) => (
          <li key={`${k.zaman}-${i}`} className="defter-kayit">
            <div className="defter-ust">
              <span className="soru-cip">{k.baslik}</span>
              <span className="defter-kim">{k.soran}, {k.asama_ad ?? "-"} aşaması</span>
              <span className="defter-zaman">{zaman(k.zaman)}</span>
            </div>
            <p className="defter-soru">{k.soru}</p>
            <p className="defter-cevap">{k.cevap}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
