// Ajanlar: her ajanın rolü, motoru, araçları, izinli komutları ve sınırları.
import type { AjanOzeti, DurumYaniti } from "../api";
import { para } from "../bicim";
import { Markdown } from "./Markdown";

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

export function Ajanlar({ ajanlar, seciliId, durum }: { ajanlar: AjanOzeti[]; seciliId: string | null; durum: DurumYaniti | null }) {
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
                <span className={`motor-etiket motor-etiket--${a.motor_yerel ? "yerel" : "claude"}`}>{a.motor_yerel ? "yerel" : "Claude"}</span>
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
            <div><dt>Motor</dt><dd><span className={`motor-nokta motor-nokta--${motorCumlesi(secili, durum).tur}`} /> {motorCumlesi(secili, durum).metin}</dd></div>
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
