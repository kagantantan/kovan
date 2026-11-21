// Sol ray: fikirler. Kararını bekleyenler en üstte, sonra çalışanlar, sonra diğerleri.
import type { FikirOzeti } from "../api";
import { para } from "../bicim";
import { Altigen, Simge } from "./Simge";

const SIRA: Record<string, number> = { bekliyor: 0, calisiyor: 1, sirada: 1, durduruldu: 2, tamamlandi: 3 };
const TON: Record<string, string> = { bekliyor: "dikkat", calisiyor: "calisan", sirada: "calisan", durduruldu: "bos", tamamlandi: "iyi" };

function durumCumlesi(f: FikirOzeti): string {
  switch (f.durum) {
    case "bekliyor":
      switch (f.bekleme_sebebi) {
        case "ajan_sorusu": return `${f.asama_ad} aşamasında soru var`;
        case "tur_siniri": return `${f.asama_ad}: onay alınamadı`;
        case "hata": return `${f.asama_ad}: bir adım tamamlanamadı`;
        case "butce": return "Bütçe doldu";
        case "kesildi": return `${f.asama_ad}: yarıda kaldı`;
        default: return "Teslim onayını bekliyor";
      }
    case "calisiyor": return `${f.asama_ad} çalışıyor (${f.asama_no}/${f.asama_sayisi})`;
    case "sirada": return `Sırada: ${f.asama_ad}`;
    case "durduruldu": return `Durduruldu: ${f.asama_ad}`;
    case "tamamlandi": return "Tamamlandı";
  }
}

export function FikirListesi({ fikirler, seciliId }: { fikirler: FikirOzeti[]; seciliId: string | null }) {
  const sirali = [...fikirler].sort((a, b) => SIRA[a.durum] - SIRA[b.durum] || b.olusturma.localeCompare(a.olusturma) || b.id.localeCompare(a.id));
  if (!sirali.length) return <p className="bos-not ray-bos">Henüz fikir yok. İlk fikrini yaz; ekip devralsın.</p>;
  return (
    <ul className="fikir-listesi">
      {sirali.map((f) => (
        <li key={f.id}>
          <a href={`#/fikirler/${f.id}`} className={`fikir-satiri fikir-satiri--${f.durum}`} aria-current={seciliId === f.id ? "page" : undefined}>
            <Altigen ton={TON[f.durum]} boyut={11} dolu={f.durum !== "durduruldu"} />
            <span className="fikir-satiri-govde">
              <span className="fikir-satiri-baslik">{f.baslik}</span>
              <span className="fikir-satiri-durum">
                <span>{durumCumlesi(f)}{(f.birader === "VETO" || f.birader === "DIKKAT") && (
                  <span className={`fikir-satiri-goz fikir-satiri-goz--${f.birader === "VETO" ? "veto" : "dikkat"}`}
                    title={f.birader === "VETO" ? "Büyük Birader son aşamayı veto etti" : "Büyük Birader'in bir uyarısı var"}><Simge ad="goz" boyut={13} /></span>
                )}</span>
                <span className="fikir-satiri-para">{para(f.maliyet_usd)}</span>
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
