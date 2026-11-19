// Yeni fikir: metin, akış, mevcut sistem (replatform), hedef yığın ve mod. Örnek fikirler Flora AI'dan,
// replatform örneği Kovan'la gelen kurgusal kart reeskont gün sonundan.
import { useEffect, useState } from "react";
import { api, type AkisOzeti, type DurumYaniti, type Mod } from "../api";
import { MOD_ACIKLAMA, MOD_ADI, para } from "../bicim";
import { git } from "../kullan";
import { Petek, akisHucreleri } from "./Petek";
import { Secenek } from "./Secenek";
import { Simge } from "./Simge";

interface Ornek { ad: string; profil: string; metin: string; ornekKaynak?: boolean; hedef?: string }

const ORNEKLER: Ornek[] = [
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
  {
    ad: "Kart reeskont gün sonu",
    profil: "replatform",
    ornekKaynak: true,
    hedef: "java21-spring-maven",
    metin: "Kredi kartı gün sonunda faiz işleyen kartların günlük faiz tahakkukunu (reeskont) hesaplayıp hareket, özet bakiye ve muhasebe fişi yazan işi yeniden yaz. Önce eski sistemi kodundan ve analiz dokümanından anla; korunan kurallarda eski çıktıyla birebir aynı sonucu veren, temiz bir mimari kur. Kod benim sistemime entegre edilecek: veritabanı, muhasebe ve parametre erişimi port olsun, adaptörleri ben yazacağım.",
  },
];

const MODLAR: Mod[] = ["hibrit", "claude", "yerel", "deneme"];
const OZEL = "ozel";

export function YeniFikir({ akislar, durum, onOlustu }: { akislar: AkisOzeti[]; durum: DurumYaniti | null; onOlustu: () => void }) {
  const [metin, setMetin] = useState("");
  const [baslik, setBaslik] = useState("");
  const [profil, setProfil] = useState(akislar[0]?.id ?? "");
  const [mod, setMod] = useState<Mod>(durum?.varsayilan_motor ?? "hibrit");
  const [kaynaklar, setKaynaklar] = useState("");
  const [hedef, setHedef] = useState("");
  const [ozelHedef, setOzelHedef] = useState("");
  const [gonderiliyor, setGonderiliyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);

  useEffect(() => { if (!profil && akislar[0]) setProfil(akislar[0].id); }, [akislar, profil]);
  useEffect(() => { if (durum) setMod((m) => (m === "hibrit" && durum.varsayilan_motor !== "hibrit" ? durum.varsayilan_motor : m)); }, [durum]);
  // Bu kurulumda açık modlar (dış ayarla daraltılabilir; Claude kapalıysa Hepsi Claude yok)
  const modlar = MODLAR.filter((m) => !durum || durum.modlar.includes(m));
  const yerelMotor = durum?.yerel_motor ? durum.motorlar[durum.yerel_motor] : null;
  // Seçili mod bu kurulumda kapalıysa (ör. dış ayar yerel modu kapattı) açık olan ilk moda geç; hiçbir mod seçilmemiş görünmesin.
  useEffect(() => { if (durum && modlar.length && !modlar.includes(mod)) setMod(modlar[0]); }, [durum, mod, modlar.join()]);

  const motorUyarisi = (m: Mod): string | null => {
    if (!durum || m === "deneme") return null;
    if (m === "yerel") {
      if (!durum.yerel_motor) return "Ayarlarda yerel motor tanımlı değil.";
      return yerelMotor && !yerelMotor.hazir ? `Yerel motor (${durum.yerel_motor}) hazır değil: ${yerelMotor.hata ?? ""}` : null;
    }
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
      const { id } = await api.yeniFikir({
        baslik: baslik.trim(), metin: metin.trim(), profil, motor: mod,
        kaynaklar: kaynakGerekli ? kaynaklar.split("\n").map((y) => y.trim()).filter(Boolean) : [],
        hedef_yigin: hedef === OZEL ? ozelHedef.trim() : hedef,
      });
      onOlustu();
      git(`/fikirler/${id}`);
    } catch (e) {
      setHata((e as Error).message);
      setGonderiliyor(false);
    }
  };

  const secilenAkis = akislar.find((a) => a.id === profil);
  const kaynakGerekli = secilenAkis?.kaynak === "zorunlu";
  const hazirYigin = durum?.hedef_yiginlar.find((h) => h.id === hedef);
  const hazir = Boolean(metin.trim() && profil && (!kaynakGerekli || kaynaklar.trim()) && (hedef !== OZEL || ozelHedef.trim()));
  const doldur = (o: Ornek) => {
    setMetin(o.metin);
    setBaslik(o.ad);
    if (akislar.some((a) => a.id === o.profil)) setProfil(o.profil);
    if (o.ornekKaynak && durum?.ornek_kaynak) setKaynaklar(durum.ornek_kaynak);
    setHedef(o.hedef ?? "");
  };

  return (
    <div className="yeni">
      <header className="yeni-ust">
        <h1 className="sayfa-baslik">Yeni fikir</h1>
        <p className="sayfa-giris">Fikrini yaz, akışı seç. Ürün sahibi brife çevirir, ekip aşama aşama ilerler; karar gereken yerde sana sorulur.</p>
        <div className="ornekler">
          <span className="ornekler-ad">Örnekle doldur:</span>
          {ORNEKLER.filter((o) => akislar.some((a) => a.id === o.profil) && (!o.ornekKaynak || durum?.ornek_kaynak)).map((o) => (
            <button key={o.ad} type="button" className="dugme dugme--ikincil dugme--kucuk" onClick={() => doldur(o)}>
              {o.ad}
            </button>
          ))}
        </div>
      </header>

      <form className="yeni-form" onSubmit={(e) => { e.preventDefault(); if (hazir) void baslat(); }}>
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

        {kaynakGerekli && (
          <fieldset className="alan-grubu">
            <legend className="alan-ad">Mevcut sistem</legend>
            <label className="alan">
              <span className="alan-ad">Kaynaklar<span className="alan-ipucu"> bu makinedeki klasör, .zip ya da dosya yolları; her satıra bir yol</span></span>
              <textarea rows={3} className="girdi--kod" value={kaynaklar} onChange={(e) => setKaynaklar(e.target.value)} required spellCheck={false}
                placeholder={"/Users/sen/eski-sistem/gunsonu\n/Users/sen/Belgeler/reeskont-analiz.docx"} />
            </label>
            <p className="alan-not">
              Kod ve analiz dokümanı birlikte. Kopyası alınır, aslına dokunulmaz; kopya kilitlenir, ajanlar yalnızca okur.
              .git, node_modules, target ve ikili dosyalar alınmaz. Word belgeleri HTML'e, Windows-1254 ve UTF-16 dosyalar UTF-8'e çevrilir.
            </p>
            {(mod === "hibrit" || mod === "claude") && (
              <div className="gizlilik" role="note">
                <Simge ad="uyari" boyut={16} />
                <div>
                  <p><b>{MOD_ADI[mod]} modunda kodun ve dokümanların içeriği Claude'a gider.</b> Kurum içi bir sistemse önce kurumunun
                    politikasına bak. {modlar.includes("yerel")
                      ? "Hiçbir şeyin bu makineden çıkmaması gerekiyorsa Hepsi yerel modunu seç; ya da önce adları ve verileri anonimleştirilmiş bir kopyayla dene."
                      : "Bu uyarı seçimi engellemez; hassas bir sistemse adları ve verileri anonimleştirilmiş bir kopyayla dene. Bu kurulumda yerel mod kapalı."}</p>
                  {modlar.includes("yerel") && (
                    <button type="button" className="dugme dugme--ikincil dugme--kucuk" onClick={() => setMod("yerel")}>Hepsi yerel modunu seç</button>
                  )}
                </div>
              </div>
            )}
          </fieldset>
        )}

        {durum && durum.hedef_yiginlar.length > 0 && (
          <fieldset className="alan-grubu">
            <legend className="alan-ad">Hedef yığın<span className="alan-ipucu"> yeni kod hangi teknolojiyle yazılsın; seçmezsen mimar önerir</span></legend>
            <select value={hedef} onChange={(e) => setHedef(e.target.value)} aria-label="Hedef yığın">
              <option value="">Mimar önersin</option>
              {durum.hedef_yiginlar.map((h) => <option key={h.id} value={h.id}>{h.ad}</option>)}
              <option value={OZEL}>Başka bir yığın yazacağım</option>
            </select>
            {hazirYigin && <p className="alan-not">{hazirYigin.aciklama}</p>}
            {hedef === OZEL && (
              <input type="text" value={ozelHedef} onChange={(e) => setOzelHedef(e.target.value)} maxLength={300} required
                placeholder="ör. Java 17 + Spring Boot 3, Gradle; testler JUnit 5" aria-label="Hedef yığın" />
            )}
          </fieldset>
        )}

        <fieldset className="alan-grubu">
          <legend className="alan-ad">Mod</legend>
          <div className="secenekler secenekler--izgara">
            {modlar.map((m) => {
              const uyari = motorUyarisi(m);
              const aciklama = m === "yerel" && yerelMotor?.tur === "openai"
                ? `Bütün ajanlar kurum LLM'inde (${durum?.yerel_motor}, ${yerelMotor.model}); hiçbir çağrı Claude'a gitmez.`
                : MOD_ACIKLAMA[m];
              return (
                <Secenek key={m} grup="mod" tip="radio" secili={mod === m} onDegis={() => setMod(m)} etiket={MOD_ADI[m]} aciklama={aciklama}>
                  {uyari && <span className="secenek-uyari"><Simge ad="uyari" boyut={14} /> {uyari}</span>}
                </Secenek>
              );
            })}
          </div>
        </fieldset>

        {hata && <p className="hata-satiri" role="alert"><Simge ad="uyari" /> {hata}</p>}
        <div className="yeni-alt">
          <button type="submit" className="dugme dugme--birincil" disabled={!hazir || gonderiliyor}>
            {gonderiliyor ? (kaynakGerekli ? "Kaynaklar alınıyor..." : "Başlatılıyor...") : "Fikri başlat"}
          </button>
        </div>
      </form>
    </div>
  );
}
