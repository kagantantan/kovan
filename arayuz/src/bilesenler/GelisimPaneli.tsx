// Teslimden sonra: Ürün Sahibi'nin önerilerine verdiğin kararlar (gelişim defteri) ve kabul ettiklerinle yeni sürüm.
import { useState } from "react";
import { api, type FikirDetayi, type GelisimKarari } from "../api";
import { git } from "../kullan";
import { Simge } from "./Simge";

const KARAR: Record<GelisimKarari, { ad: string; ton: string }> = {
  al: { ad: "sonraki sürüme", ton: "iyi" },
  degistir: { ad: "değiştirerek", ton: "iyi" },
  simdilik_hayir: { ad: "şimdilik hayır", ton: "sessiz" },
  asla: { ad: "bir daha önerme", ton: "kotu" },
};

export function GelisimPaneli({ detay, onBitti }: { detay: FikirDetayi; onBitti: () => void }) {
  const f = detay.fikir;
  const kayitlar = detay.gelisim.filter((g) => g.fikir_id === f.id);
  const [metin, setMetin] = useState(detay.sonraki_surum_metni ?? "");
  const [gonderiliyor, setGonderiliyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  if (!kayitlar.length && !f.sonraki_surum && !detay.sonraki_surum_metni) return null;
  const surum = (f.surum ?? 1) + 1;

  const baslat = async () => {
    setGonderiliyor(true);
    setHata(null);
    try {
      const { id } = await api.yeniSurum(f.id, metin);
      onBitti();
      git(`/fikirler/${id}`);
    } catch (e) {
      setHata((e as Error).message);
      setGonderiliyor(false);
    }
  };

  return (
    <section className="gelisim" aria-labelledby="gelisim-baslik">
      <h2 id="gelisim-baslik" className="gelisim-baslik">Gelişim defteri</h2>
      {kayitlar.length > 0 && (
        <ul className="gelisim-liste">
          {kayitlar.map((k) => (
            <li key={`${k.id}-${k.zaman}`} className="gelisim-kayit">
              <span className={`rozet rozet--${KARAR[k.karar].ton}`}>{KARAR[k.karar].ad}</span>
              <span className="gelisim-ad"><b>{k.id}</b> {k.baslik}</span>
              {k.not && <span className="gelisim-not">{k.not}</span>}
            </li>
          ))}
        </ul>
      )}
      {f.sonraki_surum ? (
        <p className="gelisim-sonraki"><Simge ad="tamam" /> Yeni sürüm başlatıldı: <a href={`#/fikirler/${f.sonraki_surum}`}>{f.sonraki_surum}</a></p>
      ) : detay.sonraki_surum_metni !== null && (
        <div className="gelisim-surum">
          <label className="alan">
            <span className="alan-ad">{surum}. sürümün fikri<span className="alan-ipucu"> (kabul ettiklerinden hazırlandı; istediğin gibi düzenle)</span></span>
            <textarea rows={7} value={metin} onChange={(e) => setMetin(e.target.value)} disabled={gonderiliyor} />
          </label>
          <p className="alan-ipucu">Önceki sürümün kodu, kararları ve bu defter yeni sürüme taşınır; aynı derin akıştan geçer.</p>
          {hata && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {hata}</p>}
          <button type="button" className="dugme dugme--birincil" disabled={gonderiliyor || !metin.trim()} onClick={baslat}>
            {gonderiliyor ? "Başlatılıyor..." : `${surum}. sürümü başlat`}
          </button>
        </div>
      )}
    </section>
  );
}
