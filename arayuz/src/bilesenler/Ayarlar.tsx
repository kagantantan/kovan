// Ayarlar: kurum LLM'inin (OpenAI uyumlu motor) API anahtarı ve bağlantı denemesi.
// Anahtar yalnızca sunucuya gider; sunucu onu hiçbir yanıtta geri vermez, bu ekran da göstermez.
import { useState, type FormEvent } from "react";
import { ApiHatasi, api, type AnahtarKaynagi, type BaglantiSonucu, type DurumYaniti, type MotorDurumu } from "../api";
import { Simge } from "./Simge";

const KAYNAK_ADI: Record<AnahtarKaynagi, string> = {
  ekran: "Bu ekrandan girildi; yalnızca bellekte, Kovan kapanınca silinir",
  kasa: "İşletim sisteminin kasasında",
  dosya: "Ayar dosyasındaki anahtar_dosyasi",
  degisken: "Ayar dosyasındaki anahtar_degiskeni (ortam değişkeni)",
};

function MotorAyari({ ad, m, onDegisti }: { ad: string; m: MotorDurumu; onDegisti: () => void }) {
  const [anahtar, setAnahtar] = useState("");
  const [kalici, setKalici] = useState(false);
  const [mesgul, setMesgul] = useState<null | "kaydet" | "dene" | "sil">(null);
  const [sonuc, setSonuc] = useState<BaglantiSonucu | null>(null);
  const [hata, setHata] = useState<string | null>(null);
  const durum = sonuc ?? m;
  const kaynak = durum.anahtar_kaynagi ?? null;

  async function yap(tur: "kaydet" | "dene" | "sil", is: () => Promise<BaglantiSonucu>) {
    setMesgul(tur);
    setHata(null);
    try {
      setSonuc(await is());
      if (tur === "kaydet") setAnahtar("");
      onDegisti();
    } catch (e) {
      setHata(e instanceof ApiHatasi ? e.message : "İstek başarısız.");
    } finally {
      setMesgul(null);
    }
  }

  function kaydet(e: FormEvent) {
    e.preventDefault();
    if (!anahtar.trim()) { setHata("Önce API anahtarını yaz."); return; }
    void yap("kaydet", () => api.anahtarAyarla(ad, anahtar, kalici));
  }

  return (
    <section className="ayar-motor" aria-labelledby={`motor-${ad}`}>
      <div className="ayar-motor-ust">
        <h2 id={`motor-${ad}`} className="ayar-motor-ad">{ad}</h2>
        <span className={`rozet ${durum.hazir ? "rozet--iyi" : "rozet--kotu"}`}>{durum.hazir ? "bağlı" : "bağlı değil"}</span>
      </div>
      <dl className="ayar-liste">
        <dt>Adres</dt><dd><code>{m.adres ?? "-"}</code></dd>
        <dt>Model</dt><dd><code>{m.model ?? "-"}</code></dd>
        <dt>Anahtar başlığı</dt><dd><code>{m.anahtar_basligi === "Authorization" || !m.anahtar_basligi ? "Authorization: Bearer …" : `${m.anahtar_basligi}: …`}</code></dd>
        <dt>Anahtarın yeri</dt><dd>{kaynak ? KAYNAK_ADI[kaynak] : "Yok"}</dd>
      </dl>
      {durum.hazir
        ? <p className="ayar-sonuc ayar-sonuc--iyi"><Simge ad="tamam" /> Bağlantı tamam.{sonuc?.modeller?.length ? ` Sunucudaki modeller: ${sonuc.modeller.slice(0, 6).join(", ")}${sonuc.modeller.length > 6 ? "…" : ""}` : ""}</p>
        : durum.hata && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {durum.hata}</p>}

      <form className="ayar-form" onSubmit={kaydet}>
        <label className="alan">
          <span className="alan-ad">API anahtarı<span className="alan-ipucu"> {kaynak ? "yenisini yazarsan eskisinin yerine geçer" : "kurumun verdiği anahtar"}</span></span>
          <input type="password" value={anahtar} onChange={(e) => { setAnahtar(e.target.value); setHata(null); }}
            autoComplete="off" spellCheck={false} className="girdi--kod" placeholder="••••••••" aria-label={`${ad} API anahtarı`} />
        </label>
        <label className={`ayar-kutu${m.kasa ? "" : " ayar-kutu--kapali"}`}>
          <input type="checkbox" checked={kalici && Boolean(m.kasa)} disabled={!m.kasa} onChange={(e) => setKalici(e.target.checked)} />
          <span>
            {m.kasa ? <>Kalıcı olarak <b>{m.kasa}</b>'ne kaydet</> : "Bu makinede işletim sistemi kasası yok"}
            <span className="alan-not"> {m.kasa
              ? "İşaretlemezsen anahtar yalnızca bellekte durur; Kovan kapanınca yeniden girmen gerekir. Diske düz metin olarak hiç yazılmaz."
              : "Anahtar yalnızca bellekte durur; Kovan kapanınca yeniden gir."}</span>
          </span>
        </label>
        {hata && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {hata}</p>}
        <div className="ayar-dugmeler">
          <button type="submit" className="dugme dugme--birincil" disabled={mesgul !== null}>{mesgul === "kaydet" ? "Deneniyor..." : "Kaydet ve dene"}</button>
          <button type="button" className="dugme dugme--ikincil" disabled={mesgul !== null} onClick={() => void yap("dene", () => api.baglantiDene(ad))}>
            {mesgul === "dene" ? "Deneniyor..." : "Bağlantıyı dene"}
          </button>
          {(kaynak === "ekran" || kaynak === "kasa") && (
            <button type="button" className="dugme dugme--ikincil" disabled={mesgul !== null} onClick={() => void yap("sil", () => api.anahtarSil(ad))}>
              Anahtarı sil
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

export function Ayarlar({ durum, onDegisti }: { durum: DurumYaniti | null; onDegisti: () => void }) {
  if (!durum) return <p className="bos-not">Yükleniyor...</p>;
  const motorlar = Object.entries(durum.motorlar).filter(([, m]) => m.tur === "openai");
  return (
    <div className="ayarlar">
      <header>
        <h1 className="sayfa-baslik">Ayarlar</h1>
        <p className="sayfa-giris">Kurum LLM'inin API anahtarı. Anahtar yalnızca bu makinedeki Kovan sunucusuna gider; hiçbir ekranda, günlükte ya da
          ayar dosyasında görünmez. Adres ve model dış ayar dosyasında{durum.dis_ayar ? <> (<code>{durum.dis_ayar}</code>)</> : null} durur.</p>
      </header>
      {motorlar.length === 0 ? (
        <div className="gizlilik" role="note">
          <Simge ad="uyari" boyut={16} />
          <div>
            <p><b>Tanımlı bir kurum LLM'i yok.</b> Önce dış ayar dosyasında <code>tur: openai</code> bir motor tanımla (adres ve model);
              örnek: <code>ornekler/kurum-ayar.ornek.yaml</code>. Kovan'ı o dosyayla başlatınca anahtarı buradan girebilirsin.</p>
          </div>
        </div>
      ) : motorlar.map(([ad, m]) => <MotorAyari key={ad} ad={ad} m={m} onDegisti={onDegisti} />)}
    </div>
  );
}
