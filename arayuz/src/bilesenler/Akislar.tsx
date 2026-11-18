// Akışlar: her akışın aşamaları sırasıyla; kim üretir, ne doğrular, kim onaylar, neye yazabilir.
import type { AkisAsamaOzeti, AkisOzeti } from "../api";
import { para } from "../bicim";
import { Petek, akisHucreleri } from "./Petek";

function AdimGovdesi({ s }: { s: AkisAsamaOzeti }) {
  const testler = s.dogrulama.filter((d) => d.tip === "komut");
  const plan = s.dogrulama.some((d) => d.tip === "plan");
  const atif = s.dogrulama.some((d) => d.tip === "atif");
  const kurul = s.dogrulama.filter((d) => d.tip === "ajan");
  const kurulAdi = (k: AkisAsamaOzeti["dogrulama"][number]) =>
    (k.inceleyen_ad ?? k.ad) + (k.atlanabilir ? " (konu yoksa atlanır)" : "") + (k.taraf ? ` (yalnızca ${k.taraf.toUpperCase()} kalemlerinde)` : "");
  return (
    <>
      <p><strong>{s.ajan_ad}</strong> yazar{s.girdiler.length ? <>; okuduğu: {s.girdiler.join(", ")}</> : null}. Çıktı: {s.cikti}.</p>
      {(s.yazabilir.length > 0 || s.kilitle.length > 0) && (
        <p className="asama-sinir">
          {s.yazabilir.length > 0 && <>Yalnızca {s.yazabilir.map((y) => <code key={y}>{/\.[a-z0-9]+$/i.test(y) ? y : `${y}/`}</code>)} yazabilir. </>}
          {s.kilitle.length > 0 && <>Aşama geçince {s.kilitle.map((y) => <code key={y}>{y}</code>)} kilitlenir.</>}
        </p>
      )}
      {s.salt_okunur && <p className="asama-sinir">Salt okunur: hiçbir dosyaya yazamaz, yalnızca okur ve belgesini yazar.</p>}
      {atif && <p>Sistem denetimi: her kod atfı (<code>kaynak/dosya:satır</code>) gerçek bir dosya ve satıra gitmeli; uydurma atıf onay kuruluna gitmeden geri döner.</p>}
      {plan && <p>Sistem denetimi: <code>kovan-plan</code> bloğu (kalem kimlikleri, yazılımcı, bağımlılık, döngü). Bozuksa onay kurulu harcanmaz.</p>}
      {testler.length > 0 && <p>Testler: {testler.map((t) => <code key={t.ad}>{t.komut}</code>)}</p>}
      {kurul.length > 0 && <p>Onay kurulu: {kurul.map(kurulAdi).join(", ")}. En fazla {s.en_fazla_tur} tur.</p>}
    </>
  );
}

export function Akislar({ akislar }: { akislar: AkisOzeti[] }) {
  return (
    <div className="akislar">
      <header className="akislar-ust">
        <h1 className="sayfa-baslik">Akışlar</h1>
        <p className="sayfa-giris">Her aşama bir üret ve doğrula döngüsü: ajan üretir, testler koşar, onay kurulu bakar; bulgu varsa aynı ajana geri döner.
          Ajanların soruları önce ekipte oylanır; oybirliği çıkmazsa sana gelir. Akışlar <code>akislar/</code> klasöründe.</p>
      </header>
      {akislar.map((a) => (
        <section key={a.id} className="akis" aria-labelledby={`akis-${a.id}`}>
          <h2 id={`akis-${a.id}`} className="akis-ad">{a.ad}</h2>
          <p className="akis-aciklama">{a.aciklama} Fikir bütçesi {para(a.fikir_butcesi_usd)}.{a.ortak_karar ? "" : " Bu akışta ortak karar kapalı."}
            {a.kaynak === "zorunlu" ? " Fikir, mevcut sistemin kod ve doküman klasörüyle başlar." : ""}</p>
          <Petek hucreler={akisHucreleri(a)} etiket={`${a.ad} akışının aşamaları`} />
          <ol className="asama-listesi">
            {a.asamalar.map((s) => (
              <li key={s.id} className="asama-satiri">
                <div className="asama-satiri-ic">
                  <div className="asama-satiri-ad">{s.ad}</div>
                  <div className="asama-satiri-govde">
                    {s.tur === "insan" ? (
                      <p>Senin onay kapın: kabul edersin ya da notunla bir önceki aşamaya geri gönderirsin.</p>
                    ) : s.tur === "kalemler" ? (
                      <>
                        <p>Teslim planındaki her iş kalemi (P1, P2...) için sırayla, bağımlılık sırasına göre:</p>
                        <ol className="kalem-adimlari">
                          {s.kalem_adimlari.map((k) => <li key={k.id}><span className="kalem-adimi-ad">{k.ad}</span> <AdimGovdesi s={k} /></li>)}
                        </ol>
                      </>
                    ) : (
                      <>
                        <AdimGovdesi s={s} />
                        {s.tur === "gelisim" && <p>Onaydan sonra her öneri sana "olmalı mı?" diye gelir; kararların gelişim defterine yazılır, kabul ettiklerinle yeni sürüm başlatırsın.</p>}
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
