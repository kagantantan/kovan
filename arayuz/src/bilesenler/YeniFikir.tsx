// Yeni fikir: önce nereden başlandığı (sıfırdan, mevcut proje üzerinde iş, mevcut sistemi yeniden yaz), sonra metin,
// gerekiyorsa akış, proje ya da mevcut sistem yolları, hedef yığın ve mod. Mevcut projede akış seçilmez: türü ve boyutu
// keşif önerir. Örnekler Flora AI'dan, Kovan'la gelen kurgusal kart reeskont gün sonundan ve küçük taksit projesinden.
import { useEffect, useState } from "react";
import { api, type AkisOzeti, type DurumYaniti, type Katilim, type Mod } from "../api";
import { KATILIM_ACIKLAMA, KATILIM_ADI, MOD_ACIKLAMA, MOD_ADI, para } from "../bicim";
import { Goz } from "./BuyukBirader";
import { git } from "../kullan";
import { Petek, akisHucreleri } from "./Petek";
import { Secenek } from "./Secenek";
import { Simge } from "./Simge";

interface Ornek { ad: string; profil: string; metin: string; ornekKaynak?: boolean; ornekProje?: boolean; hedef?: string }

type Baslangic = "sifirdan" | "proje" | "yeniden";
const BASLANGICLAR: { id: Baslangic; kaynak: AkisOzeti["kaynak"]; ad: string; aciklama: string }[] = [
  { id: "sifirdan", kaynak: "yok", ad: "Sıfırdan", aciklama: "Yeni bir fikir. Ekip kapsamdan teslime kadar götürür." },
  { id: "proje", kaynak: "proje", ad: "Mevcut proje üzerinde iş",
    aciklama: "Var olan projede hata düzeltme, yeni özellik ya da entegrasyon. Klasörünü ver, isteğini yaz; türü ve boyutu Kovan önerir, sen onaylarsın. Sonuç yama dosyasıdır." },
  { id: "yeniden", kaynak: "zorunlu", ad: "Mevcut sistemi yeniden yaz",
    aciklama: "Eski bir sistemi (PL/SQL, COBOL, Java...) koda atıflarla anlayıp temiz bir mimariyle, eskisiyle eşdeğer biçimde yeniden yazar." },
];

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
  {
    ad: "Taksit planında kalan kuruş",
    profil: "proje",
    ornekProje: true,
    metin: "Taksit planında tutar taksit sayısına tam bölünmeyince kalan kuruş kayboluyor: 100,00 TL 3 taksitte 33,33 + 33,33 + 33,33 = 99,99 TL ediyor. Taksitlerin toplamı tutara eşit olmalı; kalan kuruş son taksite eklensin. Tam bölünen tutarlarda sonuç değişmesin.",
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
  const [baslangic, setBaslangic] = useState<Baslangic>("sifirdan");
  const [katilim, setKatilim] = useState<Katilim | null>(null);   // null: kurulumun varsayılanı
  const [projeYolu, setProjeYolu] = useState("");
  const [hedef, setHedef] = useState("");
  const [ozelHedef, setOzelHedef] = useState("");
  const [gonderiliyor, setGonderiliyor] = useState(false);
  const [seciliyor, setSeciliyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);

  // Başlangıcın akışları: sıfırdan birden çok (mini, standart, tam yığın); diğerlerinde çoğunlukla tek akış, seçim gösterilmez
  const baslangiclar = BASLANGICLAR.filter((b) => akislar.some((a) => a.kaynak === b.kaynak));
  const secenekAkislar = akislar.filter((a) => a.kaynak === BASLANGICLAR.find((b) => b.id === baslangic)!.kaynak);
  useEffect(() => {
    if (baslangiclar.length && !baslangiclar.some((b) => b.id === baslangic)) setBaslangic(baslangiclar[0].id);
    else if (secenekAkislar.length && !secenekAkislar.some((a) => a.id === profil)) setProfil(secenekAkislar[0].id);
  }, [akislar, baslangic, profil]);
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
        kaynaklar: kaynakGerekli || projeIsi ? kaynaklar.split("\n").map((y) => y.trim()).filter(Boolean) : [],
        hedef_yigin: projeIsi ? "" : hedef === OZEL ? ozelHedef.trim() : hedef,
        ...(projeIsi ? { proje: projeYolu.trim() } : {}),
        katilim: katilim ?? durum?.katilim ?? "planlama",
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
  const projeIsi = secilenAkis?.kaynak === "proje";
  const hazirYigin = durum?.hedef_yiginlar.find((h) => h.id === hedef);
  const hazir = Boolean(metin.trim() && profil && (!kaynakGerekli || kaynaklar.trim()) && (!projeIsi || projeYolu.trim()) && (projeIsi || hedef !== OZEL || ozelHedef.trim()));
  const baslangicDegis = (b: Baslangic) => {
    if (b === baslangic) return;
    setBaslangic(b);
    setKaynaklar("");   // ekler ile mevcut sistem kaynakları aynı alanı kullanır; başlangıç değişince karışmasın
    const ilk = akislar.find((a) => a.kaynak === BASLANGICLAR.find((x) => x.id === b)!.kaynak);
    if (ilk) setProfil(ilk.id);
  };
  const doldur = (o: Ornek) => {
    const akis = akislar.find((a) => a.id === o.profil);
    setMetin(o.metin);
    setBaslik(o.ad);
    if (akis) { setBaslangic(BASLANGICLAR.find((b) => b.kaynak === akis.kaynak)!.id); setProfil(akis.id); }
    setKaynaklar(o.ornekKaynak && durum?.ornek_kaynak ? durum.ornek_kaynak : "");
    setProjeYolu(o.ornekProje && durum?.ornek_proje ? durum.ornek_proje : "");
    setHedef(o.hedef ?? "");
  };
  const yolSec = async (tur: "klasor" | "dosya", al: (yollar: string[]) => void) => {
    setSeciliyor(true); setHata(null);
    try {
      const { yollar } = await api.yolSec(tur);
      if (yollar.length) al(yollar);
    } catch (e) { setHata((e as Error).message); }
    setSeciliyor(false);
  };
  const kaynakEkle = (yollar: string[]) => setKaynaklar((k) => [...new Set([...k.split("\n").map((y) => y.trim()).filter(Boolean), ...yollar])].join("\n"));
  const yolDugmeleri = (turler: ("klasor" | "dosya")[], al: (yollar: string[]) => void) => (
    <div className="yol-sec">
      {turler.map((tur) => (
        <button key={tur} type="button" className="dugme dugme--ikincil dugme--kucuk" disabled={seciliyor} onClick={() => void yolSec(tur, al)}>
          <Simge ad={tur === "klasor" ? "klasor" : "dosya"} boyut={14} /> {tur === "klasor" ? "Klasör seç" : "Dosya seç"}
        </button>
      ))}
      {seciliyor && <span className="alan-ipucu">Finder penceresi açıldı; seçimini bekliyorum...</span>}
    </div>
  );
  const gizlilik = (mod === "hibrit" || mod === "claude") && (
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
  );

  return (
    <div className="yeni">
      <header className="yeni-ust">
        <h1 className="sayfa-baslik">Yeni fikir</h1>
        <p className="sayfa-giris">Nereden başladığını seç, ne istediğini yaz. Ekip aşama aşama ilerler; karar gereken yerde sana sorulur.</p>
        <div className="ornekler">
          <span className="ornekler-ad">Örnekle doldur:</span>
          {ORNEKLER.filter((o) => akislar.some((a) => a.id === o.profil) && (!o.ornekKaynak || durum?.ornek_kaynak) && (!o.ornekProje || durum?.ornek_proje)).map((o) => (
            <button key={o.ad} type="button" className="dugme dugme--ikincil dugme--kucuk" onClick={() => doldur(o)}>
              {o.ad}
            </button>
          ))}
        </div>
      </header>

      <form className="yeni-form" onSubmit={(e) => { e.preventDefault(); if (hazir) void baslat(); }}>
        {baslangiclar.length > 1 && (
          <fieldset className="alan-grubu">
            <legend className="alan-ad">Nereden başlıyoruz?</legend>
            <div className="secenekler secenekler--izgara">
              {baslangiclar.map((b) => (
                <Secenek key={b.id} grup="baslangic" tip="radio" secili={baslangic === b.id} onDegis={() => baslangicDegis(b.id)} etiket={b.ad} aciklama={b.aciklama} />
              ))}
            </div>
          </fieldset>
        )}

        <label className="alan">
          <span className="alan-ad">{projeIsi ? "İstek" : "Fikrin"}</span>
          <textarea rows={6} value={metin} onChange={(e) => setMetin(e.target.value)} required
            placeholder={projeIsi ? "Ne yapılsın? Hatada: ne bekleniyordu, ne oldu, nasıl yeniden üretilir. Entegrasyonda: hangi sistemle, hangi işlem için."
              : "Ne yapılsın, kimin için, neyi başarınca bitmiş sayılır?"} />
        </label>
        <label className="alan">
          <span className="alan-ad">Başlık<span className="alan-ipucu"> boş bırakırsan ilk satırdan alınır</span></span>
          <input type="text" value={baslik} onChange={(e) => setBaslik(e.target.value)} maxLength={90} />
        </label>

        {projeIsi && (
          <fieldset className="alan-grubu">
            <legend className="alan-ad">Proje</legend>
            <label className="alan">
              <span className="alan-ad">Proje klasörü<span className="alan-ipucu"> projenin bu makinedeki kökü (pom.xml, build.gradle ya da package.json'ın olduğu yer)</span></span>
              <input type="text" className="girdi--kod" value={projeYolu} onChange={(e) => setProjeYolu(e.target.value)} required spellCheck={false}
                placeholder="/Users/sen/projeler/kart-ekstre" />
            </label>
            {yolDugmeleri(["klasor"], (yollar) => setProjeYolu(yollar[0]))}
            <label className="alan">
              <span className="alan-ad">Ekler<span className="alan-ipucu"> isteğe bağlı: entegrasyon sözleşmesi, hata detayı ve log, test senaryoları, analiz notu; her satıra bir yol</span></span>
              <textarea rows={2} className="girdi--kod" value={kaynaklar} onChange={(e) => setKaynaklar(e.target.value)} spellCheck={false}
                placeholder={"/Users/sen/Belgeler/odeme-servisi-openapi.yaml\n/Users/sen/Belgeler/hata-kaydi.txt"} />
            </label>
            {yolDugmeleri(["klasor", "dosya"], kaynakEkle)}
            <p className="alan-not">
              Projenin kopyası üzerinde çalışılır; verdiğin klasöre ve sürüm kontrolüne dokunulmaz, sonuç yama dosyası olarak çıkar.
              .git, node_modules, target ve sır taşıyabilecek dosyalar (.env, anahtar, sertifika) kopyalanmaz. Eklere parola ya da anahtar koyma;
              bağlantı bilgisi gerekiyorsa yalnızca ortam değişkeninin adını yaz. Türü (hata, özellik, entegrasyon), boyutu ve dokunulacak
              alanı keşif önerir; öneri kartını onaylamadan kod yazılmaz.
            </p>
            {gizlilik}
          </fieldset>
        )}

        <fieldset className="alan-grubu">
          <legend className="alan-ad">{secenekAkislar.length > 1 ? "Akış" : "Aşamalar"}</legend>
          {secenekAkislar.length > 1 && (
            <div className="secenekler secenekler--izgara">
              {secenekAkislar.map((a) => (
                <Secenek key={a.id} grup="akis" tip="radio" secili={profil === a.id} onDegis={() => setProfil(a.id)}
                  etiket={a.ad} aciklama={`${a.aciklama} Fikir bütçesi ${para(a.fikir_butcesi_usd)}.`} />
              ))}
            </div>
          )}
          {secilenAkis && (
            <div className="yeni-petek">
              <Petek etiket={`${secilenAkis.ad} akışının aşamaları`} hucreler={akisHucreleri(secilenAkis)} />
            </div>
          )}
          {projeIsi && <p className="alan-not">Hepsi koşmaz: küçük işte keşif, kıran test ve düzeltme; orta ve büyük işte fark analizi, teslim planı ve kalemler. Bütçe {para(secilenAkis!.fikir_butcesi_usd)}.</p>}
        </fieldset>

        {kaynakGerekli && (
          <fieldset className="alan-grubu">
            <legend className="alan-ad">Mevcut sistem</legend>
            <label className="alan">
              <span className="alan-ad">Kaynaklar<span className="alan-ipucu"> bu makinedeki klasör, .zip ya da dosya yolları; her satıra bir yol</span></span>
              <textarea rows={3} className="girdi--kod" value={kaynaklar} onChange={(e) => setKaynaklar(e.target.value)} required spellCheck={false}
                placeholder={"/Users/sen/eski-sistem/gunsonu\n/Users/sen/Belgeler/reeskont-analiz.docx"} />
            </label>
            {yolDugmeleri(["klasor", "dosya"], kaynakEkle)}
            <p className="alan-not">
              Kod ve analiz dokümanı birlikte. Kopyası alınır, aslına dokunulmaz; kopya kilitlenir, ajanlar yalnızca okur.
              .git, node_modules, target ve ikili dosyalar alınmaz. Word belgeleri HTML'e, Windows-1254 ve UTF-16 dosyalar UTF-8'e çevrilir.
            </p>
            {gizlilik}
          </fieldset>
        )}

        {durum && durum.hedef_yiginlar.length > 0 && !projeIsi && (
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
          <legend className="alan-ad">Onay kapıları<span className="alan-ipucu"> aşamalar bittikçe kararları sana getirsin mi; fikir sürerken değiştirebilirsin</span></legend>
          <div className="secenekler secenekler--izgara">
            {(["planlama", "her_asama", "sonda"] as Katilim[]).map((k) => (
              <Secenek key={k} grup="katilim" tip="radio" secili={(katilim ?? durum?.katilim ?? "planlama") === k} onDegis={() => setKatilim(k)}
                etiket={KATILIM_ADI[k]} aciklama={KATILIM_ACIKLAMA[k]} />
            ))}
          </div>
          {durum?.buyuk_birader && secilenAkis?.buyuk_birader && (
            <p className="alan-not birader-not"><Goz boyut={44} /> <span><b>Büyük Birader izliyor.</b> Her aşamanın sonunda işin tamamına bakar; kapsamdan sapmayı,
              kararlarla çelişkiyi ve uydurma iddiayı yakalarsa aşamayı veto eder. Değerlendirmesi kapıda önüne gelir. Her aşamaya bir çağrı ekler.</span></p>
          )}
        </fieldset>

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
            {gonderiliyor ? (projeIsi ? "Proje alınıyor..." : kaynakGerekli ? "Kaynaklar alınıyor..." : "Başlatılıyor...") : projeIsi ? "İşi başlat" : "Fikri başlat"}
          </button>
        </div>
      </form>
    </div>
  );
}
