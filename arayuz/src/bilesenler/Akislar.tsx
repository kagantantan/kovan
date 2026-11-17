// Akışlar: her akışın aşamaları sırasıyla; kim üretir, ne doğrular, kim onaylar, neye yazabilir.
import type { AkisOzeti } from "../api";
import { para } from "../bicim";
import { Petek, akisHucreleri } from "./Petek";

export function Akislar({ akislar }: { akislar: AkisOzeti[] }) {
  return (
    <div className="akislar">
      <header className="akislar-ust">
        <h1 className="sayfa-baslik">Akışlar</h1>
        <p className="sayfa-giris">Her aşama bir üret ve doğrula döngüsü: ajan üretir, testler koşar, onay kurulu bakar; bulgu varsa aynı ajana geri döner.
          Akışlar <code>akislar/</code> klasöründe.</p>
      </header>
      {akislar.map((a) => (
        <section key={a.id} className="akis" aria-labelledby={`akis-${a.id}`}>
          <h2 id={`akis-${a.id}`} className="akis-ad">{a.ad}</h2>
          <p className="akis-aciklama">{a.aciklama} Fikir bütçesi {para(a.fikir_butcesi_usd)}.</p>
          <Petek hucreler={akisHucreleri(a)} etiket={`${a.ad} akışının aşamaları`} />
          <ol className="asama-listesi">
            {a.asamalar.map((s) => {
              const testler = s.dogrulama.filter((d) => d.tip === "komut");
              const kurul = s.dogrulama.filter((d) => d.tip === "ajan");
              return (
                <li key={s.id} className="asama-satiri">
                  <div className="asama-satiri-ic">
                  <div className="asama-satiri-ad">{s.ad}</div>
                  <div className="asama-satiri-govde">
                    {s.tur === "insan" ? (
                      <p>Senin onay kapın: kabul edersin ya da notunla bir önceki aşamaya geri gönderirsin.</p>
                    ) : (
                      <>
                        <p><strong>{s.ajan_ad}</strong> yazar{s.girdiler.length ? <>; okuduğu: {s.girdiler.join(", ")}</> : null}. Çıktı: {s.cikti}.</p>
                        {(s.yazabilir.length > 0 || s.kilitle.length > 0) && (
                          <p className="asama-sinir">
                            {s.yazabilir.length > 0 && <>Yalnızca {s.yazabilir.map((y) => <code key={y}>{/\.[a-z0-9]+$/i.test(y) ? y : `${y}/`}</code>)} yazabilir. </>}
                            {s.kilitle.length > 0 && <>Aşama geçince {s.kilitle.map((y) => <code key={y}>{y}</code>)} kilitlenir.</>}
                          </p>
                        )}
                        {testler.length > 0 && <p>Testler: {testler.map((t) => <code key={t.ad}>{t.komut}</code>)}</p>}
                        {kurul.length > 0 && <p>Onay kurulu: {kurul.map((k) => k.inceleyen_ad ?? k.ad).join(", ")}. En fazla {s.en_fazla_tur} tur.</p>}
                      </>
                    )}
                  </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
