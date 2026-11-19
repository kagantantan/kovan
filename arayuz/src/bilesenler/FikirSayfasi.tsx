// Bir fikrin sayfası: başlık ve ölçüler, petek şeridi, karar yuvası, zaman çizelgesi ve dosyalar.
import { useMemo, useState } from "react";
import { api, type DurumYaniti, type FikirDetayi, type Mod } from "../api";
import { FIKIR_DURUMU, MOD_ADI, para, sure } from "../bicim";
import { git, useYokla } from "../kullan";
import { DosyaGorunumu } from "./DosyaGorunumu";
import { GelisimPaneli } from "./GelisimPaneli";
import { KararPaneli } from "./KararPaneli";
import { Petek } from "./Petek";
import { PlanTablosu } from "./PlanTablosu";
import { Simge } from "./Simge";
import { SoruPaneli } from "./SoruPaneli";
import { ZamanCizelgesi } from "./ZamanCizelgesi";

interface Props {
  id: string;
  durum: DurumYaniti | null;
  ajanAdlari: Map<string, string>;
  onDegisti: () => void;
}

function ilkDosya(d: FikirDetayi): string | null {
  const uretilen = [...d.adimlar].reverse().find((a) => a.tip === "uret" && a.dosya.startsWith("belgeler/"));
  if (uretilen) return `belgeler/${uretilen.dosya.split("/").pop()!.replace(/-adim\d+\.md$/, ".md")}`;
  return d.dosyalar.belgeler[0]?.yol ?? null;
}

export function FikirSayfasi({ id, durum, ajanAdlari, onDegisti }: Props) {
  const [aralik, setAralik] = useState(1500);
  const { veri, hata, yenile } = useYokla(async () => {
    const d = await api.fikir(id);
    setAralik(d.fikir.durum === "calisiyor" || d.fikir.durum === "sirada" ? 1500 : 4000);
    return d;
  }, aralik, id);
  const [odak, setOdak] = useState<string | null>(null);
  const [secili, setSecili] = useState<string | null>(null);
  const [eylemHatasi, setEylemHatasi] = useState<string | null>(null);

  const yerelMi = useMemo(() => (motor: string) => Boolean(durum?.motorlar[motor]?.yerel), [durum]);
  const asamaAdlari = useMemo(() => new Map((veri?.asamalar ?? []).map((a) => [a.id, a.ad])), [veri?.asamalar]);

  if (hata && !veri) return <div className="sayfa-mesaj"><p className="hata-satiri"><Simge ad="uyari" /> {hata}</p></div>;
  if (!veri) return <div className="sayfa-mesaj"><p className="bos-not">Yükleniyor...</p></div>;

  const f = veri.fikir;
  const seciliDosya = secili ?? ilkDosya(veri);
  const calisan = f.durum === "calisiyor" || f.durum === "sirada";
  const bitti = () => { void yenile(); onDegisti(); };

  const eylem = async (is: () => Promise<unknown>) => {
    setEylemHatasi(null);
    try { await is(); bitti(); } catch (e) { setEylemHatasi((e as Error).message); }
  };

  const cagrilar = Object.entries(veri.motor_cagrilari);
  const claudeSayisi = cagrilar.filter(([m]) => m === "claude").reduce((t, [, n]) => t + n, 0);
  const yerelSayisi = cagrilar.filter(([m]) => yerelMi(m)).reduce((t, [, n]) => t + n, 0);
  const doluluk = f.butce_usd ? Math.min(1, f.maliyet_usd / f.butce_usd) : 0;
  const siradakiler = veri.asamalar.filter((a) => a.durum === "bekleyen").map((a) => a.ad);
  const ekipKarari = veri.kararlar.filter((k) => k.karar_veren === "ekip").length;

  return (
    <div className="fikir">
      <header className="fikir-ust">
        <div className="fikir-baslik-satir">
          <h1 className="fikir-baslik">{f.baslik}</h1>
          <div className="fikir-eylem">
            {(calisan || f.durum === "bekliyor") && (
              <button type="button" className="dugme dugme--ikincil" onClick={() => eylem(() => api.durdur(id))}>
                <Simge ad="dur" /> Durdur
              </button>
            )}
            {f.durum === "durduruldu" && (
              <button type="button" className="dugme dugme--birincil" onClick={() => eylem(() => api.devam(id))}>
                <Simge ad="oynat" /> Devam ettir
              </button>
            )}
            <button type="button" className="dugme dugme--ikincil" title={`Bu makinede: ${veri.klasor}`}
              onClick={() => eylem(() => api.klasorAc(id, veri.dosyalar.kod.length ? "kod" : ""))}>
              <Simge ad="klasor" /> {veri.dosyalar.kod.length ? "Kodu aç" : "Klasörü aç"}
            </button>
            {!calisan && (
              <button type="button" className="dugme dugme--ikincil" title="Listeden kaldırır; klasörü çöp kutusuna (calisma/.cop/) taşınır"
                onClick={async () => {
                  if (!window.confirm(`${f.id} "${f.baslik}" silinsin mi?\n\nListeden kalkar; klasörü calisma/.cop/ altına taşınır, oradan geri alınabilir.`)) return;
                  setEylemHatasi(null);
                  try { await api.sil(id); onDegisti(); git("/fikirler"); } catch (e) { setEylemHatasi((e as Error).message); }
                }}>
                <Simge ad="cop" /> Sil
              </button>
            )}
          </div>
        </div>
        <dl className="olculer">
          <div className={`olcu olcu--durum olcu--${f.durum}`}><dt>Durum</dt><dd>{FIKIR_DURUMU[f.durum]}</dd></div>
          <div className="olcu"><dt>Akış</dt><dd>{veri.akis_ad}
            {(f.surum ?? 1) > 1 && <span className="olcu-ek"> sürüm {f.surum}{f.temel_fikir ? <>, <a href={`#/fikirler/${f.temel_fikir}`}>{f.temel_fikir}</a> üzerine</> : null}</span>}
          </dd></div>
          <div className="olcu"><dt>Mod</dt><dd>
            {calisan || !durum ? MOD_ADI[f.motor] : (
              <select className="olcu-secim" value={f.motor} aria-label="Mod" title="Sonraki ajan çağrıları seçilen modda çalışır"
                onChange={(e) => eylem(() => api.modDegistir(id, e.target.value as Mod))}>
                {durum.modlar.map((m) => <option key={m} value={m}>{MOD_ADI[m]}</option>)}
              </select>
            )}
          </dd></div>
          {f.kaynak && (
            <div className="olcu" title={`Kilitli, salt okunur kopya. Alındığı yer: ${f.kaynak.yollar.join(", ")}`}>
              <dt>Mevcut sistem</dt>
              <dd>{f.kaynak.dosya_sayisi.toLocaleString("tr-TR")} dosya<span className="olcu-ek">, {f.kaynak.satir.toLocaleString("tr-TR")} satır</span></dd>
            </div>
          )}
          <div className="olcu">
            <dt>Ajan çağrısı</dt>
            <dd>{veri.ajan_cagrisi}
              {f.motor === "hibrit" && veri.ajan_cagrisi > 0 && <span className="olcu-ek"> Claude {claudeSayisi}, yerel {yerelSayisi}</span>}
            </dd>
          </div>
          {veri.kararlar.length > 0 && (
            <div className="olcu" title="Ajan soruları önce ekipte oylanır; oybirliği çıkarsa sana sorulmaz.">
              <dt>Kararlar</dt><dd>ekip {ekipKarari}, sen {veri.kararlar.length - ekipKarari}</dd>
            </div>
          )}
          <div className="olcu"><dt>Ajanların çalıştığı süre</dt><dd>{sure(veri.aktif_sure_sn)}</dd></div>
          <div className="olcu olcu--butce" title="Abonelikte faturalanmaz; kullanım limitinden ne kadar yediğini gösterir.">
            <dt>Kullanım / bütçe</dt>
            <dd>{para(f.maliyet_usd)} / {para(f.butce_usd)}</dd>
            <div className="butce-cizgi" aria-hidden="true"><span style={{ width: `${doluluk * 100}%` }} /></div>
          </div>
        </dl>
        <p className="fikir-klasor">
          Çıktılar bu makinede: <code>{veri.klasor}</code> · ürün kodu <code>kod/</code>, belgeler <code>belgeler/</code>
          {f.kaynak && <>, mevcut sistemin kilitli kopyası <code>kod/kaynak/</code></>}
          {veri.adrler.length > 0 && <>, ADR'ler <code>kod/adr/</code></>}
        </p>
        {eylemHatasi && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {eylemHatasi}</p>}
      </header>

      <Petek hucreler={veri.asamalar} tur={f.tur} ekTur={f.ek_tur} yerelMi={yerelMi} odak={odak}
        onSec={(a) => setOdak((o) => (o === a ? null : a))} etiket={`${veri.akis_ad} akışının aşamaları`} />
      {f.durum !== "tamamlandi" && siradakiler.length > 0 && (
        <p className="sirada"><span className="sirada-ad">Sırada</span> {siradakiler.slice(0, 7).join(" → ")}{siradakiler.length > 7 ? ` → +${siradakiler.length - 7}` : ""}</p>
      )}

      {f.durum === "bekliyor" && veri.bekleme && (veri.bekleme.sebep === "ajan_sorusu"
        ? <SoruPaneli key={veri.bekleme.adim_id} fikirId={id} bekleme={veri.bekleme} onBitti={bitti} />
        : <KararPaneli key={veri.bekleme.adim_id} fikirId={id} bekleme={veri.bekleme} onBitti={bitti} />)}
      {veri.plan && <PlanTablosu plan={veri.plan} onSec={(a) => setOdak(a)} />}
      {f.durum === "tamamlandi" && <GelisimPaneli key={`${f.id}-${veri.gelisim.length}-${f.sonraki_surum ?? ""}`} detay={veri} onBitti={bitti} />}

      <div className="calisma-alani">
        <section className="panel panel--cizelge" aria-label="Zaman çizelgesi">
          <h2 className="panel-baslik">Zaman çizelgesi</h2>
          <ZamanCizelgesi adimlar={veri.adimlar} asamaAdlari={asamaAdlari} yerelMi={yerelMi} odak={odak}
            seciliDosya={seciliDosya} onDosya={setSecili} />
        </section>
        <section className="panel panel--dosyalar" aria-label="Dosyalar">
          <DosyaGorunumu fikirId={id} detay={veri} secili={seciliDosya} onSec={setSecili} ajanAdlari={ajanAdlari} canli={calisan} />
        </section>
      </div>
    </div>
  );
}
