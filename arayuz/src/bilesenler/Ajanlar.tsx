// Ajanlar: her ajanın rolü, motoru, araçları, izinli komutları ve sınırları.
import { useEffect, useState } from "react";
import { api, type AjanOzeti, type DurumYaniti } from "../api";
import { para } from "../bicim";
import { Markdown } from "./Markdown";
import { Simge } from "./Simge";

/** Ajanın motoru ve modeli: Hibrit modda geçerli. Kaydedilince bir sonraki ajan çağrısından itibaren kullanılır. */
function MotorSecimi({ ajan, durum, onDegisti }: { ajan: AjanOzeti; durum: DurumYaniti | null; onDegisti: () => void }) {
  const motorAdlari = Object.keys(durum?.motorlar ?? {}).filter((m) => m !== "deneme");
  const [motor, setMotor] = useState(ajan.motor);
  const [model, setModel] = useState(ajan.motor_modeli);
  const [oneriler, setOneriler] = useState<Record<string, string[]>>({});
  const [mesaj, setMesaj] = useState<{ tur: "iyi" | "hata"; metin: string } | null>(null);
  const [bekliyor, setBekliyor] = useState(false);
  useEffect(() => { setMotor(ajan.motor); setModel(ajan.motor_modeli); setMesaj(null); }, [ajan.id, ajan.motor, ajan.motor_modeli]);
  useEffect(() => { api.modeller().then(setOneriler).catch(() => setOneriler({})); }, []);

  const eylem = async (is: () => Promise<unknown>, basari: string) => {
    setBekliyor(true); setMesaj(null);
    try { await is(); setMesaj({ tur: "iyi", metin: basari }); onDegisti(); } catch (e) { setMesaj({ tur: "hata", metin: (e as Error).message }); }
    setBekliyor(false);
  };
  const motorDurumu = durum?.motorlar[motor];
  const listeId = `modeller-${ajan.id}`;
  return (
    <div className="motor-secimi">
      <label className="alan">
        <span className="alan-ad">Motor</span>
        <select value={motor} onChange={(e) => { setMotor(e.target.value); setModel(oneriler[e.target.value]?.[0] ?? ""); }} aria-label="Motor">
          {motorAdlari.map((m) => <option key={m} value={m}>{m === "claude" ? "Claude" : `${m}${durum?.motorlar[m]?.yerel ? " (yerel)" : ""}`}</option>)}
        </select>
      </label>
      <label className="alan">
        <span className="alan-ad">Model</span>
        <input type="text" value={model} onChange={(e) => setModel(e.target.value)} list={listeId} spellCheck={false} maxLength={100} aria-label="Model" />
        <datalist id={listeId}>{(oneriler[motor] ?? []).map((o) => <option key={o} value={o} />)}</datalist>
      </label>
      <div className="motor-secimi-dugmeler">
        <button type="button" className="dugme dugme--birincil dugme--kucuk" disabled={bekliyor || !model.trim()}
          onClick={() => eylem(() => api.ajanSecimi(ajan.id, motor, model.trim()), "Kaydedildi. Sonraki çağrıdan itibaren geçerli.")}>Kaydet</button>
        {ajan.secim && (
          <button type="button" className="dugme dugme--ikincil dugme--kucuk" disabled={bekliyor}
            onClick={() => eylem(() => api.ajanSecimiSil(ajan.id), "Kartın varsayılanına dönüldü.")}>Varsayılana dön</button>
        )}
      </div>
      {motorDurumu && !motorDurumu.hazir && <p className="hata-satiri"><Simge ad="uyari" /> {motor} şu an hazır değil{motorDurumu.hata ? `: ${motorDurumu.hata}` : ""}</p>}
      {mesaj && <p className={mesaj.tur === "hata" ? "hata-satiri" : "alan-not"} role={mesaj.tur === "hata" ? "alert" : "status"}>{mesaj.metin}</p>}
      <p className="alan-not">Hibrit modda geçerli. Hepsi Claude ve Hepsi yerel modları bütün ajanları tek motora alır.
        {ajan.secim ? " Bu ajan için senin seçimin geçerli." : " Şu an kartın varsayılanı geçerli."}</p>
    </div>
  );
}

function motorCumlesi(a: AjanOzeti, durum: DurumYaniti | null): { tur: "claude" | "yerel"; metin: string } {
  if (a.motor_yerel) {
    const d = durum?.motorlar[a.motor];
    return {
      tur: "yerel",
      metin: `Hibrit modda yerel modelde çalışır (${a.motor}, ${a.motor_modeli})${d && !d.hazir ? ", şu an hazır değil" : ""}. Hepsi Claude modunda ${a.model}.`,
    };
  }
  return { tur: "claude", metin: `Claude'da çalışır, model ${a.model}.` };
}

export function Ajanlar({ ajanlar, seciliId, durum, onDegisti }: { ajanlar: AjanOzeti[]; seciliId: string | null; durum: DurumYaniti | null; onDegisti: () => void }) {
  const secili = ajanlar.find((a) => a.id === seciliId) ?? ajanlar[0];
  return (
    <div className="iki-bolme">
      <nav className="iki-bolme-liste" aria-label="Ajanlar">
        <h1 className="sayfa-baslik">Ajanlar</h1>
        <p className="sayfa-giris">Her ajanın tek bir rolü ve yazılı sınırları var. Kartlar <code>ajanlar/</code> klasöründe; değiştirince Kovan'ı yeniden başlat.</p>
        <ul className="ajan-listesi">
          {ajanlar.map((a) => (
            <li key={a.id}>
              <a href={`#/ajanlar/${a.id}`} className="ajan-satiri" aria-current={secili?.id === a.id ? "page" : undefined}>
                <span className="ajan-kisa">{a.kisaltma}</span>
                <span className="ajan-satiri-ad">{a.ad}</span>
                <span className={`motor-etiket motor-etiket--${a.motor_yerel ? "yerel" : "claude"}`} title={`${a.motor} · ${a.motor_modeli}`}>{a.motor_yerel ? a.motor_modeli : `Claude ${a.model}`}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {secili && (
        <article className="iki-bolme-detay ajan-detay">
          <header>
            <h2 className="detay-baslik"><span className="ajan-kisa ajan-kisa--buyuk">{secili.kisaltma}</span>{secili.ad}</h2>
            <p className="detay-giris">{secili.aciklama}</p>
          </header>
          <dl className="ozellikler">
            <div><dt>Motor</dt><dd><span className={`motor-nokta motor-nokta--${motorCumlesi(secili, durum).tur}`} /> {motorCumlesi(secili, durum).metin}
              <MotorSecimi ajan={secili} durum={durum} onDegisti={onDegisti} /></dd></div>
            <div><dt>Üretir</dt><dd>{secili.uretir.length ? secili.uretir.join(", ") : "Üretici değil, yalnızca inceler."}</dd></div>
            <div><dt>Onay verir</dt><dd>{secili.onaylar.length ? secili.onaylar.join(", ") : "Onay kurullarında değil."}</dd></div>
            <div><dt>Araçlar</dt><dd>{secili.araclar.length ? <span className="cipler">{secili.araclar.map((t) => <code key={t}>{t}</code>)}</span> : "Araç yok: yalnızca metin üretir."}</dd></div>
            <div><dt>İzinli komutlar</dt><dd>{secili.izinli_komutlar.length ? <span className="cipler">{secili.izinli_komutlar.map((t) => <code key={t}>{t}</code>)}</span> : "Komut çalıştıramaz."}</dd></div>
            <div><dt>Sınırlar</dt><dd>En fazla {secili.sure_dk} dakika{secili.butce_usd !== null ? `, çağrı başına ${para(secili.butce_usd)}` : ""}. Sistem istemi: {secili.sistem_promptu === "degistir" ? "Claude Code'un varsayılanının yerine geçer" : "varsayılana eklenir"}.</dd></div>
          </dl>
          {secili.sinirlar && (
            <section className="detay-bolum">
              <h3>Yazılı sınırları</h3>
              <Markdown metin={secili.sinirlar} />
            </section>
          )}
          <details className="detay-bolum">
            <summary>Sistem istemi ({secili.dosya})</summary>
            <Markdown metin={secili.govde} />
          </details>
        </article>
      )}
    </div>
  );
}
