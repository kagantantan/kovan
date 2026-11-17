// Yeni fikir: metin, akış ve mod. Örnek fikirler Flora AI'dan.
import { useEffect, useState } from "react";
import { api, type AkisOzeti, type DurumYaniti, type Mod } from "../api";
import { MOD_ACIKLAMA, MOD_ADI, para } from "../bicim";
import { git } from "../kullan";
import { Petek, akisHucreleri } from "./Petek";
import { Secenek } from "./Secenek";
import { Simge } from "./Simge";

const ORNEKLER = [
  {
    ad: "Flora AI analiz kredisi",
    profil: "mini",
    metin: "Flora AI analiz kredisi: ücretsiz kullanıcıya haftada 3 bitki fotoğrafı analizi hakkı veren, premium kullanıcıda sınırsız olan bir kredi modülü. Hak sunucu tarafında sayılır ve her pazartesi sıfırlanır; hak bitince kullanıcıya ne zaman yenileneceğini söyleyen anlaşılır bir mesaj döner.",
  },
  {
    ad: "Flora AI bakım paneli",
    profil: "tam-yigin",
    metin: "Flora AI bakım paneli (web): kullanıcı bitkisini ekler (ad, tür, gün olarak sulama aralığı, son sulama tarihi). Panelde 'bugün sulanacaklar' listesi ve her bitkinin bir sonraki sulama tarihi görünür; 'Suladım' ile işaretlenir. Boş ad ya da geçersiz aralıkta anlaşılır hata mesajı gösterilir.",
  },
];

const MODLAR: Mod[] = ["hibrit", "claude", "deneme"];

export function YeniFikir({ akislar, durum, onOlustu }: { akislar: AkisOzeti[]; durum: DurumYaniti | null; onOlustu: () => void }) {
  const [metin, setMetin] = useState("");
  const [baslik, setBaslik] = useState("");
  const [profil, setProfil] = useState(akislar[0]?.id ?? "");
  const [mod, setMod] = useState<Mod>(durum?.varsayilan_motor ?? "hibrit");
  const [gonderiliyor, setGonderiliyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);

  useEffect(() => { if (!profil && akislar[0]) setProfil(akislar[0].id); }, [akislar, profil]);
  useEffect(() => { if (durum) setMod((m) => (m === "hibrit" && durum.varsayilan_motor !== "hibrit" ? durum.varsayilan_motor : m)); }, [durum]);

  const motorUyarisi = (m: Mod): string | null => {
    if (!durum || m === "deneme") return null;
    const claude = durum.motorlar.claude;
    if (claude && !claude.hazir) return `Claude hazır değil: ${claude.hata ?? ""}`;
    if (m === "hibrit") {
      const yerel = Object.entries(durum.motorlar).find(([, d]) => d.yerel && !d.hazir);
      if (yerel) return `Yerel motor hazır değil: ${yerel[1].hata ?? ""}`;
    }
    return null;
  };

  const baslat = async () => {
    setGonderiliyor(true);
    setHata(null);
    try {
      const { id } = await api.yeniFikir({ baslik: baslik.trim(), metin: metin.trim(), profil, motor: mod });
      onOlustu();
      git(`/fikirler/${id}`);
    } catch (e) {
      setHata((e as Error).message);
      setGonderiliyor(false);
    }
  };

  const secilenAkis = akislar.find((a) => a.id === profil);

  return (
    <div className="yeni">
      <header className="yeni-ust">
        <h1 className="sayfa-baslik">Yeni fikir</h1>
        <p className="sayfa-giris">Fikrini yaz, akışı seç. Ürün sahibi brife çevirir, ekip aşama aşama ilerler; karar gereken yerde sana sorulur.</p>
        <div className="ornekler">
          <span className="ornekler-ad">Örnekle doldur:</span>
          {ORNEKLER.map((o) => (
            <button key={o.ad} type="button" className="dugme dugme--ikincil dugme--kucuk"
              onClick={() => { setMetin(o.metin); setBaslik(o.ad); if (akislar.some((a) => a.id === o.profil)) setProfil(o.profil); }}>
              {o.ad}
            </button>
          ))}
        </div>
      </header>

      <form className="yeni-form" onSubmit={(e) => { e.preventDefault(); if (metin.trim()) void baslat(); }}>
        <label className="alan">
          <span className="alan-ad">Fikrin</span>
          <textarea rows={6} value={metin} onChange={(e) => setMetin(e.target.value)} required
            placeholder="Ne yapılsın, kimin için, neyi başarınca bitmiş sayılır?" />
        </label>
        <label className="alan">
          <span className="alan-ad">Başlık<span className="alan-ipucu"> boş bırakırsan ilk satırdan alınır</span></span>
          <input type="text" value={baslik} onChange={(e) => setBaslik(e.target.value)} maxLength={90} />
        </label>

        <fieldset className="alan-grubu">
          <legend className="alan-ad">Akış</legend>
          <div className="secenekler secenekler--izgara">
            {akislar.map((a) => (
              <Secenek key={a.id} grup="akis" tip="radio" secili={profil === a.id} onDegis={() => setProfil(a.id)}
                etiket={a.ad} aciklama={`${a.aciklama} Fikir bütçesi ${para(a.fikir_butcesi_usd)}.`} />
            ))}
          </div>
          {secilenAkis && (
            <div className="yeni-petek">
              <Petek etiket={`${secilenAkis.ad} akışının aşamaları`} hucreler={akisHucreleri(secilenAkis)} />
            </div>
          )}
        </fieldset>

        <fieldset className="alan-grubu">
          <legend className="alan-ad">Mod</legend>
          <div className="secenekler secenekler--izgara">
            {MODLAR.map((m) => {
              const uyari = motorUyarisi(m);
              return (
                <Secenek key={m} grup="mod" tip="radio" secili={mod === m} onDegis={() => setMod(m)} etiket={MOD_ADI[m]} aciklama={MOD_ACIKLAMA[m]}>
                  {uyari && <span className="secenek-uyari"><Simge ad="uyari" boyut={14} /> {uyari}</span>}
                </Secenek>
              );
            })}
          </div>
        </fieldset>

        {hata && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {hata}</p>}
        <div className="yeni-alt">
          <button type="submit" className="dugme dugme--birincil" disabled={!metin.trim() || !profil || gonderiliyor}>
            {gonderiliyor ? "Başlatılıyor..." : "Fikri başlat"}
          </button>
        </div>
      </form>
    </div>
  );
}
