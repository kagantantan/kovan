// Kovan arayüzü: üst çubuk + sayfalar (fikirler, yeni fikir, ajanlar, akışlar, ayarlar).
import { useEffect, useMemo, useRef } from "react";
import { api, type FikirOzeti } from "./api";
import { Ajanlar } from "./bilesenler/Ajanlar";
import { Akislar } from "./bilesenler/Akislar";
import { Ayarlar } from "./bilesenler/Ayarlar";
import { FikirListesi } from "./bilesenler/FikirListesi";
import { FikirSayfasi } from "./bilesenler/FikirSayfasi";
import { Simge } from "./bilesenler/Simge";
import { UstCubuk } from "./bilesenler/UstCubuk";
import { YeniFikir } from "./bilesenler/YeniFikir";
import { useRota, useYokla } from "./kullan";

/** Adres bir fikir göstermiyorsa: önce kararını bekleyen, yoksa çalışan, yoksa en yeni fikir. */
function enOnemli(fikirler: FikirOzeti[]): string | null {
  const sira = (f: FikirOzeti) => ({ bekliyor: 0, calisiyor: 1, sirada: 1, durduruldu: 2, tamamlandi: 2 })[f.durum];
  return [...fikirler].sort((a, b) => sira(a) - sira(b) || b.olusturma.localeCompare(a.olusturma) || b.id.localeCompare(a.id))[0]?.id ?? null;
}

/** Bir fikir kararını beklemeye başlayınca (sekme arka plandaysa) masaüstü bildirimi. */
function useBildirim(fikirler: FikirOzeti[] | null) {
  const gorulen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!fikirler) return;
    const bekleyenler = fikirler.filter((f) => f.durum === "bekliyor");
    const anahtarlar = new Set(bekleyenler.map((f) => `${f.id}@${f.guncelleme}`));
    if (gorulen.current === null) { gorulen.current = anahtarlar; return; }   // açılışta var olanlar için bildirim yok
    const yeni = bekleyenler.filter((f) => !gorulen.current!.has(`${f.id}@${f.guncelleme}`));
    gorulen.current = anahtarlar;
    if (!yeni.length || !("Notification" in window) || Notification.permission !== "granted") return;
    if (!document.hidden && document.hasFocus()) return;
    for (const f of yeni) {
      const b = new Notification(`Kovan: ${f.baslik}`, {
        body: f.bekleme_sebebi === "ajan_sorusu" ? `${f.asama_ad} aşamasında bir ajan soruyor.` : `${f.asama_ad}: kararın bekleniyor.`,
        tag: f.id,
      });
      b.onclick = () => { window.focus(); window.location.hash = `#/fikirler/${f.id}`; b.close(); };
    }
  }, [fikirler]);
}

export function App() {
  const rota = useRota();
  const durum = useYokla(api.durum, 15_000, "durum");
  const fikirler = useYokla(api.fikirler, 2_000, "fikirler");
  const ajanlar = useYokla(api.ajanlar, null, "ajanlar");
  const akislar = useYokla(api.akislar, null, "akislar");
  const ajanAdlari = useMemo(() => new Map((ajanlar.veri ?? []).map((a) => [a.id, a.ad])), [ajanlar.veri]);

  const bekleyen = fikirler.veri?.filter((f) => f.durum === "bekliyor").length ?? 0;
  useEffect(() => { document.title = bekleyen ? `(${bekleyen}) Kovan` : "Kovan"; }, [bekleyen]);
  useBildirim(fikirler.veri);

  const fikirSayfasi = rota.sayfa === "fikirler" || rota.sayfa === "yeni";
  const seciliId = rota.sayfa === "fikirler" ? rota.id ?? (fikirler.veri ? enOnemli(fikirler.veri) : null) : null;
  const yeniGoster = rota.sayfa === "yeni" || (rota.sayfa === "fikirler" && fikirler.veri !== null && fikirler.veri.length === 0);

  return (
    <div className="uygulama">
      <UstCubuk rota={rota} durum={durum.veri} bekleyen={bekleyen} />
      {fikirler.hata && <div className="baglanti-uyarisi" role="alert"><Simge ad="uyari" /> {fikirler.hata}</div>}
      {fikirSayfasi ? (
        <div className="fikirler-duzeni">
          <aside className="ray" aria-label="Fikirler">
            <a href="#/yeni" className="dugme dugme--birincil ray-yeni" aria-current={rota.sayfa === "yeni" ? "page" : undefined}>
              <Simge ad="arti" /> Yeni fikir
            </a>
            {fikirler.veri && <FikirListesi fikirler={fikirler.veri} seciliId={yeniGoster ? null : seciliId} />}
          </aside>
          <main className="icerik">
            {yeniGoster ? (
              akislar.veri ? <YeniFikir akislar={akislar.veri} durum={durum.veri} onOlustu={() => void fikirler.yenile()} /> : <p className="bos-not">Yükleniyor...</p>
            ) : seciliId ? (
              <FikirSayfasi key={seciliId} id={seciliId} durum={durum.veri} ajanAdlari={ajanAdlari} onDegisti={() => void fikirler.yenile()} />
            ) : (
              <p className="bos-not">Yükleniyor...</p>
            )}
          </main>
        </div>
      ) : rota.sayfa === "ajanlar" ? (
        <main className="icerik icerik--genis">{ajanlar.veri ? <Ajanlar ajanlar={ajanlar.veri} seciliId={rota.id} durum={durum.veri} onDegisti={() => void ajanlar.yenile()} /> : <p className="bos-not">Yükleniyor...</p>}</main>
      ) : rota.sayfa === "ayarlar" ? (
        <main className="icerik icerik--genis"><Ayarlar durum={durum.veri} onDegisti={() => void durum.yenile()} /></main>
      ) : (
        <main className="icerik icerik--genis">{akislar.veri ? <Akislar akislar={akislar.veri} /> : <p className="bos-not">Yükleniyor...</p>}</main>
      )}
    </div>
  );
}
