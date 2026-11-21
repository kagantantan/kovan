// Zaman çizelgesi: adımlar aşamaya göre gruplanır, tur değişince ayraç düşer.
// Her adımda kim yaptı, hangi motorda, sonuç ne, ne kadar sürdü. Dosyası olan adım tıklanınca açılır.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Adim } from "../api";
import { adimDurumu, motorAdi, para, sure } from "../bicim";
import { Simge, type SimgeAdi } from "./Simge";

interface Props {
  adimlar: Adim[];
  asamaAdlari: Map<string, string>;
  yerelMi: (motor: string) => boolean;
  odak: string | null;
  seciliDosya: string | null;
  onDosya: (yol: string) => void;
}

interface Grup {
  anahtar: string;
  asamaId: string;
  ad: string;
  adimlar: Adim[];
}

function grupla(adimlar: Adim[], adlar: Map<string, string>): Grup[] {
  const gruplar: Grup[] = [];
  for (const a of adimlar) {
    const son = gruplar.at(-1);
    if (son && son.asamaId === a.asama_id) son.adimlar.push(a);
    else gruplar.push({ anahtar: `${a.asama_id}-${a.id}`, asamaId: a.asama_id, ad: a.asama_id === "-" ? "Kovan" : adlar.get(a.asama_id) ?? a.asama_ad, adimlar: [a] });
  }
  return gruplar;
}

function simgesi(a: Adim): SimgeAdi {
  if (a.tip === "uret") return "kalem";
  if (a.tip === "sohbet") return "sohbet";
  if (a.ajan === "buyuk-birader") return "goz";
  if (a.tip === "inceleme") return "buyutec";
  if (a.tip === "kontrol") return "tup";
  if (a.tip === "oy") return "oy";
  if (a.durum === "ekip") return "ekip";
  if (a.durum === "kilit") return "kilit";
  if (a.durum === "ihlal" || a.durum === "uyari") return "uyari";
  if (a.ajan_ad === "Ajan sorusu") return "soru";
  if (a.durum === "bekliyor" || a.durum === "karar") return "insan";
  if (a.durum === "durduruldu") return "dur";
  if (a.ajan_ad === "Devam") return "oynat";
  if (a.durum === "yeniden") return "geri";
  return "disli";
}

/** "2026-11-17 22:57:46" yerel saat -> geçen saniye */
function gecen(basla: string): number {
  const t = new Date(basla.replace(" ", "T")).getTime();
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 1000) : 0;
}

export function ZamanCizelgesi({ adimlar, asamaAdlari, yerelMi, odak, seciliDosya, onDosya }: Props) {
  const kutu = useRef<HTMLDivElement>(null);
  const dipteydi = useRef(true);
  const gruplar = grupla(adimlar, asamaAdlari);

  // Yeni adım gelince, kullanıcı zaten en alttaysa en alta kaydır (yukarıda bir şey okuyorsa rahatsız etme).
  useLayoutEffect(() => {
    const k = kutu.current;
    if (k && dipteydi.current) k.scrollTop = k.scrollHeight;
  }, [adimlar.length]);

  useEffect(() => {
    if (!odak || !kutu.current) return;
    const hedef = kutu.current.querySelectorAll<HTMLElement>(`[data-asama="${CSS.escape(odak)}"]`);
    const son = hedef[hedef.length - 1];
    if (son) son.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [odak]);

  return (
    <div className="cizelge" ref={kutu} onScroll={(e) => {
      const k = e.currentTarget;
      dipteydi.current = k.scrollTop + k.clientHeight >= k.scrollHeight - 48;
    }}>
      {gruplar.length === 0 && <p className="bos-not">Ekip işe başlayınca adımlar burada görünür.</p>}
      {gruplar.map((g) => (
        <section key={g.anahtar} className={`cizelge-grup${odak === g.asamaId ? " cizelge-grup--odak" : ""}`} data-asama={g.asamaId}>
          <h3 className="cizelge-baslik">{g.ad}</h3>
          <ol className="adimlar">
            {g.adimlar.map((a, i) => {
              const onceki = g.adimlar[i - 1];
              const turAyraci = onceki && a.tip !== "sistem" && onceki.tur !== a.tur && g.adimlar.slice(0, i).some((x) => x.tip !== "sistem");
              const { ad, ton } = adimDurumu(a);
              const motorTuru = !a.motor || a.motor === "sistem" ? null : a.motor === "claude" ? "claude" : a.motor === "deneme" ? "deneme" : yerelMi(a.motor) ? "yerel" : "claude";
              const calisiyor = a.durum === "calisiyor";
              const sureSn = calisiyor ? gecen(a.basla) : a.sure_sn;
              const tiklanir = Boolean(a.dosya);
              const govde = (
                <>
                  <span className="adim-simge"><Simge ad={simgesi(a)} /></span>
                  <span className="adim-govde">
                    <span className="adim-ust">
                      <span className="adim-kim">{a.ajan_ad}</span>
                      <span className={`rozet rozet--${ton}`}>{ad}</span>
                      {motorTuru && (
                        <span className={`motor-etiket motor-etiket--${motorTuru}`} title={a.model ? `model: ${a.model}` : undefined}>
                          {motorAdi(a.motor, motorTuru === "yerel")}
                        </span>
                      )}
                      {a.deneme > 1 && <span className="adim-deneme">{a.deneme}. deneme</span>}
                      <span className="adim-olcu">
                        {a.tip !== "sistem" && sureSn !== null && <span>{sure(sureSn)}</span>}
                        {a.maliyet_usd > 0 && <span title="Abonelikte faturalanmaz; kullanım limitinden yer">{para(a.maliyet_usd)}</span>}
                      </span>
                    </span>
                    {a.ozet && <span className="adim-ozet">{a.ozet}</span>}
                  </span>
                </>
              );
              return (
                <li key={a.id} className={`adim adim--${a.tip} adim--${ton}${seciliDosya && a.dosya === seciliDosya ? " adim--secili" : ""}`}>
                  {turAyraci && <div className="tur-ayraci">Tur {a.tur}</div>}
                  {tiklanir ? (
                    <button type="button" className="adim-satir" onClick={() => onDosya(a.dosya)} title={`Aç: ${a.dosya}`}>{govde}</button>
                  ) : (
                    <div className="adim-satir">{govde}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
