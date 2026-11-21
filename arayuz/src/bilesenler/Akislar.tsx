// Akışlar: her akışın aşamaları sırasıyla; kim üretir, ne doğrular, kim onaylar, neye yazabilir.
import type { AkisAsamaOzeti, AkisOzeti } from "../api";
import { para } from "../bicim";
import { Petek, akisHucreleri } from "./Petek";

const KOSUL_BOYUT: Record<string, string> = { kucuk: "küçük", orta: "orta", buyuk: "büyük" };
/** "yalnızca orta ve büyük işte; arayüz tarafı varsa" */
function kosulMetni(k: NonNullable<AkisAsamaOzeti["kosul"]>): string {
  const p: string[] = [];
  if (k.boyut?.length) p.push(`${k.boyut.map((b) => KOSUL_BOYUT[b] ?? b).join(" ve ")} işte`);
  if (k.taraf?.length) p.push(`${k.taraf.map((t) => t.toUpperCase()).join(" ya da ")} tarafı varsa`);
  return `yalnızca ${p.join("; ")}`;
}

function AdimGovdesi({ s, proje = false }: { s: AkisAsamaOzeti; proje?: boolean }) {
  const testler = s.dogrulama.filter((d) => d.tip === "komut");
  const plan = s.dogrulama.some((d) => d.tip === "plan");
  const atif = s.dogrulama.some((d) => d.tip === "atif");
  const adr = s.dogrulama.find((d) => d.tip === "adr");
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
      {(s.once_soru || s.is_kurali_sana) && (
        <p className="asama-sinir">
          {s.once_soru && <>Kontrol noktası: {s.ajan_ad} belgeyi yazmadan önce açık sorularını ve varsayımlarını sana getirir. </>}
          {s.is_kurali_sana && <>İş kuralı soruları (doküman-kod farkı, hesap, kapsam) ekibe uğramadan sana gelir; teknik sorular ekipte oylanır.</>}
        </p>
      )}
      {s.salt_okunur && <p className="asama-sinir">Salt okunur: hiçbir dosyaya yazamaz, yalnızca okur ve belgesini yazar.</p>}
      {atif && <p>Sistem denetimi: her kod atfı (<code>{proje ? "proje/dosya:satır" : "kaynak/dosya:satır"}</code>) gerçek bir dosya ve satıra gitmeli; uydurma atıf onay kuruluna gitmeden geri döner.</p>}
      {plan && <p>Sistem denetimi: <code>kovan-plan</code> bloğu (kalem kimlikleri, yazılımcı, bağımlılık, döngü). Bozuksa onay kurulu harcanmaz.</p>}
      {adr && <p>Sistem denetimi: <code>kovan-adr</code> bloğu; her mimari karar en az iki seçenekle, artısı, eksisi ve gerekçesiyle
        {adr.adr_zorunlu.length > 0 && <> (zorunlu: {adr.adr_zorunlu.map((z) => <code key={z}>{z}</code>)})</>}. Onaydan sonra <code>adr/</code> altına yazılır ve kilitlenir.</p>}
      {testler.length > 0 && <p>Testler: {testler.map((t) => <code key={t.ad}>{t.komut}</code>)}
        {testler.some((t) => t.beklenen === "kirmizi") && <> Yeni testler koddan önce <strong>kırmızı</strong> olmalı; yeşilse test isteneni yakalamıyordur ve yazara geri döner.</>}</p>}
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
            {a.kaynak === "zorunlu" ? " Fikir, mevcut sistemin kod ve doküman klasörüyle başlar." : ""}
            {a.kaynak === "proje" ? " İş, projenin klasörüyle başlar; koşan aşamaları onayladığın öneri kartı belirler." : ""}
            {a.buyuk_birader ? " Büyük Birader her aşamanın sonunda işin tamamına bakar ve veto edebilir." : " Bu akışta Büyük Birader çalışmaz."}</p>
          <Petek hucreler={akisHucreleri(a)} etiket={`${a.ad} akışının aşamaları`} />
          <ol className="asama-listesi">
            {a.asamalar.map((s) => (
              <li key={s.id} className="asama-satiri">
                <div className="asama-satiri-ic">
                  <div className="asama-satiri-ad">{s.ad}{s.kosul && <span className="asama-kosul">{kosulMetni(s.kosul)}</span>}
                    {s.kapi && <span className="asama-kosul" title="Onay kapıları 'Planlama aşamalarında' ise bu aşamanın sonunda kararlar sana gelir">onay kapısı</span>}</div>
                  <div className="asama-satiri-govde">
                    {s.tur === "insan" ? (
                      <p>Senin onay kapın: kabul edersin ya da notunla bir önceki aşamaya geri gönderirsin.</p>
                    ) : s.tur === "kontrol" ? (
                      <p>Ajan yok: sistem projenin testlerini koşar ({s.dogrulama.map((t) => <code key={t.ad}>{t.komut}</code>)}). Kırmızıysa iş başlamaz;
                        komutu değiştirir ya da durdurursun.</p>
                    ) : s.tur === "kalemler" ? (
                      <>
                        <p>Teslim planındaki her iş kalemi (P1, P2...) için sırayla, bağımlılık sırasına göre:</p>
                        <ol className="kalem-adimlari">
                          {s.kalem_adimlari.map((k) => <li key={k.id}><span className="kalem-adimi-ad">{k.ad}</span> <AdimGovdesi s={k} proje={a.kaynak === "proje"} /></li>)}
                        </ol>
                      </>
                    ) : (
                      <>
                        <AdimGovdesi s={s} proje={a.kaynak === "proje"} />
                        {s.tur === "kesif" && <p>Onaydan sonra <strong>öneri kartı</strong> sana gelir: tür (hata, özellik, entegrasyon), boyut, test komutu ve yazma alanı.
                          Onaylamadan kod yazılmaz; yazma alanını beğenmezsen keşif notunla yeniden çalışır.</p>}
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
