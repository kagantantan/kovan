// Fikrin dosyaları: ajanların belgeleri, onay kurulu incelemeleri, kod ve karar defteri.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, onizlemeAdresi, type Adim, type FikirDetayi } from "../api";
import { adimDurumu, boyut, zaman } from "../bicim";
import { useYokla } from "../kullan";
import { Markdown, type AtifTiklama } from "./Markdown";
import { Simge } from "./Simge";

type Sekme = "belgeler" | "incelemeler" | "kod" | "kaynak" | "proje" | "cikti" | "kararlar" | "adr";

const BELGE_ADI: Record<string, string> = {
  fikir: "Fikir metni", "proje-envanteri": "Proje envanteri", "kaynak-envanteri": "Kaynak envanteri", kesif: "Keşif", "mevcut-sistem": "Mevcut sistem analizi", brif: "Kapsam ve kabul paketi", analiz: "Analiz belgesi", "ux-ozeti": "UX özeti", "teknik-plan": "Teknik plan",
  "teslim-plani": "Teslim planı", "test-senaryolari": "Test senaryoları", "test-altyapisi": "Test altyapısı", "test-ozeti": "Test özeti",
  "be-notu": "Backend notu", "fe-notu": "Frontend notu", "kiran-test": "Kıran test", "duzeltme-notu": "Düzeltme notu", birlestirme: "Birleştirme", "degisiklik-notu": "Değişiklik notu", entegrasyon: "Entegrasyon kılavuzu", teslim: "Teslim paketi",
  "gelisim-onerileri": "Gelişim önerileri", "gelisim-defteri": "Gelişim defteri", kararlar: "Kararlar", onaylar: "Onayların", "birader-defteri": "Büyük Birader'in defteri",
};
const BELGE_SIRASI = Object.keys(BELGE_ADI);

const belgeAnahtari = (yol: string) => yol.replace(/^belgeler\//, "").replace(/\.md$/, "");

/** p1-kabul-testi -> "P1 kabul testi", v2-p3-is-notu -> "P3 iş notu" */
export function belgeAdi(anahtar: string): string {
  if (BELGE_ADI[anahtar]) return BELGE_ADI[anahtar];
  const m = /^(?:v\d+-)?(p\d+)-(kabul-testi|is-notu)$/.exec(anahtar);
  if (m) return `${m[1].toUpperCase()} ${m[2] === "kabul-testi" ? "kabul testi" : "iş notu"}`;
  return anahtar;
}
const sekmesi = (yol: string): Sekme | null =>
  yol.startsWith("belgeler/") ? "belgeler" : yol.startsWith("incelemeler/") ? "incelemeler"
    : yol.startsWith("cikti/") ? "cikti" : yol.startsWith("kod/kaynak/") ? "kaynak" : yol.startsWith("kod/") ? "kod" : null;
const KAYNAK_LISTESI = 400;

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

type Vurgu = { yol: string; ilk: number; son: number };

export function DosyaGorunumu({ fikirId, detay, secili, onSec, ajanAdlari, canli }: Props) {
  const projeli = Boolean(detay.fikir.proje);
  // Mevcut projede kod/proje/ dosyaları Kod değil Proje sekmesindedir
  const sekmeBul = (yol: string): Sekme | null => (projeli && yol.startsWith("kod/proje/") ? "proje" : sekmesi(yol));
  const [sekme, setSekme] = useState<Sekme>(() => (secili && sekmeBul(secili)) || "belgeler");
  const [vurgu, setVurgu] = useState<Vurgu | null>(null);
  // Belgedeki kod atfına tıklanınca eski sistemin dosyası o satırlar vurgulanarak açılır
  const atifAc: AtifTiklama = (yol, ilk, son) => {
    setVurgu({ yol: `kod/${yol}`, ilk, son });
    onSec(`kod/${yol}`);
  };
  useEffect(() => {
    const s = secili ? sekmeBul(secili) : null;
    if (s) setSekme(s);
  }, [secili]);

  const asamaAdlari = useMemo(() => new Map(detay.asamalar.map((a) => [a.id, a.ad])), [detay.asamalar]);
  const adimlar = useMemo(() => new Map<number, Adim>(detay.adimlar.map((a) => [a.id, a])), [detay.adimlar]);
  const { belgeler, incelemeler, kod, kaynak } = detay.dosyalar;
  const proje = detay.dosyalar.proje ?? [];
  const cikti = detay.dosyalar.cikti ?? [];
  // Proje sekmesi: yamadaki dosyalar önce (ne değişti), sonra projenin gerisi
  const degisen = new Map((detay.yama?.dosyalar ?? []).map((d) => [`kod/proje/${d.yol}`, d.durum]));
  const projeSirali = [...proje].sort((a, b) => Number(degisen.has(b.yol)) - Number(degisen.has(a.yol)) || a.yol.localeCompare(b.yol));

  const sekmeler: { id: Sekme; ad: string; sayi: number }[] = [
    { id: "belgeler", ad: "Belgeler", sayi: belgeler.length },
    { id: "incelemeler", ad: "İncelemeler", sayi: incelemeler.length },
    ...(projeli ? [{ id: "proje" as Sekme, ad: "Proje", sayi: proje.length }] : [{ id: "kod" as Sekme, ad: "Kod", sayi: kod.length }]),
    ...(kaynak.length ? [{ id: "kaynak" as Sekme, ad: projeli ? "Ekler" : "Mevcut sistem", sayi: kaynak.length }] : []),
    ...(cikti.length ? [{ id: "cikti" as Sekme, ad: "Yama", sayi: cikti.length }] : []),
    ...(detay.kararlar.length ? [{ id: "kararlar" as Sekme, ad: "Kararlar", sayi: detay.kararlar.length }] : []),
    ...(detay.adrler.length ? [{ id: "adr" as Sekme, ad: "ADR", sayi: detay.adrler.length }] : []),
  ];

  const siraliBelgeler = [...belgeler].sort((a, b) => {
    const sira = (y: string) => {
      const k = belgeAnahtari(y);
      const i = BELGE_SIRASI.indexOf(k);
      return i >= 0 ? i : /^(?:v\d+-)?p\d+-/.test(k) ? BELGE_SIRASI.indexOf("test-altyapisi") + 0.5 : -1;
    };
    const ia = sira(a.yol);
    const ib = sira(b.yol);
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
      ) : sekme === "adr" ? (
        <AdrDefteri detay={detay} />
      ) : (
        <div className="dosyalar-govde">
          <nav className="dosya-listesi" aria-label="Dosya listesi">
            {sekme === "belgeler" && (
              <ul>
                {siraliBelgeler.map((d) => (
                  <li key={d.yol}>
                    <button type="button" className="dosya-oge" aria-current={secili === d.yol} onClick={() => onSec(d.yol)}>
                      {belgeAdi(belgeAnahtari(d.yol))}
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
            {sekme === "proje" && (
              <div className="dosya-grup">
                <div className="dosya-grup-ad">Çalışma kopyası{degisen.size ? `; ${degisen.size} dosya değişti` : ""}</div>
                <ul>
                  {projeSirali.slice(0, KAYNAK_LISTESI).map((d) => {
                    const rel = d.yol.replace(/^kod\/proje\//, "");
                    const bol = rel.lastIndexOf("/");
                    const durum = degisen.get(d.yol);
                    return (
                      <li key={d.yol}>
                        <button type="button" className="dosya-oge dosya-oge--kod" aria-current={secili === d.yol} onClick={() => onSec(d.yol)}>
                          {bol > 0 && <span className="dosya-klasor">{rel.slice(0, bol + 1)}</span>}
                          <span>{rel.slice(bol + 1)}</span>
                          {durum && <span className={`rozet rozet--${durum === "eklendi" ? "iyi" : "dikkat"}`}>{durum === "eklendi" ? "yeni" : "değişti"}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {proje.length > KAYNAK_LISTESI && <p className="bos-not">+{proje.length - KAYNAK_LISTESI} dosya daha; dökümü Proje envanteri belgesinde.</p>}
              </div>
            )}
            {sekme === "cikti" && (
              <div className="dosya-grup">
                <div className="dosya-grup-ad">Projene uygulayacağın çıktı</div>
                <ul>
                  {cikti.map((d) => (
                    <li key={d.yol}>
                      <button type="button" className="dosya-oge dosya-oge--kod" aria-current={secili === d.yol} onClick={() => onSec(d.yol)}>
                        <span>{d.yol.replace(/^cikti\//, "")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {sekme === "kaynak" && (
              <div className="dosya-grup">
                <div className="dosya-grup-ad">{projeli ? "Verdiğin ekler, kilitli ve salt okunur" : "Eski sistem, kilitli ve salt okunur"}</div>
                <ul>
                  {kaynak.slice(0, KAYNAK_LISTESI).map((d) => {
                    const rel = d.yol.replace(/^kod\/kaynak\//, "");
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
                {kaynak.length > KAYNAK_LISTESI && <p className="bos-not">+{kaynak.length - KAYNAK_LISTESI} dosya daha; hepsi Kaynak envanteri belgesinde.</p>}
              </div>
            )}
          </nav>
          <DosyaIcerigi fikirId={fikirId} yol={secili} canli={canli} onAtif={detay.dosyalar.kaynak.length || projeli ? atifAc : undefined}
            vurgu={vurgu && vurgu.yol === secili ? vurgu : null} />
        </div>
      )}
    </div>
  );
}

/** Satır numaralı kod; vurgu verilirse o satırlar işaretlenir ve görünür alana kaydırılır. */
function SatirliKod({ metin, vurgu }: { metin: string; vurgu: Vurgu | null }) {
  const satirlar = metin.split("\n");
  if (satirlar.length > 1 && satirlar.at(-1) === "") satirlar.pop();
  const kok = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (vurgu) kok.current?.querySelector(`[data-satir="${vurgu.ilk}"]`)?.scrollIntoView({ block: "center" });
  }, [vurgu, metin]);
  return (
    <ol className="kod kod--satirli" ref={kok} style={{ ["--hane" as string]: String(satirlar.length).length }}>
      {satirlar.map((s, i) => (
        <li key={i} data-satir={i + 1} className={vurgu && i + 1 >= vurgu.ilk && i + 1 <= vurgu.son ? "satir--vurgu" : undefined}>{s || " "}</li>
      ))}
    </ol>
  );
}

function DosyaIcerigi({ fikirId, yol, canli, onAtif, vurgu }: { fikirId: string; yol: string | null; canli: boolean; onAtif?: AtifTiklama; vurgu: Vurgu | null }) {
  const { veri, hata } = useYokla(() => (yol ? api.dosya(fikirId, yol) : Promise.resolve(null)), yol && canli ? 4000 : null, `${fikirId}:${yol}`);
  if (!yol) return <div className="dosya-icerik"><p className="bos-not">Soldan bir dosya seç ya da zaman çizelgesinde bir adıma tıkla.</p></div>;
  const uzanti = yol.split(".").pop()?.toLowerCase() ?? "";
  let govde: ReactNode = <p className="bos-not">Yükleniyor...</p>;
  if (hata) govde = <p className="hata-satiri"><Simge ad="uyari" /> {hata}</p>;
  else if (veri) {
    if (uzanti === "md") govde = <Markdown metin={veri.icerik} onAtif={onAtif} />;
    else if (uzanti === "json") {
      let metin = veri.icerik;
      try { metin = JSON.stringify(JSON.parse(veri.icerik), null, 2); } catch { /* olduğu gibi */ }
      govde = <pre className="kod">{metin}</pre>;
    } else if (veri.icerik.startsWith("(ikili dosya")) govde = <p className="bos-not">{veri.icerik}</p>;
    else govde = <SatirliKod metin={veri.icerik} vurgu={vurgu} />;
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

const ayni = (a: string, b: string) => a.toLocaleLowerCase("tr").trim() === b.toLocaleLowerCase("tr").trim();

function AdrDefteri({ detay }: { detay: FikirDetayi }) {
  return (
    <div className="defter">
      <p className="defter-not">Mimarın teknik planda aldığı ve onay kurulunun geçirdiği mimari kararlar. Kodda <code>adr/</code> altında durur ve kilitlidir:
        yazılımcılar okur, değiştiremez. Kod incelemesi koda bu kararlara göre bakar.</p>
      <ol className="defter-liste">
        {detay.adrler.map((a) => (
          <li key={a.id} className="defter-kayit">
            <div className="defter-ust">
              <span className="soru-cip">{a.id}</span>
              <span className="rozet rozet--iyi">{a.alan}</span>
              {a.kurallar.length > 0 && <span className="defter-kim">{a.kurallar.join(", ")}</span>}
            </div>
            <p className="defter-cevap">{a.baslik}</p>
            <p className="defter-soru">{a.baglam}</p>
            <ul className="adr-secenekler">
              {a.secenekler.map((o) => (
                <li key={o.ad} className={ayni(o.ad, a.karar) ? "adr-secenek adr-secenek--secili" : "adr-secenek"}>
                  <b>{o.ad}</b>{ayni(o.ad, a.karar) && " · seçildi"}
                  <span>+ {o.arti}</span>
                  <span>− {o.eksi}</span>
                </li>
              ))}
            </ul>
            <p className="defter-soru"><b>Gerekçe:</b> {a.gerekce}</p>
            <p className="defter-soru"><b>Sonuçlar:</b> {a.sonuclar}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function KararDefteri({ detay }: { detay: FikirDetayi }) {
  return (
    <div className="defter">
      <p className="defter-not">Ajanların sorduğu sorular ve verilen kararlar. Ekip oybirliğiyle karar verdiyse sana sorulmadı; anlaşamadıysa sen karar verdin.
        Sonraki bütün ajanlar bunları bağlayıcı kural olarak görür.</p>
      <ol className="defter-liste">
        {detay.kararlar.map((k, i) => (
          <li key={`${k.zaman}-${i}`} className="defter-kayit">
            <div className="defter-ust">
              <span className="soru-cip">{k.baslik}</span>
              <span className={`rozet ${k.karar_veren === "ekip" ? "rozet--iyi" : "rozet--oneri"}`}>
                {k.karar_veren === "ekip" ? `ekip kararı, ${k.kural === "cogunluk" ? "çoğunluk" : "oybirliği"}` : "senin kararın"}
              </span>
              <span className="defter-kim">{k.soran}, {k.asama_ad ?? "-"} aşaması</span>
              <span className="defter-zaman">{zaman(k.zaman)}</span>
            </div>
            <p className="defter-soru">{k.soru}</p>
            <p className="defter-cevap">{k.cevap}</p>
            {k.oylar && k.oylar.length > 0 && (
              <p className="defter-oylar">
                {k.oylar.map((o) => <span key={o.ajan} title={o.gerekce}><b>{o.kisa}</b> {o.insana ? "sana bıraktı" : o.secim.join(", ")}</span>)}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
