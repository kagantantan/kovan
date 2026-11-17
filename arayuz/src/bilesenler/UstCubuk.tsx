// Üst çubuk: marka, gezinme, motorların durumu ve bildirim izni.
import { useState } from "react";
import type { DurumYaniti } from "../api";
import type { Rota } from "../kullan";
import { Simge } from "./Simge";

function Logo() {
  return (
    <svg className="marka-logo" width="22" height="25" viewBox="0 0 100 115.47" aria-hidden="true">
      <polygon className="marka-dis" points="50,4 96,30.6 96,84.9 50,111.5 4,84.9 4,30.6" />
      <polygon className="marka-ic" points="50,36 66,45.2 66,70.2 50,79.4 34,70.2 34,45.2" />
    </svg>
  );
}

function MotorDurumu({ durum }: { durum: DurumYaniti | null }) {
  if (!durum) return null;
  const motorlar = Object.entries(durum.motorlar).filter(([ad]) => ad !== "deneme");
  return (
    <>
      {motorlar.map(([ad, m]) => {
        const tur = m.yerel ? "yerel" : "claude";
        const ad_ = m.yerel ? `Yerel (${m.model ?? ad})` : "Claude";
        return (
          <details key={ad} className={`motor-durumu${m.hazir ? "" : " motor-durumu--degil"}`}>
            <summary title={m.hazir ? `${ad_} hazır` : `${ad_} hazır değil`}>
              <span className={`motor-nokta motor-nokta--${tur}${m.hazir ? "" : " motor-nokta--yok"}`} />
              {m.yerel ? "Yerel" : "Claude"}
              <span className="motor-durumu-hal">{m.hazir ? "hazır" : "hazır değil"}</span>
            </summary>
            <div className="acilir">
              <p className="acilir-baslik">{ad_}</p>
              {m.hata ? <p className="hata-satiri"><Simge ad="uyari" /> {m.hata}</p> : <p>Hazır. Ajanlar bu motorla çalışabilir.</p>}
              <dl className="acilir-liste">
                {m.yerel && m.adres && <><dt>Ollama</dt><dd>{m.adres}{m.ollama_surum ? `, sürüm ${m.ollama_surum}` : ""}</dd></>}
                {m.yerel && m.model && <><dt>Model</dt><dd><code>{m.model}</code></dd></>}
                {m.surum && <><dt>Claude Code</dt><dd>{m.surum}</dd></>}
                {m.yol && <><dt>Komut</dt><dd><code>{m.yol}</code></dd></>}
              </dl>
            </div>
          </details>
        );
      })}
    </>
  );
}

function BildirimDugmesi() {
  const destek = typeof window !== "undefined" && "Notification" in window;
  const [izin, setIzin] = useState<NotificationPermission>(destek ? Notification.permission : "denied");
  if (!destek) return null;
  if (izin === "granted") {
    return <span className="bildirim bildirim--acik" title="Bir fikir kararını beklediğinde bildirim gelir"><Simge ad="zil" /></span>;
  }
  if (izin === "denied") {
    return <span className="bildirim" title="Bildirimler tarayıcı ayarlarında kapalı"><Simge ad="zilKapali" /></span>;
  }
  return (
    <button type="button" className="dugme dugme--ikincil dugme--kucuk" onClick={async () => setIzin(await Notification.requestPermission())}
      title="Bir fikir kararını beklediğinde masaüstü bildirimi gelsin">
      <Simge ad="zil" boyut={14} /> Bildirim al
    </button>
  );
}

export function UstCubuk({ rota, durum, bekleyen }: { rota: Rota; durum: DurumYaniti | null; bekleyen: number }) {
  const sayfa = rota.sayfa === "yeni" ? "fikirler" : rota.sayfa;
  return (
    <header className="ust-cubuk">
      <a href="#/fikirler" className="marka"><Logo /> Kovan</a>
      <nav className="ana-gezinme" aria-label="Ana gezinme">
        <a href="#/fikirler" aria-current={sayfa === "fikirler" ? "page" : undefined}>
          Fikirler{bekleyen > 0 && <span className="sayac" title={`${bekleyen} fikir kararını bekliyor`}>{bekleyen}</span>}
        </a>
        <a href="#/ajanlar" aria-current={sayfa === "ajanlar" ? "page" : undefined}>Ajanlar</a>
        <a href="#/akislar" aria-current={sayfa === "akislar" ? "page" : undefined}>Akışlar</a>
      </nav>
      <div className="ust-sag">
        <MotorDurumu durum={durum} />
        <BildirimDugmesi />
      </div>
    </header>
  );
}
