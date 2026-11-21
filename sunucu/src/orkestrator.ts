// Orkestratör: her fikri akışındaki aşamalardan geçiren durum makinesi.
//
// Bir aşama = Üret -> Doğrula döngüsü:
//   1. Üret     : aşamanın ajanı çıktısını yazar (belge ya da kod/ klasöründe dosyalar)
//   2. Denetle  : yazma alanı dışındaki ve kilitli dosyalardaki değişiklikler geri alınır, ihlal kaydedilir
//   3. Doğrula  : önce deterministik komutlar (test), sonra onay kurulu (inceleyen ajanlar, paralel)
//   4. Bulgu varsa tur artar ve bulgular üreten ajana gider; tur sınırında karar insana kalır
//
// Ortak karar ve insan döngüde: ajanlar kararı veremediklerinde seçenekli soru sorar (kovan-soru). Soru önce
// ekibe gider (PO, Mimar, Analist oylar); oybirliği çıkarsa karar ekibindir, çıkmazsa soru oylarla birlikte
// insana gelir. Para, hukuki risk ve geri dönüşsüz kararlar doğrudan insana gelir. Sistem de tur sınırı, kalıcı
// hata, bütçe ve teslimde açıklamalı seçeneklerle sorar. Kararlar deftere yazılır, sonraki ajanlar görür.
//
// Derin planlama: teslim planındaki iş kalemleri (P1, P2...) kalemler aşamasında sırayla açılır; her kalem
// kendi kabul testiyle başlar, testler kilitlenir, kod ancak sonra yazılır. Teslimden sonra Ürün Sahibi
// gelişim önerileri getirir; her biri sana "olmalı mı?" diye sorulur, kabul ettiklerinle yeni sürüm başlar.
//
// Mevcut proje üzerinde iş: proje kod/proje/ altına birebir kopyalanır. Keşif aşaması iş önerisini çıkarır (tür, boyut,
// yazma alanı); öneri kartını sen onaylarsın (.kovan/is.json). Aşamalar boyuta ve tarafa göre süzülür, projenin
// testleri işe başlamadan koşar (baz çizgisi), yeni testler koddan önce kırmızı olmalıdır. Sonuç yama dosyasıdır (cikti/).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bosAsama, tumAdimlar, type Akis, type Asama, type Dogrulayici } from "./akislar.js";
import { HEDEF_YIGINLAR, MODLAR, type Ayarlar, type Mod } from "./ayarlar.js";
import type { Depo } from "./depo.js";
import type {
  Adim, AjanSorusu, AsamaGorunumu, Bekleme, BeklemeKaynagi, BeklemeSebebi, Cevap, DosyaIcerigi, Fikir, FikirDetayi, FikirOzeti,
  Adr, BiraderBulgusu, BiraderDegerlendirmesi, BiraderHukmu, GelisimKarari, GelisimKaydi, GelisimOnerisi, IsBoyutu, IsKaydi, IsOnerisi, IsTuru,
  Karar, Katilim, OnayKaydi, OnayRozeti, Oy, PlanKalemi, PlanKalemiGorunumu, ProjeBilgisi, Secenek, SohbetMesaji, YamaOzeti,
} from "./tipler.js";
import { KATILIMLAR } from "./tipler.js";
export type { Cevap, Karar };
import type { AjanKarti } from "./kartlar.js";
import { BIRADER_SEMASI, KARAR_SEMASI, OY_SEMASI, jsonCikar, soruCikar, sonuc, sorulariDogrula, sureciOldur, type AjanCagrisi, type AjanSonucu, type HamSoru, type Motor } from "./motor.js";
import { IS_BOYUTLARI, IS_TURLERI, adrCikar, adrDosyaAdi, adrMarkdown, belgeButunlugu, gelisimCikar, isCikar, isDenetle, isUygula, kalemleriGenislet,
  kosulTutar, ozetCikar, planCikar } from "./plan.js";
import { KAYNAK_KLASORU, atiflariDenetle, envanterBelgesi, kaynakIceAl } from "./kaynak.js";
import { PROJE_KLASORU, YAMA_DOSYASI, projeEnvanteri, projeIceAl, yamaOkuBeni, yamaYaz } from "./proje.js";
import { KovanHatasi, altinda, atomikYaz, bekle, jsonOku, kisalt, kuyruk, simdi } from "./ortak.js";

/** Onaylanan ADR'lerin kod içindeki klasörü (kilitli). */
const ADR_KLASORU = "adr";

const YOKSAY_KLASOR = new Set(["__pycache__", ".pytest_cache", ".git", "node_modules", ".venv", "venv", "test-results",
  "playwright-report", "coverage", "dist", "build", ".next", ".vite", ".cache", ".turbo", ".parcel-cache",
  "target", ".gradle", "out", ".idea"]);   // Maven/Gradle derleme çıktıları ve IDE klasörleri sınır denetimine girmez
const YOKSAY_DOSYA = new Set([".DS_Store", ".coverage"]);
const YOKSAY_UZANTI = new Set([".pyc", ".pyo", ".log", ".tsbuildinfo"]);

/** Okuma araçları olan her çağrıya: yollar çalışma dizinine göreli. Ajanlar mutlak üst klasöre bakınca CLI reddediyor,
 *  ajan da "okuma izni yok" deyip kodu hiç okumadan karar veriyordu. */
const DOSYA_ERISIMI = "Dosya yolları çalışma dizinine göreli: ör. Glob'u `pattern: \"kaynak/**/*.java\"` ile ve `path` vermeden çağır, " +
  "Read ile `kaynak/...` aç. Üst klasöre (`..`) ya da mutlak bir yola bakma; o çağrılar izinsiz sayılır ve reddedilir. " +
  "Bir çağrın reddedilirse \"okuma izni yok\" deyip bırakma: aynı şeyi çalışma dizinine göreli bir yolla yeniden dene.";

const ORTAK_KURALLAR = `# Ortak kurallar (her ajan için)
- Yalnızca sana verilen girdilere ve rolüne dayan. Girdilerde olmayan bilgiyi uydurma.
- Bir şeyi varsaymak zorundaysan "VARSAYIM:" diye açıkça işaretle.
- Emin değilsen "BİLMİYORUM" de. Emin görünen yanlış bir cevap, eksik bir cevaptan daha kötüdür.
- Rolünün dışındaki işi yapma; başka rolün kararını değiştirme.
- "Alınan kararlar" bölümündeki kararlar (ekibin oybirliğiyle ya da projenin sahibinin verdiği) bağlayıcıdır; onlarla çelişme.
- Türkçe yaz; yerleşmiş teknik terimleri (test, interface, rounding, edge case gibi) İngilizce bırak.`;

/** Üretici ve onaycı için soru kuralları. ekip: soru önce ortak karara gider; isKurali: iş kuralı soruları ekibe uğramaz. */
/** Sorular sonunda projenin sahibine gider; o belgeleri ve kodu okumadan anlayabilmeli. */
const ANLASILIR_SORU = `- Soruyu, belgeleri ve kodu hiç görmemiş bir iş insanı okuyacakmış gibi yaz: kendi içinde tam, düz Türkçe.
- Kimlikleri (E1, H3, Ş12, ŞÜPHE-6, FARK-2, K4, P2) tek başına kullanma; anarsan ne olduğunu aynı cümlede söyle. Başlıkta hiç kullanma ("Ekstre tutarının işareti", "E18" değil).
- Soruda dosya yolu, satır numarası, sınıf ya da metot adı olmasın; gerekiyorsa seçeneğin açıklamasına kısaca koy.
- Somut ol, bir örnekle anlat (ör. "10.000 TL borçlu bir kartta 31 günlük ayın faizi 365'e mi, 360'a mı bölünsün?"). Seçenek açıklamasında, seçilirse sonuçta neyin değişeceğini yaz.`;

function soruKurali(ekip: boolean, inceleme: boolean, isKurali = false): string {
  const nereye = ekip
    ? "Soruların önce ekibe gider: Ürün Sahibi, Mimar ve Analist oy verir (senin önerin de oydur). Oybirliğiyle karar çıkarsa projenin sahibine sorulmaz; anlaşamazsanız soru oylarla birlikte ona gider."
    : "Soruların doğrudan projenin sahibine gider.";
  const insanKurali = ekip
    ? '\n- "insan": true yalnızca kararı projenin sahibi verebiliyorsa: para ve bütçe, hukuki bir riski kabul etmek, geri dönüşü olmayan bir işlem, marka ya da iş stratejisi. Bu sorular ekibe uğramadan ona gider.'
    : "";
  const konuKurali = ekip && isKurali
    ? '\n- Her soruya "konu" yaz: "is_kurali" ya da "teknik". İş kuralı: doküman ile kodun çeliştiği yerler, hesaplama, yuvarlama ve tarih kuralları, kapsam, hata ve istisna davranışı, mevzuat yorumu. Bu aşamada iş kuralı soruları ekibe uğramadan projenin sahibine gider; teknik sorular (teknoloji, yapı, araç seçimi) önce ekipte oylanır. Emin değilsen "is_kurali" yaz.'
    : "";
  const ortak = `- En fazla 3 soru; her soruda 2-4 seçenek. Önerdiğini ilk sıraya koy ve etiketinin sonuna "(Önerilen)" yaz.
- "Diğer" seçeneği ekleme; projenin sahibi her zaman kendi cevabını yazabilir. Birden çok seçenek seçilebilecekse "coklu": true yap.${insanKurali}${konuKurali}
${ANLASILIR_SORU}`;
  if (inceleme) {
    return `# Soru (kovan-soru)
Karar vermen bir ürün ya da kapsam kararına bağlıysa ve yanlış bir varsayım işi boşa çıkaracaksa "karar": "SORU" ver, soruları "sorular" alanına yaz. ${nereye}
- Önce "Alınan kararlar" bölümüne bak; cevap oradaysa sorma. Somut bir hata görüyorsan soru değil DUZELT ver.
- Her soru: baslik (3-4 kelime), soru, coklu, insan, secenekler [{etiket, aciklama}].
${ortak}`;
  }
  return `# Soru (önce ekip, gerekirse projenin sahibi)
Kararı sen veremiyorsan ve yanlış bir varsayım işi ciddi biçimde boşa çıkaracaksa soru sorabilirsin. ${nereye}
- Önce girdilere ve "Alınan kararlar" bölümüne bak; cevap oradaysa sorma. Küçük konularda "VARSAYIM:" yazıp devam et.
- Soracaksan çıktın YALNIZCA şu blok olsun (başka metin ya da dosya yok):
\`\`\`kovan-soru
{"sorular": [{"baslik": "3-4 kelime", "soru": "Tek başına anlaşılır, net bir soru?", "coklu": false, "insan": false,
  "secenekler": [{"etiket": "Önerdiğin seçenek (Önerilen)", "aciklama": "Seçilirse ne olur"}, {"etiket": "Başka seçenek", "aciklama": "Seçilirse ne olur"}]}]}
\`\`\`
${ortak}`;
}

const INCELEME_KURALLARI = `# İnceleme kuralları
- Somut ve düzeltilebilir bir eksik ya da hata varsa DUZELT ver; yoksa ONAY ver.
- Stil ve zevk farkı için DUZELT verme. Mükemmel değil ama doğru ve yeterliyse ONAY.
- Yalnızca kendi rolünün alanına bak; başka onaycının alanındaki konular için DUZELT verme.
- Her bulgu tek cümle: neyin, neden yanlış olduğu ve hangi kritere/kurala aykırı olduğu. En fazla 5 bulgu.
- Emin olmadığın bir konuda bulgu yazma; doğrulayamadığın bir şeyi hata sayma.
- Senin rolün incelemek: düzeltmeyi kendin yazma, dosya değiştirme.`;

const KAPSAM_KURALI = `# Kapsam
Bu fikirde senin alanına giren hiçbir konu yoksa (ör. kişisel veri, ödeme ya da düzenlemeye tabi bir iş yok) ONAY ver,
gerekçede bunu bir cümleyle söyle ve "kapsam_disi": true ekle. Sonraki aşamalarda seni bu fikir için çağırmayız.
Emin değilsen kapsam_disi verme; ilgili bir konu varsa normal incele.`;

/** once_soru aşamalarında ilk adım: belge yazılmadan önce açık sorular ve varsayımlar projenin sahibine gider. */
const ONCE_SORU = `# Önce soru (kontrol noktası)
Bu aşamada belgeni yazmadan önce projenin sahibiyle bir soru turu yapılır. Girdileri oku, sonra çıktın YALNIZCA şu blok olsun:
\`\`\`kovan-soru
{"sorular": [{"baslik": "3-4 kelime", "soru": "Tek başına anlaşılır, net bir soru?", "coklu": false, "insan": true, "konu": "is_kurali",
  "secenekler": [{"etiket": "Önerdiğin seçenek (Önerilen)", "aciklama": "Seçilirse ne olur; hangi varsayımla"}, {"etiket": "Başka seçenek", "aciklama": "Seçilirse ne olur"}]}]}
\`\`\`
- 1-3 soru: işin sonucunu en çok değiştirecek açık noktalar. Önce doküman ile kodun çeliştiği yerler, sonra belirsiz iş kuralları.
- Yapacağın önemli varsayımları da birer soru olarak getir: önerdiğin seçenek varsayımın, açıklamada dayanağı (ör. kod atfı).
- Cevabı girdilerde ya da "Alınan kararlar" bölümünde olan bir şeyi sorma.
- Her soruda 2-4 seçenek; önerdiğini ilk sıraya koy, etiketinin sonuna "(Önerilen)" yaz. "Diğer" ekleme.
- Bu sorular ekibe uğramadan projenin sahibine gider. Cevaplar gelince aynı aşama yeniden çalışır ve belgeni yazarsın.
${ANLASILIR_SORU}`;

/** Büyük Birader'in kart kimliği (ajanlar/buyuk-birader.md). */
export const BIRADER = "buyuk-birader";
const HUKUM_ADI: Record<BiraderHukmu, string> = { UYGUN: "UYGUN", DIKKAT: "DİKKAT", VETO: "VETO" };
const KAPI_ONAY = "Onaylıyorum";
const KAPI_DEGISTIR = "Değiştir";
/** İstemlere giren en uzun belge (karakter); gerisi için ajan dosyayı araçla açar. */
const EN_UZUN_BELGE = 24_000;

const KARAR_OZETI = `# Karar özeti (kovan-ozet)
Çıktının EN SONUNA, bu aşamada karara bağlananları şu blokla ekle (kod aşamasında son mesajının sonuna):
\`\`\`kovan-ozet
kararlar:
  - baslik: 3-5 kelime
    karar: Ne karara bağlandı; bir iki cümle, tek başına anlaşılır.
    neden: Dayanağı (hangi girdi, hangi karar, hangi kısıt).
    alternatif: Değerlendirilip seçilmeyen yol; yoksa boş bırak.
    tur: karar
\`\`\`
- 3-8 madde: işin sonucunu en çok değiştiren kararlar. tur: karar, varsayim ya da kapsam.
- Yaptığın her önemli varsayım ("VARSAYIM:") ayrı bir maddedir (tur: varsayim). Kapsama aldığın ya da dışarıda bıraktığın ana konular ayrı maddelerdir (tur: kapsam).
- Projenin sahibi bu maddeleri tek tek onaylayacak ya da değiştirecek; belgeyi okumadan anlayabilmeli: düz Türkçe, somut, mümkünse bir örnekle.
- Kimlikleri (K3, P2, ADR-1, E5) tek başına kullanma; anarsan ne olduğunu aynı cümlede söyle. Dosya yolu, sınıf ya da metot adı yazma.
- Mimari karar kayıtlarını (kovan-adr) burada tekrar etme; onlar ayrıca sorulur.`;

const SOHBET_KURALLARI = `# Konuşma (projenin sahibi soruyor)
Projenin sahibi sana doğrudan bir soru soruyor. Bu bir üretim turu değil:
- Soruyu cevapla: kısa, somut, düz Türkçe. Bilmiyorsan "BİLMİYORUM" de; tahmin ediyorsan "TAHMİN:" diye işaretle.
- Belgeyi ya da kodu yeniden yazma, hiçbir dosyayı değiştirme. Bir şeyin değişmesi gerektiğini düşünüyorsan neyin, neden ve neye mal olacağını söyle.
- Karar verme. Seçenek varsa artısıyla eksisiyle sun, önerini söyle; karar projenin sahibinin.
- "Alınan kararlar" bağlayıcıdır; onlarla çelişen bir şey öneriyorsan bunu açıkça belirt.
- Soru bloğu (kovan-soru) ya da başka yapılandırılmış blok yazma; yalnızca cevabını yaz.`;

const SORU_HAKKI_DOLDU = "# Soru\nBu aşamada soru hakkın doldu. Belirsizliklerde \"VARSAYIM:\" yazıp devam et.";

const ORTAK_KARAR_KURALLARI = `# Ortak karar (oy)
Ekip arkadaşların kararı veremedikleri bir konuda soru sordu. Önce ekip oylar: hepiniz aynı seçeneği seçerseniz karar
ekibindir ve projenin sahibine sorulmaz; anlaşamazsanız soru oylarınızla birlikte ona gider.
- Kendi rolünün gözüyle, bağımsız oy ver. Seçeneği numarasıyla yaz ("secim": [1]); çoklu soruda birden çok numara olabilir.
- Girdilerde ve "Alınan kararlar" bölümünde dayanağı olan seçeneği seç. Soranın önerisine körü körüne katılma.
- Kararı yalnızca projenin sahibi verebilecekse "insana_birak": true yap: para ve bütçe, hukuki bir riski kabul etmek,
  geri dönüşü olmayan bir işlem, marka ya da iş stratejisi tercihi. Bu durumda "secim" boş kalabilir.
- Her oy için tek cümle gerekçe yaz.`;

const GELISIM_SECENEKLERI: { anahtar: GelisimKarari; etiket: string; aciklama: string }[] = [
  { anahtar: "al", etiket: "Evet, sonraki sürüme al", aciklama: "Kabul ettiklerinle yeni sürümü başlatabilirsin." },
  { anahtar: "degistir", etiket: "Değiştirerek al", aciklama: "Notuna göre uyarlanır; ne değişsin, notuna yaz." },
  { anahtar: "simdilik_hayir", etiket: "Şimdilik hayır", aciklama: "Defterde kalır; PO yeni bir gerekçe olmadan yeniden önermez." },
  { anahtar: "asla", etiket: "Hayır, bir daha önerme", aciklama: "PO bu fikri bir daha getirmez." },
];

const GELISIM_ETIKET: Record<GelisimKarari, string> = {
  al: "Sonraki sürüme alındı", degistir: "Değiştirerek alındı", simdilik_hayir: "Şimdilik hayır", asla: "Bir daha önerilmeyecek",
};

const SECENEK_TANIM: Record<string, Omit<Secenek, "anahtar" | "onerilen">> = {
  kabul: { etiket: "Kabul ediyorum", aciklama: "Teslimi onayla; fikir tamamlanır." },
  geri_gonder: { etiket: "Notumla geri gönder", aciklama: "Seçtiğin aşama notunla yeniden çalışır; sonraki aşamalar yeniden yazılmaz, yeniden doğrulanır." },
  bir_tur_daha: { etiket: "Bir tur daha", aciklama: "Bulgularla aynı ajana bir tur daha ver." },
  claude_devral: { etiket: "Bu aşamayı Claude'a devret", aciklama: "Yerel model tıkandı; bu aşama Claude ile devam etsin." },
  kabul_testine_don: {
    etiket: "Kabul testine geri gönder",
    aciklama: "Kilitli test hatalıysa: kalemin kabul testi notunla yeniden açılır. Testi Test Otomasyon düzeltir, onay kurulu bakar, test yeniden kilitlenir. Yazılan kod korunur; iş kalemi yeniden doğrulanır.",
  },
  devam: { etiket: "Olduğu gibi kabul et", aciklama: "Bulgulara rağmen sonraki aşamaya geç." },
  tekrar_dene: { etiket: "Tekrar dene", aciklama: "Aynı adımı yeniden çalıştır (ör. giriş yaptıktan ya da Ollama'yı açtıktan sonra)." },
  atla: { etiket: "Bu aşamayı atla", aciklama: "Aşamayı çıktısı olmadan geç; sonraki aşamalar eksik girdiyle çalışabilir." },
  butce_artir: { etiket: "Bütçeyi artır ve devam et", aciklama: "Fikir bütçesini %50 (en az 1 $) artır." },
  birader_atla: { etiket: "Bu aşamada Büyük Birader olmadan devam et", aciklama: "Değerlendirme alınamadı; onay kurulunun kararıyla ilerle. Sonraki aşamalarda Büyük Birader yine bakar." },
  komut_degistir: { etiket: "Test komutunu değiştir", aciklama: "Notuna yeni komutu yaz (proje kökünde koşar; ör. yalnızca ilgili modülün testleri). Baz çizgisi yeni komutla yeniden koşar." },
  durdur: { etiket: "Durdur", aciklama: "İşi durdur; sonra kaldığı yerden devam ettirebilirsin.", tehlikeli: true },
};

const SECIM_ETIKET: Record<string, string> = {
  devam: "Olduğu gibi kabul edildi, devam", bir_tur_daha: "Bir tur daha verildi", tekrar_dene: "Tekrar denendi",
  atla: "Aşama atlandı", butce_artir: "Bütçe artırıldı", kabul: "Kabul edildi", geri_gonder: "Notla geri gönderildi",
  claude_devral: "Aşama Claude'a devredildi", durdur: "Durduruldu", kabul_testine_don: "Kabul testine geri gönderildi",
  komut_degistir: "Test komutu değiştirildi", birader_atla: "Bu aşamada Büyük Birader atlandı",
};

/** Öneri kartı: boyut seçeneklerinin açıklaması (hangi yoldan geçileceği). */
const BOYUT_ACIKLAMA: Record<IsBoyutu, string> = {
  kucuk: "Tek tarafta, birkaç dosyalık iş. Önce hatayı ya da isteği yakalayan test yazılır ve kilitlenir, sonra düzeltme.",
  orta: "Birkaç parçalı iş. Fark analizi, teslim planı ve kalemler; her kalem kendi kabul testiyle.",
  buyuk: "Yeni modül ya da mimari karar gerektiren iş. Ortaya ek olarak teknik plan, ADR ve (arayüz varsa) UX tasarım.",
};
const TUR_ACIKLAMA: Record<IsTuru, string> = {
  hata: "Var olan davranış yanlış; kök neden düzeltilir, mevcut davranışın gerisi korunur.",
  ozellik: "Yeni davranış eklenir ya da var olan bilerek değiştirilir.",
  entegrasyon: "Başka bir sistemle bağlantı: sözleşmeden sahte karşı taraf ve sözleşme testi, sonra adaptör.",
};
const TUR_REHBERI: Record<IsTuru, string> = {
  hata: "Bu bir hata düzeltmesi: kök nedeni düzelt, belirtiyi maskeleme. Değişiklik en küçük olsun; ilgisiz yeri yeniden yazma.",
  ozellik: "Bu yeni bir özellik: mevcut davranışı bozma; yeni davranış yalnızca istenen kapsamda olsun.",
  entegrasyon: "Bu bir entegrasyon: karşı sistemin sözleşmesi eklerde. Gerçek ağa çıkma; testlerde sözleşmeden üretilmiş sahte karşı taraf kullan. " +
    "Adres, kullanıcı adı, parola ve anahtar koda ya da teste yazılmaz; yalnızca yapılandırma ya da ortam değişkeni adıyla okunur.",
};
const ALAN_ONAYI = "Onayla";

function secenekler(anahtarlar: string[], onerilen?: string): Secenek[] {
  const sirali = onerilen && anahtarlar.includes(onerilen) ? [onerilen, ...anahtarlar.filter((a) => a !== onerilen)] : anahtarlar;
  return sirali.map((a, i) => ({ anahtar: a, ...SECENEK_TANIM[a], onerilen: i === 0 && !SECENEK_TANIM[a].tehlikeli }));
}

type Sonuc = "ok" | "bekle" | "dur";
/** "tekrar": ekip soruya karar verdi; aşamanın döngüsü kararla yeniden döner (insan cevaplamış gibi). */
type DonguSonucu = Sonuc | "tekrar";

interface PlanKaydi {
  kalemler: PlanKalemi[];
  surum: number;
  belge: string;      // planın okunduğu belge
}

/** Yazma alanı girdisini gösterir: klasörse sonuna "/" ekler (test-be.sh gibi dosyalara eklemez). */
function klasorGibi(y: string): string {
  return /\.[a-z0-9]+$/i.test(y) ? y : `${y}/`;
}

function ozetSatiri(metin: string): string {
  for (const satir of (metin ?? "").split("\n")) {
    const s = satir.trim().replace(/^[#>*\-| ]+/, "").trim();
    if (s && !s.startsWith("```")) return kisalt(s, 140);
  }
  return "";
}

function citAyikla(metin: string): string {
  const s = metin.trim();
  if (s.startsWith("```")) {
    const ilk = s.split("\n", 1)[0];
    const govde = s.slice(ilk.length + 1).trimEnd();
    if (["", "markdown", "md"].includes(ilk.replace(/`/g, "").trim().toLowerCase()) && govde.endsWith("```")) return govde.slice(0, -3).trimEnd();
  }
  return s;
}

function testOzeti(cikti: string, kod: number): string {
  const satirlar = (cikti ?? "").split("\n").map((s) => s.trim()).filter((s) => s && !/^[-=]+$/.test(s));
  const onemli = satirlar.filter((s) => /^(# |ℹ )?(Ran |OK|FAILED|tests |pass |fail )/.test(s) || / passed| failed/.test(s));
  const secilen = onemli.length ? onemli.slice(-3) : satirlar.slice(-2);
  return kisalt((kod === 0 ? "Yeşil" : `Kırmızı (çıkış kodu ${kod})`) + (secilen.length ? " · " + secilen.join(" · ") : ""), 200);
}

/** Ajan çağrısı olan adım tipleri (sayaçlar ve motor dağılımı için). */
const AJAN_ADIMI = new Set(["uret", "inceleme", "oy"]);

/** Oy çağrısı durdurulduysa döner. */
const DURDU = "__durdu__";

interface HamOy {
  soru: number;
  secim: number[];
  insana_birak: boolean;
  gerekce: string;
}

const sadeMetin = (x: string) => x.toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();
const temizEtiket = (e: string) => e.replace(/\s*\(Önerilen\)\s*$/i, "").trim();

/** Hepsi yerel modunda yerel motor bulunamazsa kullanılan yer tutucu: hiçbir şeyi buluta göndermez, her çağrıda hata verir. */
const YEREL_MOTOR_YOK: Motor = {
  ad: "yerel-motor-yok", tur: "ollama", yerel: true, hazir: false, surum: "-",
  hata: "Hepsi yerel modunda yerel motor tanımlı değil (kovan.yaml > motorlar). Hiçbir şey buluta gönderilmedi.",
  async saglik() { return false; },
  modelSec() { return "-"; },
  async calistir() { return sonuc({ hata: YEREL_MOTOR_YOK.hata!, kalici_hata: true }); },
  async durumOzeti() { return { hazir: false, surum: "-", hata: YEREL_MOTOR_YOK.hata, yol: null, tur: "ollama", yerel: true, model: null }; },
};

export class Orkestrator {
  private durdurIstekleri = new Set<string>();
  /** Revizyon turunda üretimden önceki belge ("fid/aşama"): belge bütünlüğü denetimi bununla karşılaştırır. */
  private oncekiBelgeler = new Map<string, string>();
  /** Kırmızı beklenen test denetiminin son çıktısı ("fid/aşama"): onay kurulu doğru sebeple mi kırmızı diye bakar. */
  private kirmiziCiktilar = new Map<string, string>();
  /** Cevabı beklenen konuşma çağrıları (fikir başına aynı anda tek soru). */
  private sohbetCalisan = new Set<string>();
  private surecler = new Map<string, Set<import("node:child_process").ChildProcess>>();
  private kuyrukListe: string[] = [];
  private calisanlar = new Set<string>();
  private tekrar = new Set<string>();

  constructor(
    private calisma: string,
    private cfg: Ayarlar,
    private depo: Depo,
    readonly kartlar: Map<string, AjanKarti>,
    readonly akislar: Map<string, Akis>,
    readonly motorlar: Map<string, Motor>,
  ) {
    for (const k of kartlar.values()) {
      if (!motorlar.has(k.motor) || k.motor === "deneme") {
        const tanimli = [...motorlar.keys()].filter((m) => m !== "deneme").join(", ") || "yok";
        throw new KovanHatasi(`ajanlar/${k.id}.md: motor '${k.motor}' tanımlı değil (tanımlı motorlar: ${tanimli}). ` +
          `Bütün ajanları bir motora yönlendirmek için ayar dosyasında: ajanlar: { "*": { motor: <ad> } }`);
      }
    }
    for (const id of cfg.ortak_karar.kurul) {
      if (!kartlar.has(id)) throw new KovanHatasi(`kovan.yaml: ortak_karar.kurul içindeki '${id}' için ajan kartı yok`);
    }
    if (cfg.buyuk_birader.acik && !kartlar.has(BIRADER)) throw new KovanHatasi(`ayarlar: buyuk_birader açık ama ajanlar/${BIRADER}.md yok. Kartı geri koy ya da buyuk_birader: false yap.`);
    this.kurtar();
  }

  // ================================ motor seçimi ================================
  /** "Hepsi yerel" modunun motoru: ayarlardaki yerel_motor, yoksa ilk yerel motor. */
  private yerelMotor(): Motor | null {
    if (this.cfg.yerel_motor) return this.motorlar.get(this.cfg.yerel_motor) ?? null;
    return [...this.motorlar.values()].find((m) => m.yerel && m.ad !== "deneme") ?? null;
  }

  yerelMotorAdi(): string | null {
    return this.yerelMotor()?.ad ?? null;
  }

  /** Bu kurulumda açık modlar: Claude kapalıysa Hepsi Claude yok. */
  acikModlar(): Mod[] {
    return this.cfg.modlar.filter((m) => m !== "claude" || this.motorlar.has("claude"));
  }

  private motorSec(f: Fikir, kart: AjanKarti, asama?: Asama, uretici = false): Motor {
    if (f.motor === "deneme") return this.motorlar.get("deneme")!;
    // Hepsi yerel: veri makineden çıkmaz. Yerel motor kaldırılmışsa buluta düşülmez, çağrı hata verir.
    if (f.motor === "yerel") return this.yerelMotor() ?? YEREL_MOTOR_YOK;
    if (f.motor === "hibrit") {
      if (uretici && asama && f.istisnalar?.[asama.id]) return this.motorlar.get(f.istisnalar[asama.id]) ?? this.motorlar.get("claude")!;
      return this.motorlar.get(kart.motor) ?? this.motorlar.get("claude")!;
    }
    return this.motorlar.get("claude")!;
  }

  private gerekenMotorlar(akis: Akis, mod: Mod): string[] {
    if (mod === "yerel") {
      const m = this.yerelMotor();
      if (!m) throw new KovanHatasi("'Hepsi yerel' için kovan.yaml'da bir yerel motor (motorlar: qwen-yerel) tanımlı olmalı.");
      return [m.ad];
    }
    if (mod !== "hibrit") return [mod];
    const adlar = new Set<string>();
    const gelistiriciler = akis.asamalar.flatMap((a) => Object.keys(a.gelistiriciler));
    for (const a of tumAdimlar(akis)) {
      const ajanlar = a.ajan === "{gelistirici}" ? gelistiriciler : [a.ajan];
      for (const r of [...ajanlar, ...a.dogrulama.map((v) => v.inceleyen)]) if (r && this.kartlar.has(r)) adlar.add(this.kartlar.get(r)!.motor);
    }
    if (this.ortakKararAcik(akis)) for (const id of this.cfg.ortak_karar.kurul) adlar.add(this.kartlar.get(id)!.motor);
    if (this.cfg.buyuk_birader.acik && akis.buyuk_birader) adlar.add(this.kartlar.get(BIRADER)!.motor);
    return adlar.size ? [...adlar] : ["claude"];
  }

  /** İnceleme ve oy: Claude'daysa ayarlanan ucuz model (ör. haiku); belgeyi ve kodu yazan üretim çağrıları ajanın kendi modelinde kalır. */
  private incelemeModeli(motor: Motor, kart: AjanKarti): string {
    return motor.ad === "claude" && this.cfg.claude_inceleme_modeli ? this.cfg.claude_inceleme_modeli : motor.modelSec(kart);
  }

  /** Kalem adımının, aynı kalemde kendisinden önce gelen ve testleri kilitleyen aşaması (ör. P2 Kabul testi). */
  private kabulTestiAsamasi(f: Fikir, asama: Asama): Asama | null {
    if (!asama.kalem) return null;
    const liste = this.asamalar(f);
    const i = liste.findIndex((a) => a.id === asama.id);
    for (let j = i - 1; j >= 0; j--) {
      const a = liste[j];
      if (a.kalem?.id !== asama.kalem.id) break;
      if (a.tur === "ajan" && a.kilitle.length) return a;
    }
    return null;
  }

  private devralinabilir(f: Fikir, asama: Asama): boolean {
    if (f.motor !== "hibrit" || !asama.ajan || !this.motorlar.has("claude")) return false;
    return this.motorSec(f, this.kartlar.get(asama.ajan)!, asama, true).yerel;
  }

  // ================================ dış arayüz ================================
  /** ek.kaynaklar: mevcut sistemin klasörleri/dosyaları (replatform). ek.hedef_yigin: hazır yığın kimliği ya da serbest metin. */
  async yeniFikir(baslik: string, metin: string, profil: string, mod: string, ek: { kaynaklar?: string[]; hedef_yigin?: string; proje?: string; katilim?: string } = {}): Promise<string> {
    return this.fikirOlustur(baslik, metin, profil, mod, null, ek);
  }

  /** Kabul edilen gelişim önerileriyle yeni sürüm: önceki kod, kararlar ve gelişim defteri taşınır. */
  async yeniSurum(fid: string, metin = ""): Promise<string> {
    const f = this.fikirAl(fid);
    if (f.durum !== "tamamlandi") throw new KovanHatasi("Yeni sürüm yalnızca tamamlanmış bir fikirden başlatılabilir.");
    if (f.sonraki_surum) throw new KovanHatasi(`Bu fikrin yeni sürümü zaten başlatıldı: ${f.sonraki_surum}`);
    if (f.proje) throw new KovanHatasi("Mevcut proje işinde yeni sürüm yok: yamayı projene uygula, sonraki istek için aynı projeyle yeni bir iş başlat.");
    const tohum = (metin ?? "").trim() || this.sonrakiSurumMetni(fid);
    if (!tohum) throw new KovanHatasi("Kabul edilmiş bir gelişim önerisi yok; yeni sürümde ne istediğini yaz.");
    const surum = (f.surum ?? 1) + 1;
    const baslik = `${f.baslik.replace(/\s+v\d+$/, "")} v${surum}`;
    const yeni = await this.fikirOlustur(baslik, tohum, f.profil, f.motor, { kaynak: fid, surum }, { katilim: f.katilim });
    this.depo.fikirGuncelle(fid, { sonraki_surum: yeni });
    return yeni;
  }

  private async fikirOlustur(baslik: string, metin: string, profil: string, mod: string, onceki: { kaynak: string; surum: number } | null,
    ek: { kaynaklar?: string[]; hedef_yigin?: string; proje?: string; katilim?: string } = {}): Promise<string> {
    metin = (metin ?? "").trim();
    const katilim = this.katilimCoz(ek.katilim);
    if (!metin) throw new KovanHatasi("Fikir metni boş olamaz.");
    const akis = this.akislar.get(profil);
    if (!akis) throw new KovanHatasi(`Bilinmeyen akış: ${profil}`);
    if (!MODLAR.includes(mod as Mod)) throw new KovanHatasi(`Bilinmeyen mod: ${mod} (hibrit, claude, yerel ya da deneme)`);
    if (!this.acikModlar().includes(mod as Mod)) throw new KovanHatasi(`'${mod}' modu bu kurulumda kapalı. Açık modlar: ${this.acikModlar().join(", ")}`);
    const kaynaklar = (ek.kaynaklar ?? []).map((y) => y.trim()).filter(Boolean);
    if (akis.kaynak === "zorunlu" && !kaynaklar.length && !onceki) {
      throw new KovanHatasi(`'${akis.ad}' akışı mevcut sistemin kaynaklarıyla başlar: kodun ve analiz dokümanının bulunduğu klasörü yaz.`);
    }
    if (akis.kaynak === "yok" && kaynaklar.length) {
      throw new KovanHatasi(`'${akis.ad}' akışı mevcut sistem kaynağı almaz. Var olan bir sistemi yeniden yazmak için Replatform akışını seç.`);
    }
    const projeYolu = (ek.proje ?? "").trim();
    if (akis.kaynak === "proje" && !projeYolu) throw new KovanHatasi(`'${akis.ad}' akışı projenin klasörüyle başlar: projenin bu makinedeki yolunu yaz.`);
    if (akis.kaynak !== "proje" && projeYolu) throw new KovanHatasi(`'${akis.ad}' akışı proje yolu almaz. Var olan bir projede değişiklik için 'Mevcut proje üzerinde iş' başlangıcını seç.`);
    const hedefYigin = akis.kaynak === "proje" ? null : this.hedefYiginCoz(ek.hedef_yigin);
    for (const ad of this.gerekenMotorlar(akis, mod as Mod)) {
      const m = this.motorlar.get(ad)!;
      if (!(await m.saglik(true))) {
        const ipucu = !m.yerel ? "" : m.tur === "openai"
          ? " Adresi ve modeli dış ayar dosyasında, API anahtarını Ayarlar ekranında kontrol et."
          : mod === "yerel"
            ? " 'Hepsi yerel' modunda bütün ajanlar bu motorda çalışır; Ollama'yı başlat ya da Ollama-Kur.command ile kur."
            : this.motorlar.has("claude") ? " Yerel motor olmadan çalıştırmak için 'Hepsi Claude' modunu seç." : "";
        throw new KovanHatasi(`'${ad}' motoru hazır değil: ${m.hata}${ipucu}`);
      }
    }
    const fid = this.depo.yeniId();
    const d = path.join(this.calisma, fid);
    for (const alt of ["belgeler", "kod", "incelemeler", "gunluk", ".kovan"]) fs.mkdirSync(path.join(d, alt), { recursive: true });
    fs.writeFileSync(path.join(d, "belgeler", "fikir.md"), metin + "\n", "utf8");
    let kaynakBilgisi: Fikir["kaynak"] = null;
    let projeBilgisi: ProjeBilgisi | null = null;
    if (projeYolu) {
      try {
        const o = projeIceAl(projeYolu, path.join(d, "kod", PROJE_KLASORU), this.projeAsilYolu(fid));
        fs.writeFileSync(path.join(d, "belgeler", "proje-envanteri.md"), projeEnvanteri(o), "utf8");
        projeBilgisi = { yol: o.yol, dosya_sayisi: o.dosya_sayisi, satir: o.satir, boyut: o.boyut, utf8_olmayan: o.utf8_olmayan.length, atlanan: o.atlanan.length, test_komutu: o.test_komutu };
      } catch (e) {
        fs.rmSync(d, { recursive: true, force: true });
        throw e;
      }
    }
    if (kaynaklar.length) {
      try {
        const o = await kaynakIceAl(kaynaklar, path.join(d, "kod", KAYNAK_KLASORU));
        fs.writeFileSync(path.join(d, "belgeler", "kaynak-envanteri.md"), envanterBelgesi(o, projeBilgisi
          ? `Bu iş için verilen ekler (sözleşme, hata detayı, test senaryosu, analiz notu) \`${KAYNAK_KLASORU}/\` klasöründe (salt okunur, kilitli).` : undefined), "utf8");
        kaynakBilgisi = { yollar: o.yollar, dosya_sayisi: o.dosya_sayisi, satir: o.satir, boyut: o.boyut, donusturulen: o.donusturulen.length, atlanan: o.atlanan.length };
      } catch (e) {
        fs.rmSync(d, { recursive: true, force: true });
        throw e;
      }
    }
    if (onceki) {
      // Önceki sürümün kodu (bağımlılık klasörleri hariç), kararları ve gelişim defteri yeni sürüme taşınır.
      const k = path.join(this.calisma, onceki.kaynak);
      for (const rel of this.agac(path.join(k, "kod"))) {
        fs.mkdirSync(path.dirname(path.join(d, "kod", rel)), { recursive: true });
        fs.cpSync(path.join(k, "kod", rel), path.join(d, "kod", rel), { verbatimSymlinks: true });
      }
      for (const rel of [".kovan/kararlar.json", "belgeler/kararlar.md", ".kovan/gelisim.json", "belgeler/gelisim-defteri.md", "belgeler/kaynak-envanteri.md"]) {
        if (fs.existsSync(path.join(k, rel))) fs.copyFileSync(path.join(k, rel), path.join(d, rel));
      }
      kaynakBilgisi = this.depo.fikir(onceki.kaynak)?.kaynak ?? null;
    }
    // Ajan kod/ kökünde çıplak `npm install` çalıştırırsa npm üst klasörlere çıkıp Kovan'ın kendi
    // package.json'ını değiştirmesin diye kod/ kendi (boş) paket kökü olur.
    fs.writeFileSync(path.join(d, "kod", "package.json"), JSON.stringify({
      name: `kovan-${fid.toLowerCase()}`, private: true,
      description: "Kovan çalışma alanı kökü. Kod backend/, frontend/ ve testler/ altında; npm'i --prefix ile çalıştır.",
    }, null, 2) + "\n", "utf8");
    const zaman = simdi();
    this.depo.fikirEkle({
      id: fid, baslik: (baslik ?? "").trim() || kisalt(metin.split("\n")[0], 70), metin, profil, motor: mod as Mod,
      durum: "sirada", asama_idx: 0, tur: 1, faz: "uret", ek_tur: 0, soru_turu: 0, onaylayanlar: [], geri_bildirim: null, bekleme: null,
      butce_usd: akis.fikir_butcesi_usd, maliyet_usd: 0, girdi_token: 0, cikti_token: 0, istisnalar: {},
      surum: onceki?.surum ?? 1, temel_fikir: onceki?.kaynak ?? null, sonraki_surum: null, kapsam_disi: [],
      kaynak: kaynakBilgisi, proje: projeBilgisi, katilim, birader_veto: 0, hedef_yigin: hedefYigin ?? (onceki ? this.depo.fikir(onceki.kaynak)?.hedef_yigin ?? null : null),
      olusturma: zaman, guncelleme: zaman, baslama: null, bitis: null,
    });
    if (projeBilgisi) {
      this.sistemAdimi(fid, null, "Proje", "tamam", `Proje alındı: ${projeBilgisi.dosya_sayisi.toLocaleString("tr-TR")} dosya, ${projeBilgisi.satir.toLocaleString("tr-TR")} satır. ` +
        "Çalışma kopyası kod/proje/ altında; asıl klasöre dokunulmaz, sonuç yama dosyası olarak çıkar." +
        (projeBilgisi.atlanan ? ` ${projeBilgisi.atlanan} öğe alınmadı (envantere bak).` : "") +
        (projeBilgisi.utf8_olmayan ? ` ${projeBilgisi.utf8_olmayan} dosya UTF-8 değil (envantere bak).` : ""));
    }
    if (fs.existsSync(path.join(d, "kod", KAYNAK_KLASORU))) {
      this.yollariKilitle(fid, [KAYNAK_KLASORU]);
      const k = this.depo.fikir(fid)!.kaynak;
      this.sistemAdimi(fid, null, projeBilgisi ? "Ekler" : "Kaynak", "kilit", k
        ? `${projeBilgisi ? "Ekler alındı ve kilitlendi" : "Mevcut sistem alındı ve kilitlendi"}: ${k.dosya_sayisi} dosya, ${k.satir.toLocaleString("tr-TR")} satır` + (k.donusturulen ? `, ${k.donusturulen} Word belgesi HTML'e çevrildi` : "") + (k.atlanan ? `, ${k.atlanan} öğe alınmadı (envantere bak)` : "")
        : projeBilgisi ? "Ekler kilitlendi." : "Mevcut sistemin kaynakları kilitlendi.");
    }
    if (hedefYigin && !onceki) {
      this.kararlariYaz(fid, [...this.kararlar(fid), {
        zaman, asama_id: null, asama_ad: "Fikir", soran: "Kovan", baslik: "Hedef yığın", soru: "Yeni kod hangi teknolojiyle yazılsın?",
        cevap: hedefYigin, karar_veren: "insan",
      }]);
    }
    if (onceki) this.sistemAdimi(fid, null, "Yeni sürüm", "tamam", `${onceki.kaynak} üzerine ${onceki.surum}. sürüm: kod, kararlar ve gelişim defteri taşındı.`);
    this.planla(fid);
    return fid;
  }

  private hedefYiginCoz(ham: string | undefined): string | null {
    const v = (ham ?? "").trim();
    if (!v) return null;
    const hazir = HEDEF_YIGINLAR.find((h) => h.id === v);
    if (hazir) return `${hazir.ad}: ${hazir.aciklama}`;
    if (v.length < 3) throw new KovanHatasi("Hedef yığını birkaç kelimeyle yaz (ör. Java 21 + Spring Boot, Maven).");
    return v;
  }

  /** Sistem kararı (tur sınırı, hata, bütçe, teslim, kesinti). */
  kararVer(fid: string, secim: string, not = "", hedef: string | null = null): void {
    not = (not ?? "").trim();
    const f = this.fikirAl(fid);
    if (f.durum !== "bekliyor" || !f.bekleme) throw new KovanHatasi("Bu fikir şu an senden karar beklemiyor.");
    const b = f.bekleme;
    const gelisimAtla = b.kaynak === "gelisim" && secim === "atla";
    if (b.sebep === "ajan_sorusu" && secim !== "durdur" && !gelisimAtla) throw new KovanHatasi("Bu bekleme bir ajan sorusu; cevaplarını gönder.");
    if (secim !== "durdur" && !gelisimAtla && !b.secenekler.some((s) => s.anahtar === secim)) throw new KovanHatasi(`Bu bekleme için geçersiz seçim: ${secim}`);
    const asamalar = this.asamalar(f);
    const idx = f.asama_idx;
    const asama = asamalar[idx] ?? null;
    const g: Partial<Fikir> = { bekleme: null, durum: "sirada" };
    const notEkle = (gb: string | null) => ((gb ?? "") + (not ? `\n\n### İnsanın notu\n${not}` : "")).trim();
    // Not bağlayıcı bir karardır: yalnızca üreticiye değil, onaycılara ve sonraki bütün aşamalara "Alınan kararlar"da görünür
    if (not && secim !== "durdur") {
      this.kararlariYaz(fid, [...this.kararlar(fid), {
        zaman: simdi(), asama_id: asama?.id ?? null, asama_ad: asama?.ad ?? null, soran: "Kovan", baslik: "Projenin sahibinin notu",
        soru: b.mesaj, cevap: not, karar_veren: "insan",
      }]);
    }

    switch (secim) {
      case "durdur":
        Object.assign(g, { durum: "durduruldu", bitis: simdi() });
        break;
      case "birader_atla":
        if (!asama) throw new KovanHatasi("Atlanacak aşama yok.");
        g.istisnalar = { ...f.istisnalar, [`birader:${asama.id}`]: "atla" };
        break;
      case "komut_degistir": {
        if (!not) throw new KovanHatasi("Yeni test komutunu not olarak yaz (proje kökünde koşar).");
        const is = this.isOku(fid);
        if (!is) throw new KovanHatasi("Bu fikirde onaylanmış bir iş önerisi yok.");
        this.isYaz(fid, { ...is, test_komutu: this.komutDenetle(not) });
        break;
      }
      case "devam": case "kabul": case "atla":
        if (asama?.tur === "kesif") throw new KovanHatasi("Keşif atlanamaz: onaylanmış iş önerisi olmadan sonraki aşamalar çalışamaz.");
        // Tur sınırında "devam" ile geçilen aşama da tamamlanır: kilitler ve (biçimi geçerliyse) ADR'ler yazılır
        if (secim === "devam" && asama) this.asamaTamamla(fid, asama);
        if (secim === "atla" && asama) this.sistemAdimi(fid, asama, "Atlandı", "atlandi", gelisimAtla ? "Gelişim önerileri şimdilik değerlendirilmedi." : "Aşama senin kararınla atlandı.");
        Object.assign(g, this.ilerlemeAlanlari(fid, idx + 1));
        break;
      case "bir_tur_daha":
        Object.assign(g, { ek_tur: f.ek_tur + 1, tur: f.tur + 1, faz: "uret", geri_bildirim: notEkle(f.geri_bildirim) });
        break;
      case "tekrar_dene":
        if (not && f.faz === "uret") g.geri_bildirim = notEkle(f.geri_bildirim);
        break;
      case "claude_devral":
        if (!asama) throw new KovanHatasi("Devredilecek aşama yok.");
        g.istisnalar = { ...f.istisnalar, [asama.id]: "claude" };
        if (b.sebep === "tur_siniri") Object.assign(g, { ek_tur: f.ek_tur + 1, tur: f.tur + 1, faz: "uret", geri_bildirim: notEkle(f.geri_bildirim) });
        else if (not) g.geri_bildirim = notEkle(f.geri_bildirim);
        break;
      case "butce_artir":
        g.butce_usd = Math.round(Math.max(f.butce_usd * 1.5, f.butce_usd + 1) * 100) / 100;
        break;
      case "kabul_testine_don": {
        if (!not) throw new KovanHatasi("Testte neyin yanlış olduğunu not olarak yaz; Test Otomasyon bu notla düzeltir.");
        const test = asama ? this.kabulTestiAsamasi(f, asama) : null;
        if (!test) throw new KovanHatasi("Bu aşamanın kilitli bir kabul testi aşaması yok.");
        const hidx = asamalar.findIndex((a) => a.id === test.id);
        Object.assign(g, { asama_idx: hidx, tur: 1, faz: "uret", ek_tur: 0, soru_turu: 0, onaylayanlar: [], birader_veto: 0,
          geri_bildirim: `### İnsanın notu (iş kaleminden geri gönderildi: kilitli testte hata)\n${not}` });
        break;
      }
      case "geri_gonder": {
        if (!not) throw new KovanHatasi("Geri gönderirken ne istediğini not olarak yaz.");
        let h = (hedef ?? "").trim() || asama?.geri_donus || null;
        if (!h) {
          const onceki = asamalar.slice(0, idx).filter((a) => a.tur === "ajan");
          if (!onceki.length) throw new KovanHatasi("Geri gönderilecek bir ajan aşaması yok.");
          h = onceki.at(-1)!.id;
        }
        const hidx = asamalar.findIndex((a) => a.id === h);
        if (hidx < 0) throw new KovanHatasi(`Böyle bir aşama yok: ${h}`);
        if (hidx >= idx || !["ajan", "kesif"].includes(asamalar[hidx].tur)) throw new KovanHatasi("Yalnızca önceki bir ajan aşamasına geri gönderebilirsin.");
        Object.assign(g, { asama_idx: hidx, tur: 1, faz: "uret", ek_tur: 0, soru_turu: 0, onaylayanlar: [], birader_veto: 0, geri_bildirim: `### İnsanın notu\n${not}` });
        break;
      }
      default:
        throw new KovanHatasi(`Bilinmeyen seçim: ${secim}`);
    }
    const etiket = (SECIM_ETIKET[secim] ?? secim) + (not ? ` · Not: ${not}` : "");
    this.depo.adimGuncelle(fid, b.adim_id, { durum: "karar", bitis: simdi(), ozet: kisalt(`${b.mesaj} → ${etiket}`, 300) });
    this.depo.fikirGuncelle(fid, g);
    if (g.durum === "sirada") { this.durdurIstekleri.delete(fid); this.planla(fid); }
  }

  /** Ajan sorularına (ya da gelişim önerilerine) insanın cevapları. Kararlar deftere yazılır, iş kaldığı yerden sürer. */
  cevapla(fid: string, cevaplar: Cevap[]): void {
    const f = this.fikirAl(fid);
    const b = f.bekleme;
    if (f.durum !== "bekliyor" || !b || b.sebep !== "ajan_sorusu" || !b.sorular) throw new KovanHatasi("Bu fikir şu an bir ajan sorusu beklemiyor.");
    if (!Array.isArray(cevaplar) || cevaplar.length !== b.sorular.length) throw new KovanHatasi("Her soruya bir cevap ver.");
    const okunan = b.sorular.map((s, i) => {
      const c = cevaplar[i] ?? { secilenler: [] };
      const secilen = (c.secilenler ?? []).map((e) => String(e).replace(/\s*\(Önerilen\)\s*$/i, "").trim()).filter(Boolean);
      const serbest = String(c.serbest ?? "").trim();
      if (!secilen.length && !serbest) throw new KovanHatasi(`"${s.baslik}" sorusunu cevapla: bir seçenek seç ya da kendi cevabını yaz.`);
      if (!s.coklu && secilen.length > 1) throw new KovanHatasi(`"${s.baslik}" sorusunda tek seçenek seçilebilir.`);
      const etiketler = s.secenekler.map((o) => temizEtiket(o.etiket));
      const yabanci = secilen.find((e) => !etiketler.includes(e));
      if (yabanci) throw new KovanHatasi(`"${s.baslik}" sorusunda '${yabanci}' diye bir seçenek yok; kendi cevabını not olarak yaz.`);
      return { s, secilen, serbest };
    });
    let ozet: string;
    let dosya: string;
    const g: Partial<Fikir> = { bekleme: null, durum: "sirada", soru_turu: f.soru_turu + 1 };
    if (b.kaynak === "gelisim") {
      const oneriler = this.gelisimOnerileri(fid, b.asama_id);
      const yeni: GelisimKaydi[] = okunan.map(({ s, secilen, serbest }) => {
        const o = oneriler.find((x) => x.id === s.oneri_id) ?? { id: s.oneri_id ?? "-", baslik: s.baslik, aciklama: s.soru, deger: "", efor: "M", oncelik: "orta" };
        const karar = GELISIM_SECENEKLERI.find((x) => secilen[0] && x.etiket === secilen[0])?.anahtar ?? "degistir";
        return { ...o, karar, not: serbest, zaman: simdi(), surum: f.surum ?? 1, fikir_id: fid };
      });
      this.gelisimYaz(fid, [...this.gelisimDefteri(fid), ...yeni]);
      ozet = "Gelişim önerileri: " + yeni.map((k) => `${k.id} ${k.baslik} → ${GELISIM_ETIKET[k.karar]}`).join(" · ");
      dosya = "belgeler/gelisim-defteri.md";
      Object.assign(g, this.ilerlemeAlanlari(fid, f.asama_idx + 1));
    } else if (b.kaynak === "kapi") {
      // Aşama sonu kapısı: karar özeti maddeleri, mimari kararlar ve belgenin geneli. Not, değişiklik isteğidir.
      const asama = this.asamalar(f)[f.asama_idx];
      if (!asama || asama.id !== b.asama_id) throw new KovanHatasi("Kapının aşaması bulunamadı; fikri durdurup devam ettir.");
      const degisen: { s: AjanSorusu; metin: string }[] = [];
      for (const { s, secilen, serbest } of okunan) {
        if (s.kapi?.tur === "adr") {
          if (!secilen.length) throw new KovanHatasi(`"${s.baslik}" için seçeneklerden birini seç; notun ayrıca işlenir.`);
          const farkli = sadeMetin(secilen[0]) !== sadeMetin(s.kapi.oneri ?? "");
          if (farkli) degisen.push({ s, metin: `"${secilen[0]}" seçildi (öneri "${s.kapi.oneri}" idi).${serbest ? ` Not: ${serbest}` : ""}` });
          else if (serbest) degisen.push({ s, metin: `"${secilen[0]}" kalsın; not: ${serbest}` });
        } else {
          if (secilen[0] === KAPI_DEGISTIR && !serbest) throw new KovanHatasi(`"${s.baslik}": neyin değişmesini istediğini yaz.`);
          if (serbest) degisen.push({ s, metin: serbest });
        }
      }
      g.soru_turu = f.soru_turu;   // kapı, ajanın soru hakkından yemez
      if (degisen.length) {
        this.kararlariYaz(fid, [...this.kararlar(fid), ...degisen.map(({ s, metin }): Karar => ({
          zaman: simdi(), asama_id: b.asama_id, asama_ad: b.asama_ad, soran: "Kovan (aşama onayı)", baslik: s.baslik, soru: s.soru, cevap: metin, karar_veren: "insan",
        }))]);
        ozet = `${b.asama_ad}: ${degisen.length} değişiklik istendi (${degisen.map((d) => d.s.baslik).join(", ")}); aşama yeniden çalışıyor`;
        dosya = "belgeler/kararlar.md";
        Object.assign(g, { faz: "uret", tur: f.tur + 1, ek_tur: f.ek_tur + 1, onaylayanlar: [], birader_veto: 0,
          geri_bildirim: "### Projenin sahibinin kararları (aşama onayı)\n" + degisen.map((d) => `- **${d.s.baslik}**: ${d.metin}`).join("\n") +
            "\n\nYalnızca bu maddeleri işle; onayladığı diğer kararları ve belgenin gerisini koru." });
      } else {
        this.asamaTamamla(fid, asama);
        this.onayYaz(fid, asama, okunan.filter(({ s }) => s.kapi?.tur !== "genel")
          .map(({ s, secilen }) => ({ baslik: s.baslik, karar: s.kapi?.tur === "adr" ? secilen[0] : s.soru.split("\n")[0] })));
        ozet = `${b.asama_ad} onaylandı: ${okunan.length - 1} karar`;
        dosya = "belgeler/onaylar.md";
        Object.assign(g, this.ilerlemeAlanlari(fid, f.asama_idx + 1));
      }
    } else if (b.kaynak === "kesif") {
      // Öneri kartı: tür, boyut, test komutu, yazma alanı. Alan onaylanmadıysa keşif notla yeniden çalışır.
      const [turC, boyutC, komutC, alanC] = okunan;
      const oneri = this.isOnerisi(fid, b.asama_id);
      if (!oneri || okunan.length !== 4) throw new KovanHatasi("Keşif belgesindeki iş önerisi okunamadı; fikri durdurup keşfi yeniden çalıştır.");
      if (!alanC.secilen.length) {
        ozet = `Yazma alanı onaylanmadı; keşif notla yeniden çalışıyor: ${alanC.serbest}`;
        dosya = "";
        Object.assign(g, { faz: "uret", tur: f.tur + 1, geri_bildirim: `### İnsanın notu (iş önerisi)\n${alanC.serbest}` });
      } else {
        const anahtar = <T extends string>(adlar: Record<T, string>, c: typeof turC): T => {
          const k = (Object.keys(adlar) as T[]).find((x) => adlar[x] === c.secilen[0]);
          if (!k) throw new KovanHatasi(`"${c.s.baslik}" için seçeneklerden birini seç; notun ayrıca kaydedilir.`);
          return k;
        };
        const is: IsKaydi = { ...oneri, tur: anahtar(IS_TURLERI, turC), boyut: anahtar(IS_BOYUTLARI, boyutC), test_komutu: this.komutDenetle(komutC.serbest || komutC.secilen[0] || "") };
        const hatalar = isDenetle(is);
        if (hatalar.length) throw new KovanHatasi(hatalar.join(" "));
        this.isYaz(fid, is);
        this.kararlariYaz(fid, [...this.kararlar(fid), ...okunan.map(({ s, secilen, serbest }): Karar => ({
          zaman: simdi(), asama_id: b.asama_id, asama_ad: b.asama_ad, soran: s.soran_ad, baslik: s.baslik, soru: s.soru,
          cevap: s.baslik === "Test komutu" ? is.test_komutu : [secilen.join(", "), serbest].filter(Boolean).join(" · Not: "), karar_veren: "insan",
        }))]);
        ozet = `İş önerisi onaylandı: ${IS_TURLERI[is.tur]}, ${IS_BOYUTLARI[is.boyut]}, test komutu: ${is.test_komutu}`;
        dosya = "belgeler/kararlar.md";
        Object.assign(g, this.ilerlemeAlanlari(fid, f.asama_idx + 1));
      }
    } else {
      const yeni: Karar[] = okunan.map(({ s, secilen, serbest }) => ({
        zaman: simdi(), asama_id: b.asama_id, asama_ad: b.asama_ad, soran: s.soran_ad, baslik: s.baslik, soru: s.soru,
        cevap: [secilen.join(", "), serbest].filter(Boolean).join(" · Not: "), karar_veren: "insan" as const,
        ...(s.oylar?.length ? { oylar: s.oylar } : {}),
      }));
      this.kararlariYaz(fid, [...this.kararlar(fid), ...yeni]);
      ozet = "Cevaplandı: " + yeni.map((k) => `${k.baslik} → ${k.cevap}`).join(" · ");
      dosya = "belgeler/kararlar.md";
      // Üretici sorduysa aynı adım kararla yeniden çalışır; onaycı sorduysa üretici kararı ve bulguları yeni turda işler.
      if (b.kaynak === "inceleme") Object.assign(g, { faz: "uret", tur: f.tur + 1, geri_bildirim: b.bekleyen_geri_bildirim ?? null });
    }
    this.depo.adimGuncelle(fid, b.adim_id, { durum: "karar", bitis: simdi(), ozet: kisalt(ozet, 300), dosya });
    this.depo.fikirGuncelle(fid, g);
    this.durdurIstekleri.delete(fid);
    this.planla(fid);
  }

  /** Fikri siler: klasörü çöp kutusuna taşınır (geri alınabilir). Çalışan ya da sıradaki fikir önce durdurulmalı. */
  fikirSil(fid: string): string {
    const f = this.fikirAl(fid);
    if (f.durum === "calisiyor" || f.durum === "sirada" || this.calisanlar.has(fid) || this.kuyrukListe.includes(fid)) {
      throw new KovanHatasi("Çalışan bir fikir silinemez; önce durdur.", 409);
    }
    return this.depo.fikirKaldir(fid);
  }

  /** Fikrin klasörü (mutlak yol): belgeler/, kod/, incelemeler/ burada. */
  fikirKlasoru(fid: string, alt: "" | "kod" | "belgeler" | "cikti" = ""): string {
    this.fikirAl(fid);
    return path.join(this.calisma, fid, alt);
  }

  durdur(fid: string): void {
    const f = this.fikirAl(fid);
    if (f.durum === "sirada" || f.durum === "calisiyor") {
      this.durdurIstekleri.add(fid);
      for (const p of this.surecler.get(fid) ?? []) sureciOldur(p);
      const sirada = this.kuyrukListe.indexOf(fid);
      if (sirada >= 0) this.kuyrukListe.splice(sirada, 1);
      if (!this.calisanlar.has(fid)) this.durdurUygula(fid);
    } else if (f.durum === "bekliyor") {
      for (const p of this.surecler.get(fid) ?? []) sureciOldur(p);   // süren bir konuşma çağrısı varsa
      if (f.bekleme) this.depo.adimGuncelle(fid, f.bekleme.adim_id, { durum: "karar", bitis: simdi(), ozet: kisalt(`${f.bekleme.mesaj} → Durduruldu`, 300) });
      this.depo.fikirGuncelle(fid, { durum: "durduruldu", bekleme: null, bitis: simdi() });
    } else {
      throw new KovanHatasi("Bu fikir zaten durmuş ya da bitmiş.");
    }
  }

  /** Durmuş ya da bekleyen bir fikrin modunu değiştirir (ör. Hepsi Claude → Hepsi yerel); sonraki ajan çağrıları yeni modda. */
  modDegistir(fid: string, mod: string): void {
    const f = this.fikirAl(fid);
    if (f.durum === "calisiyor" || f.durum === "sirada" || this.calisanlar.has(fid)) throw new KovanHatasi("Çalışan bir fikrin modu değiştirilemez; önce durdur.", 409);
    if (!MODLAR.includes(mod as Mod)) throw new KovanHatasi(`Bilinmeyen mod: ${mod} (hibrit, claude, yerel ya da deneme)`);
    if (!this.acikModlar().includes(mod as Mod)) throw new KovanHatasi(`'${mod}' modu bu kurulumda kapalı. Açık modlar: ${this.acikModlar().join(", ")}`);
    this.gerekenMotorlar(this.akislar.get(f.profil)!, mod as Mod);   // yerel motor tanımlı değilse anlaşılır hata
    if (f.motor === mod) return;
    const eski = f.motor;
    this.depo.fikirGuncelle(fid, { motor: mod as Mod });
    this.sistemAdimi(fid, null, "Mod değişti", "tamam", `${eski} → ${mod}. Sonraki ajan çağrıları yeni modda.`);
  }

  devamEttir(fid: string): void {
    const f = this.fikirAl(fid);
    if (f.durum !== "durduruldu") throw new KovanHatasi("Yalnızca durdurulmuş bir fikir devam ettirilebilir.");
    this.depo.fikirGuncelle(fid, { durum: "sirada", bitis: null });
    this.sistemAdimi(fid, null, "Devam", "tamam", "Kaldığı yerden devam ediyor.");
    this.planla(fid);
  }

  fikirListesi(): FikirOzeti[] {
    return this.depo.fikirler().map((f) => {
      const akis = this.akislar.get(f.profil);
      const asamalar = this.asamalar(f);
      const asama = asamalar[f.asama_idx];
      return {
        id: f.id, baslik: f.baslik, durum: f.durum, profil: f.profil, akis_ad: akis?.ad ?? f.profil, motor: f.motor,
        maliyet_usd: f.maliyet_usd, butce_usd: f.butce_usd, olusturma: f.olusturma, guncelleme: f.guncelleme, asama_ad: asama?.ad ?? "Teslim",
        asama_no: f.asama_idx + 1, asama_sayisi: asamalar.length, bekleme_sebebi: f.bekleme?.sebep ?? null,
        birader: this.biraderDefteri(f.id).at(-1)?.hukum ?? null,
      };
    });
  }

  fikirDetayi(fid: string): FikirDetayi {
    const f = this.fikirAl(fid);
    const akis = this.akislar.get(f.profil);
    const adimlar = this.depo.adimlar(fid);
    const asamalar = this.asamalar(f).map((a, i): AsamaGorunumu => {
      let durum: AsamaGorunumu["durum"];
      if (f.durum === "tamamlandi" || i < f.asama_idx) durum = adimlar.some((s) => s.asama_id === a.id && s.durum === "atlandi") ? "atlandi" : "tamam";
      else if (i === f.asama_idx) durum = ({ bekliyor: "bekliyor", calisiyor: "aktif", sirada: "sirada", durduruldu: "durdu" } as Record<string, AsamaGorunumu["durum"]>)[f.durum] ?? "aktif";
      else durum = "bekleyen";
      const kart = a.ajan ? this.kartlar.get(a.ajan) : undefined;
      const [ajan, ajanAd] = kart ? [kart.kisaltma, kart.ad] : a.tur === "kalemler" ? ["PLAN", "Teslim planındaki iş kalemleri"]
        : a.tur === "kontrol" ? ["TEST", "Sistem (projenin test komutu)"] : a.ajan === "{gelistirici}" ? ["YAZ", "İşin yazılımcısı (öneri kartına göre)"] : ["Sen", "Sen"];
      return {
        id: a.id, ad: a.ad, tur: a.tur, kalem: a.kalem?.id ?? null, kalem_baslik: a.kalem?.baslik ?? null, durum, ajan, ajan_ad: ajanAd,
        motor: kart ? this.motorSec(f, kart, a, true).ad : null,
        yazabilir: a.yazabilir, kilitle: a.kilitle, en_fazla_tur: a.en_fazla_tur, onaylar: this.onayRozetleri(f, a, adimlar),
      };
    });
    const plan = this.planOku(fid);
    const planGorunumu = plan ? plan.kalemler.map((k): PlanKalemiGorunumu => {
      const kendi = asamalar.filter((a) => a.kalem === k.id);
      const durumlar = kendi.map((a) => a.durum);
      const durum = durumlar.length && durumlar.every((d) => d === "tamam" || d === "atlandi") ? "tamam"
        : durumlar.includes("bekliyor") ? "bekliyor" : durumlar.some((d) => d === "aktif" || d === "sirada" || d === "durdu") ? "aktif" : "sirada";
      const kart = this.kartlar.get(k.gelistirici);
      return { ...k, gelistirici_ad: kart?.ad ?? k.gelistirici, gelistirici_kisa: kart?.kisaltma ?? "-", durum, asamalar: kendi.map((a) => a.id) };
    }) : null;
    const motorCagrilari: Record<string, number> = {};
    for (const s of adimlar) if (AJAN_ADIMI.has(s.tip) && s.motor) motorCagrilari[s.motor] = (motorCagrilari[s.motor] ?? 0) + 1;
    return {
      fikir: f,
      akis_ad: akis?.ad ?? f.profil,
      asamalar,
      adimlar,
      bekleme: f.bekleme,
      kararlar: this.kararlar(fid),
      plan: planGorunumu,
      gelisim: this.gelisimDefteri(fid),
      adrler: this.adrOku(fid),
      birader_acik: this.biraderAcik(f),
      birader: this.biraderDefteri(fid),
      onaylar: this.onaylar(fid),
      sohbet: this.sohbetOku(fid),
      sohbet_hedefleri: this.sohbetHedefleri(f),
      is: this.isOku(fid),
      yama: this.yamaOzeti(fid),
      sonraki_surum_metni: f.durum === "tamamlandi" && !f.sonraki_surum ? this.sonrakiSurumMetni(fid) || null : null,
      dosyalar: this.dosyaListesi(fid),
      onizlemeler: this.onizlemeler(fid),
      aktif_sure_sn: Math.round(adimlar.filter((s) => s.tip !== "sistem").reduce((t, s) => t + (s.sure_sn ?? 0), 0) * 10) / 10,
      ajan_cagrisi: adimlar.filter((s) => AJAN_ADIMI.has(s.tip)).length,
      motor_cagrilari: motorCagrilari,
      klasor: path.join(this.calisma, fid),
    };
  }

  private onayRozetleri(f: Fikir, a: Asama, adimlar: Adim[]): OnayRozeti[] {
    const rozetler = a.dogrulama.map((v): OnayRozeti => {
      if (v.tip !== "ajan") {
        const son = adimlar.filter((s) => s.asama_id === a.id && s.tip === "kontrol" && s.ajan_ad === v.ad).at(-1);
        const kisa = { plan: "PLAN", atif: "ATIF", adr: "ADR", komut: "TEST" }[v.tip];
        return { ad: v.ad, kisa, durum: son?.durum ?? null };
      }
      const kart = this.kartlar.get(v.inceleyen!)!;
      const son = adimlar.filter((s) => s.asama_id === a.id && s.tip === "inceleme" && s.ajan === kart.id).at(-1);
      const atlandi = !son && v.atlanabilir && (f.kapsam_disi ?? []).includes(kart.id);
      return { ad: `${v.ad} · ${kart.ad}`, kisa: kart.kisaltma, durum: atlandi ? "atlandi" : son?.durum ?? null };
    });
    if (this.biraderBakar(f, a)) {
      const son = adimlar.filter((s) => s.asama_id === a.id && s.tip === "inceleme" && s.ajan === BIRADER).at(-1);
      rozetler.push({ ad: "Büyük Birader", kisa: "BB", durum: son?.durum ?? null });
    }
    return rozetler;
  }

  dosyaYolu(fid: string, yol: string): string {
    this.fikirAl(fid);   // bilinmeyen id (ör. "../") burada 404 olur
    const kok = fs.realpathSync(path.join(this.calisma, fid));
    const aday = path.resolve(kok, yol);
    if (!aday.startsWith(kok + path.sep)) throw new KovanHatasi("Bu dosyaya erişilemez.", 403);
    if (!fs.existsSync(aday) || !fs.statSync(aday).isFile()) throw new KovanHatasi(`Dosya yok: ${yol}`, 404);
    const gercek = fs.realpathSync(aday);
    if (!gercek.startsWith(kok + path.sep)) throw new KovanHatasi("Bu dosyaya erişilemez.", 403);
    return gercek;
  }

  dosyaOku(fid: string, yol: string): DosyaIcerigi {
    const veri = fs.readFileSync(this.dosyaYolu(fid, yol));
    const kesildi = veri.length > 300_000;
    let icerik: string;
    try { icerik = new TextDecoder("utf-8", { fatal: true }).decode(veri.subarray(0, 300_000)); }
    catch { icerik = "(ikili dosya, gösterilemiyor)"; }
    return { yol, icerik, kesildi, boyut: veri.length };
  }

  // ================================ çalıştırma ================================
  private fikirAl(fid: string): Fikir {
    const f = this.depo.fikir(fid);
    if (!f) throw new KovanHatasi(`Fikir bulunamadı: ${fid}`, 404);
    return f;
  }

  /** Sunucu kapanıp açıldıysa yarıda kalan işleri insanın kararına bırakır. */
  private kurtar(): void {
    this.depo.calisanAdimlariKapat();
    // Geçilmiş bir ADR aşamasının ADR kaydı eksikse tamamlanır (eski sürümde "devam" ile geçilen aşamalar)
    for (const f of this.depo.fikirler()) {
      if (this.adrOku(f.id).length) continue;
      const gecilen = this.asamalar(f).slice(0, f.asama_idx).filter((a) => a.dogrulama.some((v) => v.tip === "adr"));
      for (const a of gecilen) this.adrYaz(f.id, a);
    }
    for (const f of this.depo.fikirler()) {
      const sohbet = this.sohbetOku(f.id);
      if (!sohbet.some((m) => m.durum === "bekliyor")) continue;
      this.sohbetYaz(f.id, sohbet.map((m) => (m.durum === "bekliyor" ? { ...m, durum: "hata", cevap: "Kovan yeniden başladı; soru cevaplanamadı. Yeniden sor." } : m)));
    }
    for (const f of this.depo.durumdakiler("calisiyor", "sirada")) {
      const asama = this.asamalar(f)[f.asama_idx] ?? null;
      this.bekleyeAl(f.id, asama, "kesildi", "Kovan yeniden başladı; bu iş yarıda kalmıştı. Kaldığı yerden devam edebilirsin.",
        secenekler(["tekrar_dene", "durdur"], "tekrar_dene"));
    }
  }

  private planla(fid: string): void {
    if (this.kuyrukListe.includes(fid)) return;
    if (this.calisanlar.has(fid)) { this.tekrar.add(fid); return; }
    this.kuyrukListe.push(fid);
    this.pompala();
  }

  private pompala(): void {
    while (this.calisanlar.size < Math.max(1, this.cfg.paralel_fikir) && this.kuyrukListe.length) {
      const fid = this.kuyrukListe.shift()!;
      this.calisanlar.add(fid);
      void this.calistirGuvenli(fid).finally(() => {
        this.calisanlar.delete(fid);
        if (this.tekrar.delete(fid)) this.planla(fid);
        this.pompala();
      });
    }
  }

  /** Testler ve kapanış için: sırada ya da çalışan iş kalmayana kadar bekler. */
  async bosalt(zamanAsimiMs = 60_000): Promise<void> {
    const t0 = Date.now();
    while ((this.calisanlar.size || this.kuyrukListe.length) && Date.now() - t0 < zamanAsimiMs) await bekle(20);
  }

  private async calistirGuvenli(fid: string): Promise<void> {
    try {
      await this.calistir(fid);
    } catch (e) {
      const iz = (e as Error).stack ?? String(e);
      try {
        fs.writeFileSync(path.join(this.calisma, fid, "gunluk", "orkestrator-hatasi.txt"), iz, "utf8");
        this.bekleyeAl(fid, null, "hata", `Orkestratör hatası: ${(e as Error).message}`, secenekler(["tekrar_dene", "durdur"], "tekrar_dene"), kisalt(iz, 3000));
      } catch (e2) {
        console.error(e2);
      }
    }
  }

  private async calistir(fid: string): Promise<void> {
    let f = this.depo.fikir(fid);
    if (!f || (f.durum !== "sirada" && f.durum !== "calisiyor")) return;
    if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return; }
    const akis = this.akislar.get(f.profil);
    if (!akis) { this.bekleyeAl(fid, null, "hata", `Akış bulunamadı: ${f.profil}`, secenekler(["durdur"])); return; }
    this.depo.fikirGuncelle(fid, { durum: "calisiyor", baslama: f.baslama ?? simdi() });
    for (;;) {
      if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return; }
      f = this.depo.fikir(fid)!;
      const asamalar = this.asamalar(f);
      const idx = f.asama_idx;
      if (idx >= asamalar.length) {
        this.yamaCikar(fid, true);
        this.depo.fikirGuncelle(fid, { durum: "tamamlandi", bitis: simdi() });
        this.sistemAdimi(fid, null, "Teslim", "tamam", "Akış tamamlandı.");
        return;
      }
      const asama = asamalar[idx];
      if (asama.tur === "kalemler") {
        // Teslim planı onaylandı: kalemler aşaması P1, P2... için somut aşamalara açılır, ilki başlar.
        if (this.planAc(fid, asama) !== "ok") return;
        this.depo.fikirGuncelle(fid, this.ilerlemeAlanlari(fid, idx));
        continue;
      }
      if ((await this.asamaYurut(fid, asama)) !== "ok") return;
      this.depo.fikirGuncelle(fid, this.ilerlemeAlanlari(fid, idx + 1));
    }
  }

  /** Teslim planındaki kalemleri okur; kalemler aşaması bundan sonra kalemlerin somut aşamaları olarak görünür. */
  private planAc(fid: string, sablon: Asama): "ok" | "bekle" {
    const f = this.depo.fikir(fid)!;
    const p = planCikar(this.belgeOku(fid, sablon.plan), this.planGelistiricileri(fid, Object.keys(sablon.gelistiriciler)));
    if (!p.kalemler) {
      const planAsamasi = this.asamalar(f).find((a) => a.cikti === sablon.plan);
      return this.bekleyeAl(fid, { ...sablon, geri_donus: sablon.geri_donus ?? planAsamasi?.id ?? null }, "hata",
        `Teslim planı okunamadı: ${p.hatalar!.join(" ")}`, secenekler(["geri_gonder", "tekrar_dene", "durdur"], "geri_gonder"));
    }
    const kayit: PlanKaydi = { kalemler: p.kalemler, surum: f.surum ?? 1, belge: sablon.plan! };
    atomikYaz(this.planYolu(fid), JSON.stringify(kayit, null, 2));
    this.sistemAdimi(fid, sablon, "Plan açıldı", "tamam",
      `${p.kalemler.length} iş kalemi, ${p.kalemler.length * sablon.adimlar.length} aşama: ${p.kalemler.map((k) => `${k.id} ${k.baslik}`).join(" → ")}`);
    return "ok";
  }

  private async asamaYurut(fid: string, asama: Asama): Promise<Sonuc> {
    if (asama.tur === "insan") {
      this.yamaCikar(fid);
      return this.bekleyeAl(fid, asama, "insan", asama.soru || "Onayın gerekiyor.", secenekler(["kabul", "geri_gonder", "durdur"], "kabul"),
        this.teslimOzeti(fid));
    }
    if (asama.tur === "kontrol") return this.kontrolYurut(fid, asama);
    for (;;) {
      if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return "dur"; }
      const f = this.depo.fikir(fid)!;
      const tur = f.tur;
      const sinir = asama.en_fazla_tur + f.ek_tur;
      let ekBulgular: string[] = [];
      if (f.faz !== "dogrula") {
        const [r, ek] = await this.uret(fid, asama, tur, f.geri_bildirim);
        if (r === "tekrar") continue;
        if (r !== "ok") return r;
        ekBulgular = ek;
        this.depo.fikirGuncelle(fid, { faz: "dogrula" });
      }
      const [bulgular, r] = await this.dogrula(fid, asama, tur, ekBulgular);
      if (r === "tekrar") continue;
      if (r !== "ok") return r;
      // Onay kurulu geçirdiyse Büyük Birader işin tamamına bakar; veto, aşamayı yazarına geri gönderir.
      let vetoTuru = 0;
      if (!bulgular.length) {
        const b = await this.biraderDegerlendir(fid, asama, tur);
        if (b.sonuc === "dur" || b.sonuc === "bekle") return b.sonuc;
        if (b.sonuc === "veto") { bulgular.push(b.bulgu!); vetoTuru = 1; }
      }
      if (!bulgular.length) {
        // Senin kapın: kararları onaylamadan aşama tamamlanmaz (kilit ve ADR yazımı onaydan sonra)
        if (this.kapiEtkin(this.depo.fikir(fid)!, asama) && !this.kapiOnayli(fid, asama)) return this.kapiSor(fid, asama);
        this.asamaTamamla(fid, asama);
        if (asama.tur === "gelisim") return this.gelisimSor(fid, asama);
        if (asama.tur === "kesif") return this.kesifSor(fid, asama);
        return "ok";
      }
      const gb = [...ekBulgular, ...bulgular].join("\n\n");
      // Veto turu aşamanın kendi tur hakkından yemez
      if (vetoTuru) { this.depo.fikirGuncelle(fid, { tur: tur + 1, ek_tur: f.ek_tur + 1, faz: "uret", geri_bildirim: gb }); continue; }
      if (tur >= sinir) {
        this.depo.fikirGuncelle(fid, { faz: "uret", geri_bildirim: gb });
        const devral = this.devralinabilir(this.depo.fikir(fid)!, asama);
        // Yazılımcı kilitli testin kendisinin hatalı olduğunu bildirdiyse, testi düzeltmenin tek meşru yolu kabul testine dönmektir
        const testeDon = this.kabulTestiAsamasi(this.depo.fikir(fid)!, asama)
          && this.depo.adimlar(fid).some((s) => s.asama_id === asama.id && s.ajan_ad === "Test şüphesi");
        const anahtarlar = ["bir_tur_daha", ...(devral ? ["claude_devral"] : []), ...(testeDon ? ["kabul_testine_don"] : []), "devam", "durdur"];
        return this.bekleyeAl(fid, asama, "tur_siniri", `'${asama.ad}' ${tur} turda onay alamadı. Bulgular aşağıda; nasıl ilerleyelim?`,
          secenekler(anahtarlar, devral ? "claude_devral" : testeDon ? "kabul_testine_don" : "bir_tur_daha"), gb);
      }
      this.depo.fikirGuncelle(fid, { tur: tur + 1, faz: "uret", geri_bildirim: gb });
    }
  }

  // ---------------------------------- üret ----------------------------------
  private async uret(fid: string, asama: Asama, tur: number, geriBildirim: string | null): Promise<[DonguSonucu, string[]]> {
    const kart = this.kartlar.get(asama.ajan!)!;
    const f = this.depo.fikir(fid)!;
    const motor = this.motorSec(f, kart, asama, true);
    const model = motor.modelSec(kart);
    const d = path.join(this.calisma, fid);
    const dizinModu = asama.calisma_dizini === "kod";
    const cwd = path.join(d, dizinModu ? "kod" : "belgeler");
    if (asama.kilitle.length) this.kilitKaldir(fid, asama.kilitle);
    if (asama.dogrulama.some((v) => v.tip === "adr")) this.kilitKaldir(fid, [ADR_KLASORU]);
    const istem = this.uretimIstemi(fid, asama, geriBildirim, dizinModu);
    // Revizyonda önceki belge saklanır: yeni sürüm ondan kimlik (E5, H2...) kaybederse ya da çok kısalırsa sistem geri çevirir
    const butunlukAnahtari = `${fid}/${asama.id}`;
    const oncekiBelge = geriBildirim && asama.cikti && (!dizinModu || asama.salt_okunur) ? this.belgeOku(fid, asama.cikti) : "";
    if (oncekiBelge) this.oncekiBelgeler.set(butunlukAnahtari, oncekiBelge); else this.oncekiBelgeler.delete(butunlukAnahtari);
    const onceSoru = this.onceSoruTuru(f, asama, tur, geriBildirim);
    const sistem = [kart.govde.trim(), ORTAK_KURALLAR, onceSoru ? ONCE_SORU : this.soruKurallari(f, false, asama),
      !onceSoru && this.ozetIstenir(f, asama) ? KARAR_OZETI : ""].filter(Boolean).join("\n\n");
    let son: AjanSonucu | null = null;
    let sonHata = "";
    let deneme = 0;
    for (deneme = 1; deneme <= this.cfg.deneme_sayisi; deneme++) {
      if (this.butceAsildi(fid)) return [this.butceBeklemesi(fid, asama), []];
      const adim = this.depo.adimEkle({ fikir_id: fid, asama_id: asama.id, asama_ad: asama.ad, tip: "uret", ajan: kart.id, ajan_ad: kart.ad, tur, deneme, durum: "calisiyor", motor: motor.ad, model });
      if (dizinModu) this.onKopyaAl(fid);
      const cagri: AjanCagrisi = {
        rol: kart.id, asama_id: asama.id, gorev_turu: "uret", sistem, istem, model, araclar: [...kart.araclar],
        izinli: [...kart.izinli_komutlar], cwd, sure_sn: kart.sure_dk * 60, sistem_modu: kart.sistem_promptu,
        butce_usd: kart.butce_usd, sema: null, efor: kart.efor, surecCb: this.surecKaydedici(fid),
      };
      son = await motor.calistir(cagri);
      const gunluk = this.gunlukYaz(fid, adim, motor, cagri, son);
      this.depo.maliyetEkle(fid, son.maliyet, son.girdi_token, son.cikti_token);
      const ek = dizinModu ? [...this.alanDenetle(fid, asama, kart), ...this.kilitDenetle(fid, asama, kart)] : [];
      if (this.durdurIstekleri.has(fid)) {
        this.adimKapat(fid, adim, "durduruldu", son, "Kullanıcı durdurdu", gunluk);
        this.durdurUygula(fid);
        return ["dur", []];
      }
      if (son.ok) {
        const soru = this.cfg.ajan_sorulari ? soruCikar(son.metin) : null;
        if (soru?.sorular) {
          this.adimKapat(fid, adim, "soru", son, `${soru.sorular.length} soru: ${soru.sorular.map((s) => s.baslik).join(", ")}`, gunluk);
          const sorular = soru.sorular.map((x) => this.ajanSorusu(kart, x))
            .map((s) => (onceSoru ? { ...s, insan: true, neden: `Kontrol noktası: ${kart.ad} belgeyi yazmadan önce açık sorularını ve varsayımlarını sana getirdi.` } : s));
          return [await this.soruyuIsle(fid, asama, sorular, "uret", null, null), []];
        }
        if (onceSoru) this.sistemAdimi(fid, asama, "Kontrol noktası", "uyari", `${kart.ad} belgeyi yazmadan önce soru sormadı; belge yazıldı, onay kurulu inceleyecek.`);
        if (soru?.hata) {
          sonHata = `Soru bloğu okunamadı: ${soru.hata}`;
          this.adimKapat(fid, adim, "hata", son, sonHata, gunluk);
          continue;
        }
      }
      if (son.ok && (son.metin.trim() || (dizinModu && !asama.salt_okunur))) {
        const metin = son.metin.trim() || "(ajan özet yazmadı)";
        const yol = this.belgeKaydet(fid, asama.cikti!, dizinModu && !asama.salt_okunur ? metin : citAyikla(metin), adim);
        this.adimKapat(fid, adim, "tamam", son, ozetSatiri(metin), yol);
        // Teslim planı yeniden yazıldıysa kalemler, aşamaya gelindiğinde yeni plandan açılır.
        if (this.akislar.get(f.profil)!.asamalar.some((a) => a.tur === "kalemler" && a.plan === asama.cikti)) fs.rmSync(this.planYolu(fid), { force: true });
        // Keşif yeniden yazıldıysa öneri kartı yeniden onaylanır; eski kart ve ona göre açılmış plan geçersizdir.
        if (asama.tur === "kesif") for (const y of [this.isYolu(fid), this.planYolu(fid)]) fs.rmSync(y, { force: true });
        if (metin.includes("TEST ŞÜPHESİ")) {
          this.sistemAdimi(fid, asama, "Test şüphesi", "uyari", kisalt(metin.split("TEST ŞÜPHESİ")[1].replace(/^[:\s]+/, ""), 400));
        }
        return ["ok", ek];
      }
      sonHata = son.hata ?? "Ajan boş çıktı döndürdü";
      this.adimKapat(fid, adim, son.zaman_asimi ? "takildi" : "hata", son, sonHata, gunluk);
      if (son.kalici_hata) break;
      await this.tekrarOncesiBekle(motor, deneme);
    }
    const anahtarlar = ["tekrar_dene", ...(this.devralinabilir(f, asama) ? ["claude_devral"] : []), "atla", "durdur"];
    return [this.bekleyeAl(fid, asama, "hata", `${kart.ad} başarısız oldu (${Math.min(deneme, this.cfg.deneme_sayisi)} deneme): ${sonHata}`,
      secenekler(anahtarlar, "tekrar_dene")), []];
  }

  // -------------------------------- doğrula ---------------------------------
  private async dogrula(fid: string, asama: Asama, tur: number, ekBulgular: string[] = []): Promise<[string[], DonguSonucu]> {
    const bulgular: string[] = [];
    for (const v of asama.dogrulama.filter((x) => x.tip === "komut")) {
      if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return [[], "dur"]; }
      // Test aşamasına kod yazıldıktan sonra dönüldüyse (geri gönderme, kabul testine dönüş) "önce kırmızı" artık sınanamaz:
      // düzeltilen test, sıradaki kod aşamasının yeniden doğrulamasında yeşil olarak koşar.
      if (v.beklenen === "kirmizi" && this.sonrakiKodYazildi(fid, asama)) {
        this.kirmiziCiktilar.delete(`${fid}/${asama.id}`);
        this.sistemAdimi(fid, asama, v.ad, "atlandi-denetim", "Kod zaten yazıldı; test kırmızı beklenmez. Düzeltilen test, sıradaki kod aşaması yeniden doğrulanırken yeşil olarak koşar.");
        continue;
      }
      const [yesil, cikti, zamanAsimi] = await this.komutKos(fid, asama, v, tur);
      if (yesil === null) return [[], "dur"];
      if (v.beklenen === "kirmizi") {
        // Yeni testler koddan önce başarısız olmalı: geçiyorlarsa isteneni (ya da hatayı) yakalamıyorlar.
        if (yesil || zamanAsimi) {
          bulgular.push(`### ${v.ad}: ${yesil ? "YEŞİL (kırmızı bekleniyordu)" : "SÜRE AŞIMI"}\nKomut: \`${v.komut}\`\n` + (yesil
            ? "Yeni testler kod yazılmadan önce başarısız olmalı; şu an bütün testler geçiyor, yani yeni test isteneni (ya da hatayı) yakalamıyor. " +
              "Testi, bugünkü kodda doğru sebeple başarısız olacak biçimde düzelt."
            : `Testler süre sınırında bitmedi.\n\`\`\`\n${kuyruk(cikti, 2000)}\n\`\`\``));
          return [bulgular, "ok"];
        }
        this.kirmiziCiktilar.set(`${fid}/${asama.id}`, kuyruk(cikti, 2500));
        continue;
      }
      if (!yesil) {
        bulgular.push(`### ${v.ad}: KIRMIZI\nKomut: \`${v.komut}\`\n\`\`\`\n${kuyruk(cikti, 3500)}\n\`\`\``);
        return [bulgular, "ok"];   // kırmızı koda onay kurulu harcanmaz
      }
    }
    // Teslim planı ve gelişim önerileri yapılandırılmış blokla gelmeli; bozuksa onay kurulu harcanmaz.
    const bicim = this.bicimDenetle(fid, asama, tur);
    if (bicim) return [[bicim], "ok"];
    const f0 = this.depo.fikir(fid)!;
    const tumKurul = asama.dogrulama.filter((x) => x.tip === "ajan");
    const atlanan = tumKurul.filter((v) => v.atlanabilir && (f0.kapsam_disi ?? []).includes(v.inceleyen!));
    // Revizyon turu: önceki turda onaylayan yeniden bakmaz (testler ve sistem denetimleri yukarıda zaten koştu)
    const korunan = this.cfg.onayi_koru ? tumKurul.filter((v) => !atlanan.includes(v) && (f0.onaylayanlar ?? []).includes(v.inceleyen!)) : [];
    const kurul = tumKurul.filter((v) => !atlanan.includes(v) && !korunan.includes(v));
    if (korunan.length) {
      this.sistemAdimi(fid, asama, "Onay korundu", "onay",
        `${korunan.map((v) => this.kartlar.get(v.inceleyen!)!.ad).join(", ")}: önceki turda onayladı; bu turda yeniden bakmıyor.`);
    }
    if (atlanan.length && !this.depo.adimlar(fid).some((s) => s.asama_id === asama.id && s.ajan_ad === "Kapsam dışı")) {
      const adlar = [...new Set(atlanan.map((v) => this.kartlar.get(v.inceleyen!)!.ad))].join(", ");
      // durum "atlandi" değil: o durum aşamanın kendisinin atlandığı anlamına gelir
      this.sistemAdimi(fid, asama, "Kapsam dışı", "kapsam", `${adlar}: bu fikirde alanına giren bir konu olmadığını söyledi; onayı atlandı.`);
    }
    if (!kurul.length) return [bulgular, "ok"];
    if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return [[], "dur"]; }
    if (this.butceAsildi(fid)) return [[], this.butceBeklemesi(fid, asama)];

    let sonuclar: IncelemeSonucu[];
    if (this.cfg.paralel_inceleme && kurul.length > 1) {
      sonuclar = await Promise.all(kurul.map((v) => this.incele(fid, asama, v, tur)));
    } else {
      sonuclar = [];
      for (const v of kurul) {
        const s = await this.incele(fid, asama, v, tur);
        sonuclar.push(s);
        if (s.tur === "dur") break;
      }
    }
    if (this.durdurIstekleri.has(fid) || sonuclar.some((s) => s.tur === "dur")) { this.durdurUygula(fid); return [[], "dur"]; }
    const hatalar = sonuclar.map((s, i) => [kurul[i], s] as const).filter(([, s]) => s.tur === "hata");
    if (hatalar.length) {
      const mesaj = hatalar.map(([v, s]) => `${this.kartlar.get(v.inceleyen!)!.ad}: ${s.mesaj}`).join("; ");
      return [[], this.bekleyeAl(fid, asama, "hata", `Onay kurulu tamamlanamadı. ${mesaj}`, secenekler(["tekrar_dene", "atla", "durdur"], "tekrar_dene"))];
    }
    const onaylayan = sonuclar.map((s, i) => [kurul[i], s] as const).filter(([, s]) => s.tur === "ok" && s.karar!.karar === "ONAY").map(([v]) => v.inceleyen!);
    if (onaylayan.length) {
      const f1 = this.depo.fikir(fid)!;
      this.depo.fikirGuncelle(fid, { onaylayanlar: [...new Set([...(f1.onaylayanlar ?? []), ...onaylayan])] });
    }
    const kapsamDisi = sonuclar.map((s, i) => [kurul[i], s] as const).filter(([, s]) => s.tur === "ok" && s.kapsam_disi).map(([v]) => v.inceleyen!);
    if (kapsamDisi.length) {
      const f = this.depo.fikir(fid)!;
      this.depo.fikirGuncelle(fid, { kapsam_disi: [...new Set([...(f.kapsam_disi ?? []), ...kapsamDisi])] });
    }
    sonuclar.forEach((s, i) => {
      if (s.tur === "ok" && s.karar!.karar === "DUZELT") {
        const kart = this.kartlar.get(kurul[i].inceleyen!)!;
        const maddeler = s.karar!.bulgular.map((b) => `- ${b}`).join("\n") || "- (madde yazılmadı)";
        bulgular.push(`### ${kurul[i].ad} (${kart.ad}): DÜZELT\nGerekçe: ${s.karar!.gerekce}\n${maddeler}`);
      }
    });
    // Onaycı sorusu: önce ekip oylar; karar çıkınca (ya da insan cevaplayınca) üretici kararı ve aynı turdaki DÜZELT bulgularını tek turda işler.
    const soranlar = sonuclar.map((s, i) => [kurul[i], s] as const).filter(([, s]) => s.tur === "soru");
    if (soranlar.length) {
      const notlar = soranlar.map(([v]) => `### ${v.ad} (${this.kartlar.get(v.inceleyen!)!.ad}): SORU\n` +
        "Karar için soru sordu; karar \"Alınan kararlar\" bölümünde. Çıktını bu karara göre gözden geçir, gerekiyorsa güncelle.");
      const sorular = soranlar.flatMap(([v, s]) => s.sorular!.map((x) => this.ajanSorusu(this.kartlar.get(v.inceleyen!)!, x)));
      return [[], await this.soruyuIsle(fid, asama, sorular, "inceleme", [...ekBulgular, ...bulgular, ...notlar].join("\n\n"),
        bulgular.length ? bulgular.join("\n\n") : null)];
    }
    return [bulgular, "ok"];
  }

  /** Sistem denetimi: teslim planının kovan-plan bloğu, gelişim aşamasının kovan-gelisim bloğu. Bozuksa bulgu döner. */
  private bicimDenetle(fid: string, asama: Asama, tur: number): string | null {
    const belge = () => this.belgeOku(fid, asama.cikti);
    // sessiz: geçerse zaman çizelgesine yazılmaz (her revizyonda koşan bütünlük denetimi gürültü yapmasın)
    const denetimler: { ad: string; sessiz?: boolean; calis: () => { ozet?: string; hatalar?: string[] } }[] = [];
    for (const v of asama.dogrulama.filter((x) => x.tip === "plan")) {
      denetimler.push({ ad: v.ad, calis: () => {
        const p = planCikar(belge(), this.planGelistiricileri(fid, v.gelistiriciler));
        return p.kalemler ? { ozet: `${p.kalemler.length} kalem: ${p.kalemler.map((k) => k.id).join(" → ")}` } : { hatalar: p.hatalar };
      } });
    }
    for (const v of asama.dogrulama.filter((x) => x.tip === "adr")) {
      denetimler.push({ ad: v.ad, calis: () => {
        const r = adrCikar(belge(), { en_az: v.adr_en_az, zorunlu: v.adr_zorunlu });
        return r.adrler ? { ozet: `${r.adrler.length} ADR: ${r.adrler.map((a) => `${a.id} ${a.baslik}`).join(", ")}` } : { hatalar: r.hatalar!.slice(0, 12) };
      } });
    }
    for (const v of asama.dogrulama.filter((x) => x.tip === "atif")) {
      denetimler.push({ ad: v.ad, calis: () => {
        const r = atiflariDenetle(belge(), path.join(this.calisma, fid, "kod"), this.depo.fikir(fid)?.proje ? [PROJE_KLASORU, KAYNAK_KLASORU] : [KAYNAK_KLASORU]);
        return r.hatalar.length ? { hatalar: r.hatalar.slice(0, 12) } : { ozet: `${r.gecerli} atıf, hepsi gerçek dosya ve satırlara gidiyor` };
      } });
    }
    const onceki = this.oncekiBelgeler.get(`${fid}/${asama.id}`);
    if (onceki) {
      denetimler.push({ ad: "Belge bütünlüğü", sessiz: true, calis: () => {
        const r = belgeButunlugu(onceki, belge());
        if (!r.hatalar.length) return { ozet: r.ozet };
        // Kısmi belge yürürlükte kalmasın: önceki tam sürüm geri konur (kısmi olan _surumler'de durur), sonraki tur onu temel alır
        fs.writeFileSync(path.join(this.calisma, fid, "belgeler", `${asama.cikti}.md`), onceki.trimEnd() + "\n", "utf8");
        return { hatalar: [...r.hatalar, "Önceki sürüm yeniden yürürlüğe kondu; düzeltmeyi onun üzerine yap."] };
      } });
    }
    if (this.ozetIstenir(this.depo.fikir(fid)!, asama)) {
      denetimler.push({ ad: "Karar özeti", sessiz: true, calis: () => {
        const r = ozetCikar(belge());
        return r.maddeler ? { ozet: `${r.maddeler.length} madde` } : { hatalar: r.hatalar };
      } });
    }
    if (asama.tur === "kesif") {
      denetimler.push({ ad: "İş önerisi", calis: () => {
        const r = isCikar(belge());
        if (!r.is) return { hatalar: r.hatalar };
        const yok = this.olmayanYollar(fid, r.is);
        return yok.length ? { hatalar: yok }
          : { ozet: `${IS_TURLERI[r.is.tur]}, ${IS_BOYUTLARI[r.is.boyut]}; ${Object.entries(r.is.taraflar).map(([t, a]) => `${t}: ${a.yazma_alani.length} yol`).join(", ")}` };
      } });
    }
    if (asama.tur === "gelisim") {
      denetimler.push({ ad: "Öneri biçimi", calis: () => {
        const g = gelisimCikar(belge());
        return g.oneriler ? { ozet: `${g.oneriler.length} öneri: ${g.oneriler.map((o) => o.baslik).join(", ")}` } : { hatalar: g.hatalar };
      } });
    }
    for (const d of denetimler) {
      const r = d.calis();
      if (d.sessiz && !r.hatalar) continue;
      const adim = this.depo.adimEkle({ fikir_id: fid, asama_id: asama.id, asama_ad: asama.ad, tip: "kontrol", ajan: "-", ajan_ad: d.ad, tur, deneme: 1,
        durum: r.hatalar ? "kirmizi" : "yesil", motor: "sistem", model: null });
      this.depo.adimGuncelle(fid, adim, { bitis: simdi(), sure_sn: 0, ozet: kisalt(r.hatalar ? `Geçersiz · ${r.hatalar.join(" ")}` : `Geçerli · ${r.ozet}`, 300) });
      if (r.hatalar) return `### ${d.ad}: GEÇERSİZ\n${r.hatalar.map((h) => `- ${h}`).join("\n")}`;
    }
    return null;
  }

  private async komutKos(fid: string, asama: Asama, v: Dogrulayici, tur: number): Promise<[boolean | null, string, boolean]> {
    const d = path.join(this.calisma, fid);
    const adim = this.depo.adimEkle({ fikir_id: fid, asama_id: asama.id, asama_ad: asama.ad, tip: "kontrol", ajan: "-", ajan_ad: v.ad, tur, deneme: 1, durum: "calisiyor", motor: "sistem", model: null });
    const kaydet = this.surecKaydedici(fid);
    const t0 = Date.now();
    const { kod, cikti, zamanAsimi } = await new Promise<{ kod: number; cikti: string; zamanAsimi: boolean }>((coz) => {
      let cikti = "";
      let zamanAsimi = false;
      const p = spawn("bash", ["-c", v.komut!], { cwd: path.join(d, "kod", v.dizin ?? ""), detached: true, stdio: ["ignore", "pipe", "pipe"] });
      kaydet(p, false);
      p.stdout!.setEncoding("utf8").on("data", (x) => { cikti += x; });
      p.stderr!.setEncoding("utf8").on("data", (x) => { cikti += x; });
      const saat = setTimeout(() => { zamanAsimi = true; sureciOldur(p); }, v.sure_dk * 60_000);
      p.on("error", (e) => { clearTimeout(saat); kaydet(p, true); coz({ kod: -1, cikti: `Komut çalıştırılamadı: ${e.message}`, zamanAsimi: false }); });
      p.on("close", (k) => {
        clearTimeout(saat); kaydet(p, true);
        cikti = cikti.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");   // test koşucularının renk kodları özete ve ajana giden bulguya karışmasın
        coz({ kod: k ?? -1, cikti: zamanAsimi ? `${cikti}\n(süre sınırı aşıldı: ${v.sure_dk} dk)` : cikti, zamanAsimi });
      });
    });
    const sure = Math.round((Date.now() - t0) / 100) / 10;
    const yol = `gunluk/adim-${adim}-kontrol.txt`;
    fs.writeFileSync(path.join(d, yol), `$ ${v.komut}\n(çıkış kodu: ${kod})\n\n${cikti}`, "utf8");
    if (this.durdurIstekleri.has(fid)) {
      this.depo.adimGuncelle(fid, adim, { durum: "durduruldu", bitis: simdi(), sure_sn: sure, ozet: "Kullanıcı durdurdu", dosya: yol });
      this.durdurUygula(fid);
      return [null, cikti, false];
    }
    const yesil = kod === 0;
    // Kırmızı beklenen denetimde (koddan önceki test) geçme ölçütü tersidir; zaman çizelgesinde de öyle görünür.
    const gecti = v.beklenen === "kirmizi" ? !yesil && !zamanAsimi : yesil;
    const onek = v.beklenen !== "kirmizi" ? "" : gecti ? "Beklendiği gibi kırmızı · " : yesil ? "Yeşil; kırmızı bekleniyordu · " : "";
    this.depo.adimGuncelle(fid, adim, { durum: gecti ? "yesil" : zamanAsimi ? "takildi" : "kirmizi", bitis: simdi(), sure_sn: sure, ozet: onek + testOzeti(cikti, kod), dosya: yol });
    return [yesil, cikti, zamanAsimi];
  }

  private async incele(fid: string, asama: Asama, v: Dogrulayici, tur: number): Promise<IncelemeSonucu> {
    const kart = this.kartlar.get(v.inceleyen!)!;
    const f = this.depo.fikir(fid)!;
    const motor = this.motorSec(f, kart);
    const model = this.incelemeModeli(motor, kart);
    const dizinModu = asama.calisma_dizini === "kod";
    // Replatformda okuma araçları olan onaycı (MSA) belge aşamalarında da eski kodu açıp atıfları doğrulayabilir
    const kaynakOkur = !dizinModu && Boolean(f.kaynak || f.proje) && kart.araclar.includes("Read");
    const cwd = path.join(this.calisma, fid, dizinModu || kaynakOkur ? "kod" : "belgeler");
    const istem = this.incelemeIstemi(fid, asama, v, tur, dizinModu, kaynakOkur);
    const sistem = [kart.govde.trim(), ORTAK_KURALLAR, INCELEME_KURALLARI, v.atlanabilir ? KAPSAM_KURALI : "", this.soruKurallari(f, true, asama)].filter(Boolean).join("\n\n");
    let son: AjanSonucu | null = null;
    for (let deneme = 1; deneme <= this.cfg.deneme_sayisi; deneme++) {
      const adim = this.depo.adimEkle({ fikir_id: fid, asama_id: asama.id, asama_ad: asama.ad, tip: "inceleme", ajan: kart.id, ajan_ad: kart.ad, tur, deneme, durum: "calisiyor", motor: motor.ad, model });
      const cagri: AjanCagrisi = {
        rol: kart.id, asama_id: asama.id, gorev_turu: "inceleme", sistem, istem, model,
        araclar: dizinModu || kaynakOkur ? ["Read", "Glob", "Grep"] : [], izinli: [], cwd, sure_sn: v.sure_dk * 60,
        sistem_modu: dizinModu || kaynakOkur ? "ekle" : kart.sistem_promptu, butce_usd: kart.butce_usd, sema: KARAR_SEMASI, efor: kart.efor,
        surecCb: this.surecKaydedici(fid),
      };
      son = await motor.calistir(cagri);
      const gunluk = this.gunlukYaz(fid, adim, motor, cagri, son);
      this.depo.maliyetEkle(fid, son.maliyet, son.girdi_token, son.cikti_token);
      if (this.durdurIstekleri.has(fid)) { this.adimKapat(fid, adim, "durduruldu", son, "Kullanıcı durdurdu", gunluk); return { tur: "dur" }; }
      const ham = (son.yapisal ?? jsonCikar(son.metin)) as Record<string, unknown> | null;
      const kararAdi = String(ham?.karar ?? "").toUpperCase();
      if (son.ok && ham && kararAdi === "SORU" && this.cfg.ajan_sorulari) {
        const s = sorulariDogrula(ham.sorular);
        if (s.sorular) {
          const yol = this.incelemeKaydet(fid, asama, v, kart, tur, adim, { karar: "SORU", gerekce: String(ham.gerekce ?? ""), bulgular: s.sorular.map((x) => `SORU: ${x.soru}`) });
          this.adimKapat(fid, adim, "soru", son, `${s.sorular.length} soru: ${s.sorular.map((x) => x.baslik).join(", ")}`, yol);
          return { tur: "soru", sorular: s.sorular };
        }
      }
      if (son.ok && ham && (kararAdi === "ONAY" || kararAdi === "DUZELT")) {
        const hb = Array.isArray(ham.bulgular) ? ham.bulgular : ham.bulgular ? [ham.bulgular] : [];
        const karar = { karar: kararAdi, gerekce: String(ham.gerekce ?? ""), bulgular: hb.map(String).filter((b) => b.trim()).slice(0, 8) };
        const yol = this.incelemeKaydet(fid, asama, v, kart, tur, adim, karar);
        const durum = karar.karar === "ONAY" ? "onay" : "duzelt";
        let ozet = kisalt(karar.gerekce, 160);
        if (durum === "duzelt") ozet = `${karar.bulgular.length} bulgu · ${ozet}`;
        const kapsamDisi = durum === "onay" && ham.kapsam_disi === true;
        if (kapsamDisi) ozet = `Kapsam dışı · ${ozet}`;
        this.adimKapat(fid, adim, durum, son, ozet, yol);
        return { tur: "ok", karar, kapsam_disi: kapsamDisi };
      }
      this.adimKapat(fid, adim, son.zaman_asimi ? "takildi" : "hata", son, son.hata ?? "Karar (ONAY/DUZELT) okunamadı", gunluk);
      if (son.kalici_hata) break;
      await this.tekrarOncesiBekle(motor, deneme);
    }
    return { tur: "hata", mesaj: son?.hata || "karar okunamadı" };
  }

  // -------------------------------- istemler --------------------------------
  /** Soru hakkı yumuşak sınırdır: dolunca istem bunu söyler; ajan yine de sorarsa soru ekibe uğramadan sana gelir
   *  (her soru senin cevabını beklediği için başıboş bir döngü oluşamaz). */
  private soruKurallari(f: Fikir, inceleme = false, asama: Asama | null = null): string {
    if (!this.cfg.ajan_sorulari) return "";
    if (f.soru_turu >= this.cfg.en_fazla_soru_turu) return SORU_HAKKI_DOLDU;
    const akis = this.akislar.get(f.profil);
    return soruKurali(Boolean(akis && this.ortakKararAcik(akis)), inceleme, Boolean(asama?.is_kurali_sana));
  }

  /** once_soru aşamasının ilk üretimi mi: aşamada henüz soru sorulmadı, geri bildirimle dönülmedi. */
  private onceSoruTuru(f: Fikir, asama: Asama, tur: number, geriBildirim: string | null): boolean {
    return asama.once_soru && this.cfg.ajan_sorulari && f.soru_turu === 0 && tur === 1 && !geriBildirim;
  }

  private ortakKararAcik(akis: Akis): boolean {
    return this.cfg.ajan_sorulari && this.cfg.ortak_karar.acik && akis.ortak_karar;
  }

  private kararBolumu(fid: string): string[] {
    const k = this.kararlar(fid);
    if (!k.length) return [];
    const kim = (x: Karar) => (x.karar_veren === "ekip" ? `ekip, ${x.kural === "cogunluk" ? "çoğunluk" : "oybirliği"}` : "projenin sahibi");
    return ["", "## Alınan kararlar", "Bu kararlar bağlayıcıdır:",
      ...k.flatMap((x) => [`### ${x.baslik}`, `Soru (${x.soran}): ${x.soru}`, `Karar (${kim(x)}): ${x.cevap}`])];
  }

  /** İş kalemi aşamalarında: kalemin kapsamı ve sınırı. */
  private kalemBolumu(fid: string, asama: Asama): string[] {
    const k = this.planOku(fid)?.kalemler.find((x) => x.id === asama.kalem?.id);
    if (!k) return [];
    return ["", "## İş kalemi", `${k.id}: ${k.baslik}`, `Kapsam: ${k.kapsam}`, `Kabul kriterleri: ${k.kabul.join(", ") || "-"}`,
      `Bağımlı olduğu kalemler: ${k.bagimli.length ? `${k.bagimli.join(", ")} (tamamlandı; kodları ve testleri yerinde)` : "yok"}`,
      "Yalnızca bu kalemin işini yap; sonraki kalemlerin işine girme."];
  }

  /** Replatform fikrinde her üretim istemine: işin bir yeniden yazım olduğu, eski davranışın nerede yazılı olduğu, kaynakların yeri. */
  private mevcutSistemBolumu(fid: string, asama: Asama, dizinModu: boolean): string[] {
    const f = this.depo.fikir(fid);
    const kaynak = f?.kaynak;
    if (!kaynak || f?.proje) return [];   // mevcut projede kaynak/ eklerdir; projeBolumu anlatır
    const p = ["", "## Mevcut sistem", "Bu iş bir replatform: var olan bir sistem yeniden yazılıyor."];
    if (asama.cikti !== "mevcut-sistem") {
      p.push("Eski sistemin bugünkü davranışı \"mevcut-sistem\" belgesinde (koda atıflı); hangi eski kuralın (E1...) korunduğu, değiştiği ya da bırakıldığı hedef analizde. Çıktında eski kurallara bu kimliklerle bağlan.");
    }
    if (dizinModu) {
      p.push(`Eski sistemin kodu ve dokümanları \`${KAYNAK_KLASORU}/\` altında (${kaynak.dosya_sayisi} dosya): salt okunur ve kilitli; Read, Glob, Grep ile oku. Dökümü "kaynak-envanteri" belgesinde.`);
    }
    return p;
  }

  /** Mevcut proje işinde her isteme: işin var olan bir kod tabanında olduğu, türü, projenin ve eklerin yeri, test komutu kuralı. */
  private projeBolumu(fid: string, asama: Asama, dizinModu: boolean): string[] {
    const f = this.depo.fikir(fid);
    if (!f?.proje) return [];
    const is = this.isOku(fid);
    const p = ["", "## Mevcut proje", "Bu iş var olan bir projede yapılıyor: sıfırdan ürün yazılmıyor, çalışan bir kod tabanına dokunuluyor."];
    if (is) p.push(`İş: ${IS_TURLERI[is.tur]} (${IS_BOYUTLARI[is.boyut].toLocaleLowerCase("tr")}). ${TUR_REHBERI[is.tur]}`);
    if (dizinModu) {
      p.push(`Proje \`${PROJE_KLASORU}/\` altında (${f.proje.dosya_sayisi} dosya; dökümü "proje-envanteri" belgesinde). Projenin kendi yapısına, adlandırmasına, ` +
        "stiline ve test çatısına uy; yeni bağımlılık ekleme, ilgisiz dosyayı yeniden biçimlendirme.");
      if (f.kaynak) p.push(`Ekler (sözleşme, hata detayı, test senaryosu, analiz notu) \`${KAYNAK_KLASORU}/\` altında: salt okunur ve kilitli; dökümü "kaynak-envanteri" belgesinde.`);
      if (is && !asama.salt_okunur) {
        p.push(`Çalışma dizinin \`kod/\`, proje bir alt klasörde: komutları proje kökünü vererek çalıştır (\`mvn -f ${PROJE_KLASORU}/pom.xml ...\`, ` +
          `\`gradle -p ${PROJE_KLASORU} ...\`, \`npm --prefix ${PROJE_KLASORU} ...\`). Sistem aşama sonunda proje kökünde şunu koşar: \`${is.test_komutu}\``);
      }
    }
    return p;
  }

  private uretimIstemi(fid: string, asama: Asama, geriBildirim: string | null, dizinModu: boolean): string {
    const p = [`# Görev: ${asama.ad}`, "", asama.gorev || "-", ...(asama.kalem ? this.kalemBolumu(fid, asama) : []), ...this.mevcutSistemBolumu(fid, asama, dizinModu),
      ...this.projeBolumu(fid, asama, dizinModu), ...this.kararBolumu(fid), "", "## Girdiler"];
    const proje = Boolean(this.depo.fikir(fid)?.proje);
    for (const g of asama.girdiler) {
      const b = this.belgeOku(fid, g);
      if (b || !proje) p.push("", `### ${g}`, b || "(bu belge henüz yok)");   // mevcut projede: bu işte koşmayan aşamanın belgesi sessizce düşer
    }
    if (dizinModu) {
      const kilitli = this.kilitOku(fid).yollar;
      const dosyalar = this.kodDosyalari(fid);
      p.push("", "## Çalışma dizini", "Şu an `kod/` klasöründesin. Bu klasörün dışına çıkma.", DOSYA_ERISIMI);
      if (asama.salt_okunur) p.push("BU AŞAMA SALT OKUNUR: hiçbir dosya yazma ya da değiştirme. Yaptığın her değişiklik sistemce geri alınır ve ihlal sayılır.");
      if (asama.yazabilir.length) p.push("YAZMA ALANIN (yalnızca buraya yazabilirsin; dışındaki her değişiklik sistemce geri alınır ve ihlal olarak kaydedilir): " + asama.yazabilir.map((y) => `\`${klasorGibi(y)}\``).join(", "));
      if (kilitli.length) p.push("KİLİTLİ (yalnızca okunur; değiştirirsen sistem geri alır ve ihlal olarak kaydeder): " + kilitli.map((k) => `\`${k}\``).join(", "));
      const adrler = this.adrOku(fid);
      if (adrler.length && kilitli.includes(ADR_KLASORU)) p.push(`MİMARİ KARARLAR \`${ADR_KLASORU}/\` altında (${adrler.map((x) => x.id).join(", ")}): koda başlamadan oku ve uy. Bir karar işini engelliyorsa kodu bükme; bunu belgende söyle.`);
      if (!asama.salt_okunur) p.push(proje ? `Proje dosyaları \`${PROJE_KLASORU}/\` altında; Glob ve Grep ile gez (dökümü "proje-envanteri" belgesinde).`
        : "Mevcut dosyalar: " + (dosyalar.length ? dosyalar.slice(0, 80).map((x) => `\`${x}\``).join(", ") : "(boş)"));
    }
    if (geriBildirim) {
      const onceki = asama.cikti ? this.belgeOku(fid, asama.cikti) : "";
      // Belge üreten aşamada (salt okunur kod aşaması dahil) çıktı dosyada değil son mesajda: önceki belge isteme konmazsa
      // ajan her turda belgeyi sıfırdan yazar, bütçesini buna harcar ve bulguları çözecek zamanı kalmaz.
      const belgeAsamasi = !dizinModu || asama.salt_okunur;
      if (belgeAsamasi && onceki) {
        p.push("", "## Önceki çıktın", "Bu, önceki turda yazdığın ve onay kurulunun incelediği belge. Baştan yazma: bunu temel al, " +
          "onaylanmış kısımları aynen koru, zamanını yalnızca aşağıdaki düzeltme isteklerine (gerekirse kodu açarak) harca. " +
          "Son mesajın yine belgenin tamamı olsun.", "", onceki);
      } else if (dizinModu) p.push("", "## Önceki çalışman", "Önceki turdaki dosyaların yerinde duruyor; onları güncelle.");
      p.push("", "## Düzeltme istekleri", geriBildirim, "", "Yalnızca bu isteklere göre düzelt; onaylanmış kısımları bozma.");
    }
    p.push("", "## Çıktı", dizinModu && !asama.salt_okunur
      ? "İşin bitince son mesajında kısa bir özet yaz: ne yaptın, hangi dosyalar, testlerin son durumu."
      : "Yalnızca istenen belgeyi markdown olarak yaz" + (asama.salt_okunur ? " (son mesajın belgenin kendisi olsun)" : "") + ". Giriş ya da kapanış cümlesi ekleme.");
    return p.join("\n");
  }

  private incelemeIstemi(fid: string, asama: Asama, v: Dogrulayici, tur: number, dizinModu: boolean, kaynakOkur = false): string {
    const yazar = this.kartlar.get(asama.ajan!)!;
    const p = [`# İnceleme: ${asama.ad} (tur ${tur})`, "", `Yazar: ${yazar.ad}. Bu onay kurulunda senin odağın:`,
      v.odak || "Çıktı, referans belgelerdeki gereksinimleri doğru ve eksiksiz karşılıyor mu?",
      ...(asama.kalem ? this.kalemBolumu(fid, asama) : []), ...this.projeBolumu(fid, asama, dizinModu || kaynakOkur), ...this.kararBolumu(fid), ""];
    const proje = Boolean(this.depo.fikir(fid)?.proje);
    const kodYeri = proje ? `\`${PROJE_KLASORU}/\` altındaki kodla (ve varsa \`${KAYNAK_KLASORU}/\` altındaki eklerle)` : `\`${KAYNAK_KLASORU}/\` altındaki kodla`;
    if (asama.salt_okunur) {
      p.push("## İncelenen belge", `### ${asama.cikti}`, this.belgeOku(fid, asama.cikti) || "(boş)", "",
        `Belgedeki iddiaları ${kodYeri} Read, Glob ve Grep kullanarak karşılaştır. Dosya değiştiremezsin.`, DOSYA_ERISIMI);
    } else if (dizinModu) {
      p.push("## İncelenen", "Çalışma dizinindeki (`kod/`) dosyaları Read, Glob ve Grep ile oku. Dosya değiştiremezsin.", DOSYA_ERISIMI);
      if (asama.yazabilir.length) p.push("Yazarın yazma alanı: " + asama.yazabilir.map((y) => `\`${klasorGibi(y)}\``).join(", "));
      p.push("", "### Yazarın özeti", this.belgeOku(fid, asama.cikti) || "-");
      const sonTest = this.depo.adimlar(fid).filter((s) => s.asama_id === asama.id && s.tip === "kontrol").at(-1);
      if (sonTest) p.push("", "### Son test sonucu", sonTest.ozet || "-");
      const kirmizi = this.kirmiziCiktilar.get(`${fid}/${asama.id}`);
      if (kirmizi) p.push("", "### Test çıktısı (kod yazılmadan önce; kırmızı olması bekleniyor)", "Doğru sebeple mi kırmızı: derleme hatası ya da eksik bağımlılık değil, beklenen davranışın henüz olmaması mı?", "```", kirmizi, "```");
    } else {
      p.push("## İncelenen belge", `### ${asama.cikti}`, this.belgeOku(fid, asama.cikti) || "(boş)");
      if (kaynakOkur) {
        p.push("", `${proje ? `Projenin kodu \`${PROJE_KLASORU}/\`` : `Eski sistemin kodu \`${KAYNAK_KLASORU}/\``} altında: belgelerdeki atıfları gerekirse Read, Glob ve Grep ile kodda doğrula. Dosya değiştiremezsin.`, DOSYA_ERISIMI);
      }
    }
    p.push("", "## Referans belgeler");
    for (const g of asama.girdiler) {
      const b = this.belgeOku(fid, g);
      if (b || !proje) p.push("", `### ${g}`, b || "(yok)");   // mevcut projede: bu işte koşmayan aşamanın belgesi sessizce düşer
    }
    p.push("", "## Kararın", 'Yalnızca JSON döndür: {"karar": "ONAY" | "DUZELT" | "SORU", "gerekce": "...", "bulgular": ["..."], "sorular": []' +
      (v.atlanabilir ? ', "kapsam_disi": false' : "") + "}");
    return p.join("\n");
  }

  private oyIstemi(fid: string, asama: Asama, kart: AjanKarti, sorular: AjanSorusu[]): string {
    const p = [`# Ortak karar: ${asama.ad}`, "", "Ekip arkadaşların aşağıdaki soruları sordu. Kendi rolünün gözüyle oy ver."];
    sorular.forEach((s, i) => {
      p.push("", `## Soru ${i + 1}: ${s.baslik} (soran: ${s.soran_ad})`, s.soru, ...s.secenekler.map((o, j) => `${j + 1}. ${o.etiket} — ${o.aciklama}`));
      if (s.coklu) p.push("(Birden çok seçenek seçilebilir.)");
      if (s.soran === kart.id) p.push("(Bu soruyu sen sordun; oyun önerindir, oylaman gerekmez.)");
    });
    p.push(...this.kararBolumu(fid), "", "## Bağlam");
    for (const g of [...new Set(["fikir", ...asama.girdiler])]) p.push("", `### ${g}`, kisalt(this.belgeOku(fid, g), 6000) || "(bu belge henüz yok)");
    const cikti = asama.cikti && (asama.calisma_dizini !== "kod" || asama.salt_okunur) ? this.belgeOku(fid, asama.cikti) : "";
    if (cikti) p.push("", `### ${asama.cikti} (aşamanın şu anki çıktısı)`, kisalt(cikti, 6000));
    if (asama.kalem) p.push(...this.kalemBolumu(fid, asama));
    p.push("", "## Oyun", 'Yalnızca JSON döndür: {"oylar": [{"soru": 1, "secim": [1], "insana_birak": false, "gerekce": "tek cümle"}]}');
    return p.join("\n");
  }

  // ----------------------------- karar defteri -----------------------------
  kararlar(fid: string): Karar[] {
    return jsonOku<Karar[]>(path.join(this.calisma, fid, ".kovan", "kararlar.json"), []);
  }

  private kararlariYaz(fid: string, kararlar: Karar[]): void {
    atomikYaz(path.join(this.calisma, fid, ".kovan", "kararlar.json"), JSON.stringify(kararlar, null, 2));
    const md = ["# Kararlar", "", "Ajanların sorduğu sorular ve verilen kararlar. Ekip oybirliğiyle karar verdiyse sana sorulmadı; anlaşamadıysa ya da",
      "karar senin olması gereken türdense (para, hukuki risk, geri dönüşsüz işlem) sen karar verdin. Sonraki bütün ajanlar bunları bağlayıcı kural olarak görür.", ""];
    const oyMetni = (k: Karar) => (k.oylar ?? []).map((o) => `${o.kisa}: ${o.insana ? "sana bıraktı" : o.secim.join(", ")}${o.soran ? " (soran)" : ""}${o.gerekce && !o.soran ? ` (${o.gerekce})` : ""}`).join(" · ");
    for (const k of kararlar) {
      md.push(`## ${k.baslik}`, `- Aşama: ${k.asama_ad ?? "-"} · soran: ${k.soran} · ${k.zaman}`, `- Soru: ${k.soru}`);
      if (k.karar_veren === "ekip") md.push(`- **Ekip kararı (${k.kural === "cogunluk" ? "çoğunluk" : "oybirliği"}): ${k.cevap}**`);
      else md.push(`- **Senin kararın: ${k.cevap}**`);
      if (k.oylar?.length) md.push(`- Oylar: ${oyMetni(k)}`);
      md.push("");
    }
    atomikYaz(path.join(this.calisma, fid, "belgeler", "kararlar.md"), md.join("\n"));
  }

  // --------------------------- yazma alanı ve kilitler ---------------------------
  private gizliMi(rel: string): boolean {
    const parcalar = rel.split("/");
    const ad = parcalar.at(-1)!;
    return parcalar.some((p) => YOKSAY_KLASOR.has(p)) || YOKSAY_DOSYA.has(ad) || YOKSAY_UZANTI.has(path.extname(ad));
  }

  /** kok altındaki dosyalar (göreli), yok sayılan klasörlere hiç girmeden. haric: atlanacak üst düzey klasörler. */
  private agac(kok: string, haric: string[] = []): string[] {
    const sonuc: string[] = [];
    if (!fs.existsSync(kok)) return sonuc;
    const gez = (dizin: string, rel: string) => {
      for (const g of fs.readdirSync(dizin, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const r = rel ? `${rel}/${g.name}` : g.name;
        if (g.isDirectory()) { if (!YOKSAY_KLASOR.has(g.name) && !(rel === "" && haric.includes(g.name))) gez(path.join(dizin, g.name), r); }
        else if (!this.gizliMi(r)) sonuc.push(r);
      }
    };
    gez(kok, "");
    return sonuc;
  }

  private agacHash(kok: string, haric: string[] = []): Map<string, string> {
    const m = new Map<string, string>();
    for (const rel of this.agac(kok, haric)) {
      const p = path.join(kok, rel);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) m.set(rel, "link:" + fs.readlinkSync(p));
      else if (st.isFile()) m.set(rel, crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
    return m;
  }

  private onKopyaAl(fid: string): void {
    const d = path.join(this.calisma, fid);
    const onceki = path.join(d, ".kovan", "onceki");
    fs.rmSync(onceki, { recursive: true, force: true });
    for (const rel of this.agac(path.join(d, "kod"), [KAYNAK_KLASORU])) {
      const hedef = path.join(onceki, rel);
      fs.mkdirSync(path.dirname(hedef), { recursive: true });
      fs.cpSync(path.join(d, "kod", rel), hedef, { verbatimSymlinks: true });
    }
    fs.mkdirSync(onceki, { recursive: true });
  }

  /** Yazma alanı dışındaki ve kilitli yollardaki değişiklikleri çalıştırma öncesine geri alır. */
  private alanDenetle(fid: string, asama: Asama, kart: AjanKarti): string[] {
    const d = path.join(this.calisma, fid);
    const kod = path.join(d, "kod");
    const onceki = path.join(d, ".kovan", "onceki");
    if (!fs.existsSync(onceki)) return [];
    const once = this.agacHash(onceki);
    const sonra = this.agacHash(kod, [KAYNAK_KLASORU]);
    const degisen = [...new Set([...once.keys(), ...sonra.keys()])].filter((k) => once.get(k) !== sonra.get(k)).sort();
    const kilitli = this.kilitOku(fid).yollar;
    const ihlaller: string[] = [];
    for (const rel of degisen) {
      const kilitte = kilitli.some((y) => altinda(rel, y));
      const alanDisi = asama.salt_okunur || (asama.yazabilir.length > 0 && !asama.yazabilir.some((y) => altinda(rel, y)));
      if (!kilitte && !alanDisi) continue;
      ihlaller.push(`${rel} (${kilitte ? "kilitli" : asama.salt_okunur ? "salt okunur aşama" : "alan dışı"})`);
      const hedef = path.join(kod, rel);
      fs.rmSync(hedef, { recursive: true, force: true });
      if (once.has(rel)) {
        fs.mkdirSync(path.dirname(hedef), { recursive: true });
        fs.cpSync(path.join(onceki, rel), hedef, { verbatimSymlinks: true });
      }
    }
    if (!ihlaller.length) return [];
    const liste = ihlaller.slice(0, 12).join(", ") + (ihlaller.length > 12 ? ` (+${ihlaller.length - 12})` : "");
    const not = `${kart.ad} sınır dışına yazdı: ${liste}. Sistem geri aldı.`;
    this.sistemAdimi(fid, asama, "Sınır ihlali", "ihlal", not);
    const alan = asama.salt_okunur ? "yok (bu aşama salt okunur)" : asama.yazabilir.map((y) => `\`${klasorGibi(y)}\``).join(", ") || "kilitli olmayan her yer";
    return [`### Sınır ihlali\n${not}\nYazma alanın: ${alan}. Kilitli: ${kilitli.join(", ") || "-"}. Bir test ya da tasarım yanlışsa değiştirme; son mesajında 'TEST ŞÜPHESİ:' diye gerekçesiyle yaz.`];
  }

  private kilitYolu(fid: string) { return path.join(this.calisma, fid, ".kovan", "kilitler.json"); }

  private kilitOku(fid: string): { yollar: string[]; hashler: Record<string, string> } {
    const v = jsonOku<{ yollar?: string[]; hashler?: Record<string, string> }>(this.kilitYolu(fid), {});
    return { yollar: v.yollar ?? [], hashler: v.hashler ?? {} };
  }

  private hashle(kod: string, yollar: string[]): Record<string, string> {
    const sonuc: Record<string, string> = {};
    for (const [k, h] of this.agacHash(kod)) if (yollar.some((y) => altinda(k, y))) sonuc[k] = h;
    return sonuc;
  }

  private kilitle(fid: string, asama: Asama): void {
    const kod = path.join(this.calisma, fid, "kod");
    const hashler = this.yollariKilitle(fid, asama.kilitle);
    const [olan, eksik] = [asama.kilitle.filter((y) => fs.existsSync(path.join(kod, y))), asama.kilitle.filter((y) => !fs.existsSync(path.join(kod, y)))];
    const sayi = Object.keys(hashler).filter((k) => asama.kilitle.some((y) => altinda(k, y))).length;
    // Olmayan yollar da kilit kaydına girer: sonradan kimse onları oluşturamaz (ör. Node yığınında kök pom.xml).
    this.sistemAdimi(fid, asama, "Kilit", "kilit",
      `Kilitlendi: ${olan.join(", ") || "-"} (${sayi} dosya, SHA-256)` + (eksik.length ? ` · yok, oluşturulamaz: ${eksik.join(", ")}` : ""));
  }

  /** Yolları kilit kaydına ekler (SHA-256) ve geri alma için kopyalarını saklar. Önceden kilitli dosyaların kopyası zaten yerindedir. */
  private yollariKilitle(fid: string, yeniYollar: string[]): Record<string, string> {
    const d = path.join(this.calisma, fid);
    const kod = path.join(d, "kod");
    const yollar = [...new Set([...this.kilitOku(fid).yollar, ...yeniYollar])].sort();
    const hashler = this.hashle(kod, yollar);
    const kopya = path.join(d, ".kovan", "kilitli");
    for (const y of yeniYollar) fs.rmSync(path.join(kopya, y), { recursive: true, force: true });
    for (const rel of Object.keys(hashler)) {
      if (!yeniYollar.some((y) => altinda(rel, y)) && fs.existsSync(path.join(kopya, rel))) continue;
      fs.mkdirSync(path.dirname(path.join(kopya, rel)), { recursive: true });
      fs.cpSync(path.join(kod, rel), path.join(kopya, rel), { verbatimSymlinks: true });
    }
    atomikYaz(this.kilitYolu(fid), JSON.stringify({ yollar, hashler }, null, 2));
    return hashler;
  }

  private kilitKaldir(fid: string, yollar: string[]): void {
    const reg = this.kilitOku(fid);
    if (!yollar.some((y) => reg.yollar.includes(y))) return;
    const hashler = Object.fromEntries(Object.entries(reg.hashler).filter(([k]) => !yollar.some((y) => altinda(k, y))));
    atomikYaz(this.kilitYolu(fid), JSON.stringify({ yollar: reg.yollar.filter((y) => !yollar.includes(y)), hashler }, null, 2));
  }

  /** İkinci savunma hattı: kilit kaydındaki hash'lerle karşılaştırır (normalde alanDenetle yakalar). */
  private kilitDenetle(fid: string, asama: Asama, kart: AjanKarti): string[] {
    const reg = this.kilitOku(fid);
    if (!reg.yollar.length) return [];
    const d = path.join(this.calisma, fid);
    const kod = path.join(d, "kod");
    const kopya = path.join(d, ".kovan", "kilitli");
    const simdiki = this.hashle(kod, reg.yollar);
    const degisen = [...new Set([...Object.keys(simdiki), ...Object.keys(reg.hashler)])].filter((k) => simdiki[k] !== reg.hashler[k]).sort();
    if (!degisen.length) return [];
    for (const rel of degisen) {
      const hedef = path.join(kod, rel);
      fs.rmSync(hedef, { recursive: true, force: true });
      if (reg.hashler[rel] && fs.existsSync(path.join(kopya, rel))) {
        fs.mkdirSync(path.dirname(hedef), { recursive: true });
        fs.cpSync(path.join(kopya, rel), hedef, { verbatimSymlinks: true });
      }
    }
    const not = `${kart.ad} kilitli dosyalara dokundu: ${degisen.join(", ")}. Sistem dosyaları geri aldı.`;
    this.sistemAdimi(fid, asama, "Sınır ihlali", "ihlal", not);
    return [`### Sınır ihlali\n${not} Kilitli dosyaları değiştirme.`];
  }

  // ------------------------------- yardımcılar -------------------------------
  /** Sonraki aşamaya geçiş. Aşama daha önce üretilmişse (geri dönüş sonrası) yeniden yazılmaz,
   *  yalnızca testler ve onay kurulu yeniden bakar. Sorun bulurlarsa normal döngü işler. */
  private ilerlemeAlanlari(fid: string, sonraki: number): Partial<Fikir> {
    let faz: "uret" | "dogrula" = "uret";
    const a = this.asamalar(this.depo.fikir(fid)!)[sonraki];
    if (a && a.tur === "ajan" && this.depo.adimlar(fid).some((s) => s.asama_id === a.id && s.tip === "uret" && s.durum === "tamam")) {
      faz = "dogrula";
      this.sistemAdimi(fid, a, "Yeniden doğrulama", "yeniden", "Önceki çıktı korunuyor; yalnızca testler ve onay kurulu yeniden bakıyor.");
    }
    return { asama_idx: sonraki, tur: 1, faz, ek_tur: 0, soru_turu: 0, onaylayanlar: [], birader_veto: 0, geri_bildirim: null };
  }

  private bekleyeAl(fid: string, asama: Asama | null, sebep: BeklemeSebebi, mesaj: string, sec: Secenek[], detay: string | null = null,
    ek: Partial<Bekleme> = {}): "bekle" {
    // Keşif atlanamaz ve bulgulara rağmen geçilemez: onaylanmış iş önerisi olmadan sonraki aşamalar çalışamaz.
    if (asama?.tur === "kesif") sec = sec.filter((x) => x.anahtar !== "atla" && x.anahtar !== "devam");
    const adim = this.sistemAdimi(fid, asama, sebep === "ajan_sorusu" ? "Ajan sorusu" : "Seni bekliyor", "bekliyor", mesaj, false);
    const b: Bekleme = { sebep, asama_id: asama?.id ?? null, asama_ad: asama?.ad ?? null, mesaj, secenekler: sec, detay, adim_id: adim, zaman: simdi(), ...ek };
    if (sec.some((s) => s.anahtar === "geri_gonder") && asama) {
      const f = this.depo.fikir(fid)!;
      const asamalar = this.asamalar(f);
      const idx = asamalar.findIndex((a) => a.id === asama.id);
      const onceki = asamalar.slice(0, idx < 0 ? asamalar.length : idx).filter((a) => a.tur === "ajan" || a.tur === "kesif");
      b.geri_hedefler = onceki.map((a) => ({ id: a.id, ad: a.ad }));
      // Varsayılan: aşamanın geri_donus'u; yoksa son kod kalemi (teslimdeki notlar çoğunlukla davranışla ilgilidir); yoksa son aşama.
      const gelistiriciler = new Set(this.akislar.get(f.profil)!.asamalar.flatMap((a) => Object.keys(a.gelistiriciler)));
      // (a.taraf: mevcut projede kalem dışındaki yazılımcı aşaması, ör. küçük işte Düzeltme)
      const sonKod = onceki.filter((a) => (a.kalem || a.taraf) && a.ajan && gelistiriciler.has(a.ajan)).at(-1);
      const geriDonus = asama.geri_donus && onceki.some((a) => a.id === asama.geri_donus) ? asama.geri_donus : null;
      b.varsayilan_hedef = geriDonus ?? sonKod?.id ?? b.geri_hedefler.at(-1)?.id ?? null;
    }
    this.depo.fikirGuncelle(fid, { durum: "bekliyor", bekleme: b });
    return "bekle";
  }

  private ajanSorusu(kart: AjanKarti, x: HamSoru): AjanSorusu {
    return { baslik: x.baslik, soru: x.soru, coklu: x.coklu, secenekler: x.secenekler, soran: kart.id, soran_ad: kart.ad,
      ...(x.insan ? { insan: true } : {}), ...(x.konu ? { konu: x.konu } : {}) };
  }

  private sorulariSor(fid: string, asama: Asama, sorular: AjanSorusu[], kaynak: BeklemeKaynagi, bekleyenGeriBildirim: string | null = null,
    detay: string | null = null, ekipKararlari: Karar[] = []): "bekle" {
    const kimler = [...new Set(sorular.map((s) => s.soran_ad))].join(", ");
    const mesaj = kaynak === "kapi" ? `${asama.ad} hazır: onay kurulu geçirdi. Bu aşamada alınan kararları onayla ya da değiştir.`
      : kaynak === "kesif" ? `${kimler} projeyi inceledi ve iş önerisini çıkardı. Onayla ya da düzelt.`
      : kaynak === "gelisim" ? `${kimler} ${sorular.length} gelişim önerisi getirdi. Sence hangileri olmalı?`
      : sorular.some((s) => s.oylar?.length) ? `Ekip anlaşamadı; ${kimler} devam etmek için kararını soruyor.`
        : `${kimler} devam etmek için kararını soruyor.`;
    return this.bekleyeAl(fid, asama, "ajan_sorusu", mesaj, [], detay, {
      sorular: kaynak === "kapi" ? sorular : sorular.slice(0, 5), kaynak, bekleyen_geri_bildirim: bekleyenGeriBildirim,
      ...(kaynak === "kapi" ? { birader: this.biraderDefteri(fid).filter((d) => d.asama_id === asama.id).at(-1) ?? null } : {}),
      ...(ekipKararlari.length ? { ekip_kararlari: ekipKararlari } : {}),
    });
  }

  /** Ajan soruları: önce ortak karar; ekip hepsine karar verirse iş insan cevaplamış gibi sürer ("tekrar"). */
  private async soruyuIsle(fid: string, asama: Asama, sorular: AjanSorusu[], kaynak: "uret" | "inceleme",
    bekleyenGeriBildirim: string | null, detay: string | null): Promise<DonguSonucu> {
    const r = await this.ortakKarar(fid, asama, sorular);
    if (r === "dur") { this.durdurUygula(fid); return "dur"; }
    if (r.kararlar.length) {
      this.kararlariYaz(fid, [...this.kararlar(fid), ...r.kararlar]);
      this.sistemAdimi(fid, asama, "Ekip kararı", "ekip", r.kararlar.map((k) => `${k.baslik} → ${k.cevap}`).join(" · "));
    }
    if (r.insana.length) return this.sorulariSor(fid, asama, r.insana, kaynak, bekleyenGeriBildirim, detay, r.kararlar);
    const f = this.depo.fikir(fid)!;
    const g: Partial<Fikir> = { soru_turu: f.soru_turu + 1 };
    if (kaynak === "inceleme") Object.assign(g, { faz: "uret", tur: f.tur + 1, geri_bildirim: bekleyenGeriBildirim });
    this.depo.fikirGuncelle(fid, g);
    return "tekrar";
  }

  /** Soruları kurula oylatır: oybirliği (ya da ayara göre çoğunluk) çıkan sorular ekip kararı olur, kalanlar insana gider. */
  private async ortakKarar(fid: string, asama: Asama, sorular: AjanSorusu[]): Promise<{ kararlar: Karar[]; insana: AjanSorusu[] } | "dur"> {
    const f = this.depo.fikir(fid)!;
    if (!this.ortakKararAcik(this.akislar.get(f.profil)!)) return { kararlar: [], insana: sorular };
    if (f.soru_turu >= this.cfg.en_fazla_soru_turu) {
      return { kararlar: [], insana: sorular.map((s) => ({ ...s, neden: "Bu aşamanın soru hakkı dolmuştu; ajan yine de sordu, ekibe uğramadan sana geldi." })) };
    }
    const insana: AjanSorusu[] = [];
    const oylanacak: AjanSorusu[] = [];
    for (const s of sorular) {
      if (s.insan) insana.push({ ...s, neden: s.neden ?? `${s.soran_ad}: bu kararı yalnızca sen verebilirsin (para, hukuki risk, geri dönüşsüz işlem ya da strateji).` });
      else if (asama.is_kurali_sana && s.konu !== "teknik") insana.push({ ...s, neden: "İş kuralı sorusu: bu aşamada iş kuralı soruları ekibe uğramadan sana gelir." });
      else oylanacak.push(s);
    }
    if (!oylanacak.length) return { kararlar: [], insana };
    // Her kurul üyesi bir kez çağrılır; kendi sorduğu soruda oyu kendi önerisidir.
    const uyeler = this.cfg.ortak_karar.kurul.filter((id) => oylanacak.some((s) => s.soran !== id));
    const cagir = async (id: string) => [id, await this.oyIste(fid, asama, this.kartlar.get(id)!, oylanacak)] as const;
    let sonuclar: (readonly [string, HamOy[] | string])[];
    if (this.cfg.paralel_inceleme && uyeler.length > 1) {
      sonuclar = await Promise.all(uyeler.map(cagir));
    } else {
      sonuclar = [];
      for (const id of uyeler) {
        const r = await cagir(id);
        sonuclar.push(r);
        if (r[1] === DURDU) break;
      }
    }
    if (this.durdurIstekleri.has(fid) || sonuclar.some(([, r]) => r === DURDU)) return "dur";
    const kararlar: Karar[] = [];
    oylanacak.forEach((s, i) => {
      const oylar: Oy[] = [];
      const onerilen = s.secenekler.find((o) => /\(Önerilen\)\s*$/i.test(o.etiket));
      if (onerilen) {
        oylar.push({ ajan: s.soran, ajan_ad: s.soran_ad, kisa: this.kartlar.get(s.soran)?.kisaltma ?? s.soran, secim: [temizEtiket(onerilen.etiket)],
          insana: false, gerekce: "Soruyu soran; önerisi bu.", soran: true });
      }
      for (const [id, r] of sonuclar) {
        if (id === s.soran) continue;
        const kart = this.kartlar.get(id)!;
        const temel = { ajan: id, ajan_ad: kart.ad, kisa: kart.kisaltma };
        if (typeof r === "string") { oylar.push({ ...temel, secim: [], insana: true, gerekce: `Oy alınamadı: ${r}` }); continue; }
        const o = r.find((x) => x.soru === i + 1);
        if (!o) { oylar.push({ ...temel, secim: [], insana: true, gerekce: "Bu soruya oy vermedi." }); continue; }
        const secim = [...new Set(o.secim)].filter((n) => n >= 1 && n <= s.secenekler.length).map((n) => temizEtiket(s.secenekler[n - 1].etiket));
        const gecersiz = !o.insana_birak && (!secim.length || (!s.coklu && secim.length > 1));
        oylar.push({ ...temel, secim: o.insana_birak ? [] : secim, insana: o.insana_birak || gecersiz, gerekce: gecersiz ? `Geçersiz oy. ${o.gerekce}` : o.gerekce });
      }
      const say = this.oylariSay(oylar);
      if (say.karar) {
        kararlar.push({ zaman: simdi(), asama_id: asama.id, asama_ad: asama.ad, soran: s.soran_ad, baslik: s.baslik, soru: s.soru,
          cevap: say.karar.join(", "), karar_veren: "ekip", kural: say.kural, oylar });
      } else {
        insana.push({ ...s, oylar, neden: say.neden });
      }
    });
    return { kararlar, insana };
  }

  private oylariSay(oylar: Oy[]): { karar?: string[]; kural?: "oybirligi" | "cogunluk"; neden: string } {
    const birakan = oylar.filter((o) => o.insana);
    if (birakan.length) return { neden: "Ekip kararı sana bıraktı: " + birakan.map((o) => `${o.kisa} (${o.gerekce})`).join("; ") };
    if (oylar.length < 2) return { neden: "Oy verecek başka ekip üyesi yok." };
    const gruplar = new Map<string, Oy[]>();
    for (const o of oylar) {
      const k = [...o.secim].sort().join(" + ");
      gruplar.set(k, [...(gruplar.get(k) ?? []), o]);
    }
    const sirali = [...gruplar.entries()].sort((a, b) => b[1].length - a[1].length);
    const [, enCok] = sirali[0];
    if (gruplar.size === 1) return { karar: enCok[0].secim, kural: "oybirligi", neden: "oybirliği" };
    if (this.cfg.ortak_karar.kural === "cogunluk" && enCok.length * 2 > oylar.length) return { karar: enCok[0].secim, kural: "cogunluk", neden: "çoğunluk" };
    return { neden: "Ekip anlaşamadı: " + sirali.map(([k, l]) => `${l.map((o) => o.kisa).join(", ")} → ${k}`).join(" · ") };
  }

  private async oyIste(fid: string, asama: Asama, kart: AjanKarti, sorular: AjanSorusu[]): Promise<HamOy[] | string> {
    const f = this.depo.fikir(fid)!;
    const motor = this.motorSec(f, kart);
    const model = this.incelemeModeli(motor, kart);
    const istem = this.oyIstemi(fid, asama, kart, sorular);
    const sistem = [kart.govde.trim(), ORTAK_KURALLAR, ORTAK_KARAR_KURALLARI].join("\n\n");
    let son: AjanSonucu | null = null;
    for (let deneme = 1; deneme <= this.cfg.deneme_sayisi; deneme++) {
      if (this.butceAsildi(fid)) return "fikir bütçesi doldu";
      const adim = this.depo.adimEkle({ fikir_id: fid, asama_id: asama.id, asama_ad: asama.ad, tip: "oy", ajan: kart.id, ajan_ad: kart.ad, tur: f.tur, deneme, durum: "calisiyor", motor: motor.ad, model });
      const cagri: AjanCagrisi = {
        rol: kart.id, asama_id: asama.id, gorev_turu: "karar", sistem, istem, model, araclar: [], izinli: [],
        cwd: path.join(this.calisma, fid, "belgeler"), sure_sn: Math.min(kart.sure_dk, 10) * 60, sistem_modu: kart.sistem_promptu,
        butce_usd: kart.butce_usd, sema: OY_SEMASI, efor: kart.efor, surecCb: this.surecKaydedici(fid),
      };
      son = await motor.calistir(cagri);
      const gunluk = this.gunlukYaz(fid, adim, motor, cagri, son);
      this.depo.maliyetEkle(fid, son.maliyet, son.girdi_token, son.cikti_token);
      if (this.durdurIstekleri.has(fid)) { this.adimKapat(fid, adim, "durduruldu", son, "Kullanıcı durdurdu", gunluk); return DURDU; }
      const ham = (son.yapisal ?? jsonCikar(son.metin, "oylar")) as { oylar?: unknown } | null;
      if (son.ok && Array.isArray(ham?.oylar)) {
        const oylar: HamOy[] = (ham!.oylar as Record<string, unknown>[]).map((o) => ({
          soru: Number(o?.soru),
          secim: (Array.isArray(o?.secim) ? o.secim : [o?.secim]).map(Number).filter((n) => Number.isInteger(n)),
          insana_birak: o?.insana_birak === true,
          gerekce: String(o?.gerekce ?? "").trim(),
        })).filter((o) => Number.isInteger(o.soru));
        const ozet = oylar.map((o) => {
          const s = sorular[o.soru - 1];
          if (!s) return null;
          return `${s.baslik} → ${o.insana_birak ? "sana bıraktı" : o.secim.map((n) => (s.secenekler[n - 1] ? temizEtiket(s.secenekler[n - 1].etiket) : `?${n}`)).join(", ")}`;
        }).filter(Boolean).join(" · ");
        this.adimKapat(fid, adim, oylar.some((o) => o.insana_birak) ? "insana" : "oy", son, ozet || "oy verdi", gunluk);
        return oylar;
      }
      this.adimKapat(fid, adim, son.zaman_asimi ? "takildi" : "hata", son, son.hata ?? "Oy (JSON) okunamadı", gunluk);
      if (son.kalici_hata) break;
      await this.tekrarOncesiBekle(motor, deneme);
    }
    return son?.hata || "oy okunamadı";
  }

  /** Gelişim aşaması onaylandı: her öneri sana "olmalı mı?" diye gelir (ekip oylamaz; ürünün yönü senin). */
  private gelisimSor(fid: string, asama: Asama): Sonuc {
    const oneriler = this.gelisimOnerileri(fid, asama.id);
    if (!oneriler.length) return "ok";
    const kart = this.kartlar.get(asama.ajan!)!;
    const sorular: AjanSorusu[] = oneriler.map((o) => ({
      baslik: kisalt(o.baslik, 40), coklu: false, soran: kart.id, soran_ad: kart.ad, insan: true, oneri_id: o.id,
      soru: `${o.aciklama}${o.deger ? ` Kazanç: ${o.deger}` : ""} (efor: ${o.efor}) Sence bu özellik olmalı mı?`,
      neden: "Ürünün yönü senin kararın; ekip bu soruyu oylamaz.",
      secenekler: GELISIM_SECENEKLERI.map((x, i) => ({ etiket: x.etiket + (i === 0 && o.oncelik === "yuksek" ? " (Önerilen)" : ""), aciklama: x.aciklama })),
    }));
    return this.sorulariSor(fid, asama, sorular, "gelisim");
  }

  private gelisimOnerileri(fid: string, asamaId: string | null): GelisimOnerisi[] {
    const f = this.depo.fikir(fid);
    const a = f ? this.asamalar(f).find((x) => x.id === asamaId) : undefined;
    return a?.cikti ? gelisimCikar(this.belgeOku(fid, a.cikti)).oneriler ?? [] : [];
  }

  gelisimDefteri(fid: string): GelisimKaydi[] {
    return jsonOku<GelisimKaydi[]>(path.join(this.calisma, fid, ".kovan", "gelisim.json"), []);
  }

  private gelisimYaz(fid: string, kayitlar: GelisimKaydi[]): void {
    atomikYaz(path.join(this.calisma, fid, ".kovan", "gelisim.json"), JSON.stringify(kayitlar, null, 2));
    const md = ["# Gelişim defteri", "", "Ürün Sahibi'nin gelişim önerileri ve senin kararların. PO yeni öneri getirirken bu deftere bakar:",
      "\"bir daha önerme\" dediklerini getirmez, \"şimdilik hayır\" dediklerini yeni bir gerekçe olmadan getirmez.", ""];
    for (const k of kayitlar) {
      md.push(`## ${k.id} ${k.baslik} (sürüm ${k.surum})`, `- ${k.aciklama}`, `- Kazanç: ${k.deger || "-"} · efor: ${k.efor}`,
        `- **Karar: ${GELISIM_ETIKET[k.karar]}**${k.not ? ` · Not: ${k.not}` : ""}`, "");
    }
    atomikYaz(path.join(this.calisma, fid, "belgeler", "gelisim-defteri.md"), md.join("\n"));
  }

  /** Kabul edilen gelişim önerilerinden yeni sürümün fikir metni. Kabul edilen yoksa boş. */
  private sonrakiSurumMetni(fid: string): string {
    const f = this.depo.fikir(fid);
    if (!f) return "";
    const alinan = this.gelisimDefteri(fid).filter((k) => k.fikir_id === fid && (k.karar === "al" || k.karar === "degistir"));
    if (!alinan.length) return "";
    const p = [`${f.baslik.replace(/\s+v\d+$/, "")}: ${(f.surum ?? 1) + 1}. sürüm. Önceki sürümün kodu kod/ klasöründe duruyor; üzerine geliştir, çalışan davranışı bozma.`,
      "", "## Bu sürümde istenenler"];
    for (const k of alinan) {
      p.push(`- ${k.baslik}: ${k.aciklama}` + (k.karar === "degistir" ? ` Değişiklik isteği: ${k.not || "-"}` : k.not ? ` Not: ${k.not}` : ""));
    }
    const plan = this.planOku(fid);
    if (plan) { p.push("", "## Önceki sürümde teslim edilenler"); for (const k of plan.kalemler) p.push(`- ${k.id} ${k.baslik}: ${k.kapsam}`); }
    const brif = this.belgeOku(fid, "brif");
    if (brif) p.push("", "## Önceki sürümün brifi", kisalt(brif, 2500));
    return p.join("\n");
  }

  // ------------------------------ etkin aşama listesi ------------------------------
  /** Onaylanan ADR'leri kod/adr/ altına Markdown olarak yazar ve kilitler: yazılımcılar okur, değiştiremez.
   *  Aşama yeniden çalışırsa (geri gönderme, yeni sürüm) kilit kalkar, klasör yeniden yazılır. */
  private adrYaz(fid: string, asama: Asama): void {
    const r = adrCikar(this.belgeOku(fid, asama.cikti));
    if (!r.adrler) return;
    const klasor = path.join(this.calisma, fid, "kod", ADR_KLASORU);
    fs.rmSync(klasor, { recursive: true, force: true });
    fs.mkdirSync(klasor, { recursive: true });
    const tarih = simdi().slice(0, 10);
    const satirlar = ["# Mimari karar kayıtları", "", "| ADR | Karar | Alan |", "|---|---|---|"];
    for (const a of r.adrler) {
      fs.writeFileSync(path.join(klasor, adrDosyaAdi(a)), adrMarkdown(a, tarih));
      satirlar.push(`| [${a.id}](${adrDosyaAdi(a)}) ${a.baslik} | ${a.karar} | ${a.alan} |`);
    }
    fs.writeFileSync(path.join(klasor, "README.md"), satirlar.join("\n") + "\n");
    atomikYaz(this.adrYolu(fid), JSON.stringify(r.adrler, null, 2));
    this.yollariKilitle(fid, [ADR_KLASORU]);
    this.sistemAdimi(fid, asama, "ADR", "kilit", `${r.adrler.length} mimari karar kod/${ADR_KLASORU}/ altına yazıldı ve kilitlendi: ${r.adrler.map((a) => a.id).join(", ")}`);
  }

  private adrYolu(fid: string) { return path.join(this.calisma, fid, ".kovan", "adr.json"); }

  adrOku(fid: string): Adr[] { return jsonOku<Adr[]>(this.adrYolu(fid), []); }

  private planYolu(fid: string) { return path.join(this.calisma, fid, ".kovan", "plan.json"); }

  private planOku(fid: string): PlanKaydi | null {
    return jsonOku<PlanKaydi | null>(this.planYolu(fid), null);
  }

  /** Fikrin etkin aşamaları: teslim planı açıldıysa kalemler aşaması yerine kalemlerin somut aşamaları gelir. Mevcut proje
   *  işinde öneri kartı onaylandıysa aşamalar boyuta ve tarafa göre süzülür, karttaki yer tutucular dolar. */
  private asamalar(f: Fikir): Asama[] {
    const akis = this.akislar.get(f.profil);
    if (!akis) return [];
    const is = akis.kaynak === "proje" ? this.isOku(f.id) : null;
    let liste = is ? akis.asamalar.filter((a) => kosulTutar(a.kosul, is)) : akis.asamalar;
    if (liste.some((a) => a.tur === "kalemler")) {
      const plan = this.planOku(f.id);
      liste = liste.flatMap((a) => (a.tur === "kalemler" && plan && plan.belge === a.plan ? kalemleriGenislet(a, plan.kalemler, plan.surum) : [a]));
    }
    return is ? liste.map((a) => isUygula(a, is)) : liste;
  }

  // ------------------------------ Büyük Birader ------------------------------
  /** Bu fikirde Büyük Birader çalışır mı: ayarda açık, akışta kapatılmamış. */
  private biraderAcik(f: Fikir): boolean {
    return this.cfg.buyuk_birader.acik && (this.akislar.get(f.profil)?.buyuk_birader ?? false) && this.kartlar.has(BIRADER);
  }

  /** Bu aşamaya bakar mı: ajan ve keşif aşamaları (kalem adımları dahil); kontrol, insan ve gelişim aşamalarına bakmaz. */
  private biraderBakar(f: Fikir, asama: Asama): boolean {
    return this.biraderAcik(f) && (asama.tur === "ajan" || asama.tur === "kesif") && Boolean(asama.ajan && this.kartlar.has(asama.ajan));
  }

  biraderDefteri(fid: string): BiraderDegerlendirmesi[] {
    return jsonOku<BiraderDegerlendirmesi[]>(path.join(this.calisma, fid, ".kovan", "birader.json"), []);
  }

  private biraderYaz(fid: string, kayitlar: BiraderDegerlendirmesi[]): void {
    const d = path.join(this.calisma, fid);
    atomikYaz(path.join(d, ".kovan", "birader.json"), JSON.stringify(kayitlar, null, 2));
    const md = ["# Büyük Birader'in defteri", "", "Her aşamanın sonunda işin tamamına bakıp verdiği hükümler. VETO aşamayı yazarına geri gönderir; DİKKAT durdurmaz.", ""];
    for (const k of kayitlar) {
      md.push(`## ${k.asama_ad}, tur ${k.tur}: ${HUKUM_ADI[k.hukum]}${k.dusuruldu ? " (kanıtsız veto, düşürüldü)" : ""}`, `*${k.zaman}*`, "", k.ozet || "-");
      for (const b of k.bulgular) md.push(`- **${b.konu}**: ${b.aciklama}${b.kanit ? ` (kanıt: ${b.kanit})` : ""}`);
      if (k.oneri) md.push("", `Öneri: ${k.oneri}`);
      md.push("");
    }
    atomikYaz(path.join(d, "belgeler", "birader-defteri.md"), md.join("\n"));
  }

  /** Aşama başına gidişat: tur, düzeltme isteği, sınır ihlali, izin reddi, son denetim. Büyük Birader'in isteminde tablo olur. */
  private gidisat(fid: string): string[] {
    const adimlar = this.depo.adimlar(fid);
    const sira: string[] = [];
    for (const s of adimlar) if (s.asama_id !== "-" && !sira.includes(s.asama_id)) sira.push(s.asama_id);
    const satirlar = ["| Aşama | Üretim turu | Düzeltme isteği | Sınır ihlali | İzin reddi | Son denetim |", "|---|---|---|---|---|---|"];
    for (const id of sira) {
      const a = adimlar.filter((s) => s.asama_id === id);
      const say = (kosul: (s: Adim) => boolean) => a.filter(kosul).length;
      const kontrol = a.filter((s) => s.tip === "kontrol").at(-1);
      satirlar.push(`| ${a[0].asama_ad} | ${say((s) => s.tip === "uret" && s.durum === "tamam")} | ${say((s) => s.tip === "inceleme" && s.durum === "duzelt")} | ` +
        `${say((s) => s.ajan_ad === "Sınır ihlali")} | ${say((s) => s.ajan_ad === "İzin reddi")} | ${kontrol ? `${kontrol.ajan_ad}: ${kisalt(kontrol.ozet, 60)}` : "-"} |`);
    }
    return satirlar;
  }

  private biraderIstemi(fid: string, asama: Asama, tur: number): string {
    const f = this.depo.fikir(fid)!;
    const yazar = this.kartlar.get(asama.ajan!)!;
    const p = [`# Değerlendirme: ${asama.ad} (tur ${tur})`, "", `Yazar: ${yazar.ad}. Onay kurulu bu aşamayı geçirdi. İşin tamamına bakarak hükmünü ver.`,
      "", "## Fikir", this.belgeOku(fid, "fikir") || f.metin, ...this.kararBolumu(fid), "", "## Gidişat", ...this.gidisat(fid)];
    // Önceki aşamalar: karar özetleri (belgenin tamamı için dosyayı aç)
    const onceki = this.asamalar(f).slice(0, f.asama_idx).filter((a) => a.cikti && (a.tur === "ajan" || a.tur === "kesif"));
    const ozetler: string[] = [];
    for (const a of onceki) {
      const maddeler = ozetCikar(this.belgeOku(fid, a.cikti)).maddeler;
      if (!maddeler) continue;
      ozetler.push(`### ${a.ad} (belgeler/${a.cikti}.md)`, ...maddeler.map((m) => `- ${m.baslik}: ${m.karar}`));
    }
    if (ozetler.length) p.push("", "## Önceki aşamaların karar özetleri", ...ozetler);
    const onaylar = this.onaylar(fid);
    if (onaylar.length) p.push("", "## Projenin sahibinin onayladığı aşamalar", onaylar.map((o) => o.asama_ad).join(", "));
    const defter = this.biraderDefteri(fid).slice(-8);
    if (defter.length) p.push("", "## Önceki değerlendirmelerin", ...defter.map((d) => `- ${d.asama_ad}, tur ${d.tur}: ${HUKUM_ADI[d.hukum]}. ${kisalt(d.ozet, 300)}`));
    const belge = this.belgeOku(fid, asama.cikti);
    p.push("", `## Bu aşamanın çıktısı (belgeler/${asama.cikti}.md)`,
      belge.length > EN_UZUN_BELGE ? `${belge.slice(0, EN_UZUN_BELGE)}\n\n(belge uzun; devamını dosyadan oku)` : belge || "(boş)");
    p.push("", "## Dosyalar", "Çalışma dizinin fikrin klasörü. `belgeler/` bütün aşamaların belgeleri, `incelemeler/` onay kurulunun kararları, `kod/` ürün" +
      (f.proje ? " (`kod/proje/` üzerinde çalışılan proje, `kod/kaynak/` ekler)" : f.kaynak ? " (`kod/kaynak/` eski sistem)" : "") +
      ". Şüphelendiğin yeri Read, Glob ve Grep ile aç; dosya değiştiremezsin.", DOSYA_ERISIMI,
      "", "## Hükmün", 'Yalnızca JSON döndür: {"hukum": "UYGUN" | "DIKKAT" | "VETO", "ozet": "...", "bulgular": [{"konu": "...", "kanit": "...", "aciklama": "..."}], "oneri": "..."}');
    return p.join("\n");
  }

  /** Onay kurulu geçtikten sonra Büyük Birader'in hükmü. veto: aşama bulguyla yazarına döner; bekle: karar sana geldi. */
  private async biraderDegerlendir(fid: string, asama: Asama, tur: number): Promise<{ sonuc: "ok" | "veto" | "bekle" | "dur"; bulgu?: string }> {
    const f = this.depo.fikir(fid)!;
    if (!this.biraderBakar(f, asama) || f.istisnalar?.[`birader:${asama.id}`]) return { sonuc: "ok" };
    if (this.durdurIstekleri.has(fid)) { this.durdurUygula(fid); return { sonuc: "dur" }; }
    if (this.butceAsildi(fid)) return { sonuc: this.butceBeklemesi(fid, asama) };
    const kart = this.kartlar.get(BIRADER)!;
    const motor = this.motorSec(f, kart);
    const model = motor.modelSec(kart);   // ucuz inceleme modeli Büyük Birader'e uygulanmaz
    const istem = this.biraderIstemi(fid, asama, tur);
    const sistem = [kart.govde.trim(), ORTAK_KURALLAR].join("\n\n");
    let son: AjanSonucu | null = null;
    for (let deneme = 1; deneme <= this.cfg.deneme_sayisi; deneme++) {
      const adim = this.depo.adimEkle({ fikir_id: fid, asama_id: asama.id, asama_ad: asama.ad, tip: "inceleme", ajan: kart.id, ajan_ad: kart.ad, tur, deneme, durum: "calisiyor", motor: motor.ad, model });
      const cagri: AjanCagrisi = {
        rol: kart.id, asama_id: asama.id, gorev_turu: "inceleme", sistem, istem, model, araclar: ["Read", "Glob", "Grep"], izinli: [],
        cwd: path.join(this.calisma, fid), sure_sn: kart.sure_dk * 60, sistem_modu: "ekle", butce_usd: kart.butce_usd, sema: BIRADER_SEMASI, efor: kart.efor,
        surecCb: this.surecKaydedici(fid),
      };
      son = await motor.calistir(cagri);
      const gunluk = this.gunlukYaz(fid, adim, motor, cagri, son);
      this.depo.maliyetEkle(fid, son.maliyet, son.girdi_token, son.cikti_token);
      if (this.durdurIstekleri.has(fid)) { this.adimKapat(fid, adim, "durduruldu", son, "Kullanıcı durdurdu", gunluk); this.durdurUygula(fid); return { sonuc: "dur" }; }
      const ham = (son.yapisal ?? jsonCikar(son.metin)) as Record<string, unknown> | null;
      const hukumHam = String(ham?.hukum ?? "").toLocaleUpperCase("tr").replace(/İ/g, "I").trim();
      if (son.ok && ham && (hukumHam === "UYGUN" || hukumHam === "DIKKAT" || hukumHam === "VETO")) {
        const metin = (v: unknown) => (v === undefined || v === null ? "" : String(v)).trim();
        const bulgular: BiraderBulgusu[] = (Array.isArray(ham.bulgular) ? ham.bulgular : []).slice(0, 6)
          .map((x): Record<string, unknown> => (x && typeof x === "object" ? x as Record<string, unknown> : { aciklama: x }))
          .map((x) => ({ konu: metin(x.konu) || "Bulgu", kanit: metin(x.kanit), aciklama: metin(x.aciklama) })).filter((x) => x.aciklama);
        let hukum = hukumHam as BiraderHukmu;
        // Kanıtsız veto geçersiz: dayanağı olmayan bulgu aşamayı geri çeviremez
        const kanitli = bulgular.filter((x) => x.kanit.length >= 8);
        const dusuruldu = hukum === "VETO" && !kanitli.length;
        if (dusuruldu) hukum = "DIKKAT";
        const kayit: BiraderDegerlendirmesi = { asama_id: asama.id, asama_ad: asama.ad, tur, hukum, ozet: metin(ham.ozet), bulgular, oneri: metin(ham.oneri), zaman: simdi(), ...(dusuruldu ? { dusuruldu: true } : {}) };
        this.biraderYaz(fid, [...this.biraderDefteri(fid), kayit]);
        const rel = `incelemeler/${asama.id}-tur${tur}-${kart.id}-adim${adim}.md`;
        fs.writeFileSync(path.join(this.calisma, fid, rel), [`# Büyük Birader: ${asama.ad}, tur ${tur}`, "", `Hüküm: **${HUKUM_ADI[hukum]}**${dusuruldu ? " (kanıtsız veto, sistemce düşürüldü)" : ""}`, "",
          kayit.ozet || "-", "", "## Bulgular", ...(bulgular.length ? bulgular.map((x) => `- **${x.konu}**: ${x.aciklama}${x.kanit ? ` (kanıt: ${x.kanit})` : ""}`) : ["- (yok)"]),
          ...(kayit.oneri ? ["", "## Öneri", kayit.oneri] : [])].join("\n") + "\n", "utf8");
        this.adimKapat(fid, adim, hukum === "VETO" ? "veto" : hukum === "DIKKAT" ? "uyari" : "onay", son,
          `${HUKUM_ADI[hukum]}${bulgular.length ? ` · ${bulgular.length} bulgu` : ""} · ${kisalt(kayit.ozet, 160)}`, rel);
        if (dusuruldu) this.sistemAdimi(fid, asama, "Kanıtsız veto", "uyari", "Büyük Birader veto etti ama hiçbir bulguya kanıt göstermedi; hüküm DİKKAT'e düşürüldü, aşama geri çevrilmedi.");
        if (hukum !== "VETO") return { sonuc: "ok" };
        const bulgu = `### Büyük Birader: VETO\nGerekçe: ${kayit.ozet}\n` + kanitli.map((x) => `- **${x.konu}**: ${x.aciklama} (kanıt: ${x.kanit})`).join("\n");
        const veto = (f.birader_veto ?? 0) + 1;
        if (veto > this.cfg.buyuk_birader.en_fazla_veto) {
          // Tek modelin ısrarı akışı kilitlemesin: sınırdan sonra karar projenin sahibinde
          this.depo.fikirGuncelle(fid, { faz: "uret", geri_bildirim: bulgu });
          return { sonuc: this.bekleyeAl(fid, asama, "tur_siniri", `Büyük Birader '${asama.ad}' aşamasını ${veto}. kez veto etti (sınır ${this.cfg.buyuk_birader.en_fazla_veto}). ` +
            "Onay kurulu aşamayı geçirmişti; nasıl ilerleyelim?", secenekler(["bir_tur_daha", "devam", "durdur"], "bir_tur_daha"), bulgu) };
        }
        this.depo.fikirGuncelle(fid, { birader_veto: veto });
        return { sonuc: "veto", bulgu };
      }
      this.adimKapat(fid, adim, son.zaman_asimi ? "takildi" : "hata", son, son.hata ?? "Hüküm (UYGUN/DIKKAT/VETO) okunamadı", gunluk);
      if (son.kalici_hata) break;
      await this.tekrarOncesiBekle(motor, deneme);
    }
    // Değerlendirme alınamadı: akış kilitlenmez, karar sende
    return { sonuc: this.bekleyeAl(fid, asama, "hata", `Büyük Birader '${asama.ad}' aşamasını değerlendiremedi: ${son?.hata || "hüküm okunamadı"}`,
      secenekler(["tekrar_dene", "birader_atla", "durdur"], "tekrar_dene")) };
  }

  // ------------------------------ aşama sonu kapısı ------------------------------
  private katilimCoz(ham: string | undefined): Katilim {
    const v = (ham ?? "").trim();
    if (!v) return this.cfg.katilim;
    if (!(KATILIMLAR as readonly string[]).includes(v)) throw new KovanHatasi(`Bilinmeyen katılım: ${v} (${KATILIMLAR.join(", ")})`);
    return v as Katilim;
  }

  /** Aşama sonu kapıları fikir ortasında da değiştirilebilir; sonraki aşama sonlarından itibaren geçerlidir. */
  katilimDegistir(fid: string, katilim: string): void {
    this.fikirAl(fid);
    this.depo.fikirGuncelle(fid, { katilim: this.katilimCoz(katilim || "-") });
  }

  /** Bu aşamanın sonunda kapı açılır mı. Keşfin ve gelişimin kendi kartı vardır. */
  private kapiEtkin(f: Fikir, asama: Asama): boolean {
    if (asama.tur !== "ajan") return false;
    const k = f.katilim ?? "sonda";
    return k === "her_asama" || (k === "planlama" && asama.kapi);
  }

  /** Çıktının sonunda karar özeti istenir mi: kapı açılacaksa ya da Büyük Birader aşamaları özetlerinden izleyecekse. */
  private ozetIstenir(f: Fikir, asama: Asama): boolean {
    return asama.tur === "ajan" && (this.kapiEtkin(f, asama) || this.biraderAcik(f));
  }

  /** Onaydan (ya da kapısız aşamada onay kurulundan) sonra: kilitler ve mimari karar kayıtları. */
  private asamaTamamla(fid: string, asama: Asama): void {
    if (asama.kilitle.length) this.kilitle(fid, asama);
    if (asama.dogrulama.some((v) => v.tip === "adr")) this.adrYaz(fid, asama);
  }

  onaylar(fid: string): OnayKaydi[] {
    return jsonOku<OnayKaydi[]>(path.join(this.calisma, fid, ".kovan", "onaylar.json"), []);
  }

  private belgeOzeti(fid: string, asama: Asama): string {
    return crypto.createHash("sha256").update(this.belgeOku(fid, asama.cikti)).digest("hex");
  }

  /** Belge son onaydan beri değişmediyse kapı yeniden açılmaz (geri gönderme sonrası yeniden doğrulama). */
  private kapiOnayli(fid: string, asama: Asama): boolean {
    return this.onaylar(fid).some((o) => o.asama_id === asama.id && o.belge_ozeti === this.belgeOzeti(fid, asama));
  }

  private onayYaz(fid: string, asama: Asama, maddeler: OnayKaydi["maddeler"]): void {
    const d = path.join(this.calisma, fid);
    const kayitlar = [...this.onaylar(fid).filter((o) => o.asama_id !== asama.id),
      { asama_id: asama.id, asama_ad: asama.ad, zaman: simdi(), belge_ozeti: this.belgeOzeti(fid, asama), maddeler }];
    atomikYaz(path.join(d, ".kovan", "onaylar.json"), JSON.stringify(kayitlar, null, 2));
    const md = ["# Onayların", "", "Aşama sonu kapılarında onayladığın kararlar. Değiştirdiklerin karar defterinde (Kararlar).", ""];
    for (const o of kayitlar) md.push(`## ${o.asama_ad}`, `*${o.zaman}*`, "", ...(o.maddeler.length ? o.maddeler.map((m) => `- **${m.baslik}**: ${m.karar}`) : ["- Belgenin geneli"]), "");
    atomikYaz(path.join(d, "belgeler", "onaylar.md"), md.join("\n"));
  }

  /** Kapı kartı: karar özeti maddeleri, mimari kararlar (seçenekleriyle; seçim sende) ve belgenin geneli. */
  private kapiSor(fid: string, asama: Asama): Sonuc {
    const kart = this.kartlar.get(asama.ajan!)!;
    const belge = this.belgeOku(fid, asama.cikti);
    const ortak = { coklu: false, soran: kart.id, soran_ad: kart.ad, insan: true };
    const onayla = { etiket: `${KAPI_ONAY} (Önerilen)`, aciklama: "Karar böyle kalsın." };
    const degistir = { etiket: KAPI_DEGISTIR, aciklama: "Ne değişsin, aşağıya yaz; aşama notunla yeniden çalışır." };
    const turAdi = { karar: "Karar", varsayim: "Varsayım", kapsam: "Kapsam" };
    const sorular: AjanSorusu[] = (ozetCikar(belge).maddeler ?? []).map((m) => ({
      ...ortak, baslik: kisalt(m.baslik, 70), soru: `${m.karar}\nNeden: ${m.neden}` + (m.alternatif ? `\nAlternatif: ${m.alternatif}` : ""),
      neden: `${turAdi[m.tur]}: ${kart.ad} bu aşamada böyle karara bağladı.`, secenekler: [onayla, degistir], kapi: { tur: "ozet", madde_turu: m.tur },
    }));
    if (asama.dogrulama.some((v) => v.tip === "adr")) {
      for (const a of adrCikar(belge).adrler ?? []) {
        const onerilen = (o: { ad: string }) => sadeMetin(o.ad) === sadeMetin(a.karar);
        sorular.push({
          ...ortak, baslik: kisalt(`Mimari karar: ${a.baslik}`, 70), soru: `${a.baglam}\nMimarın gerekçesi: ${a.gerekce}\nSonuçları: ${a.sonuclar}`,
          neden: "Mimari seçim senin: Mimar seçenekleri hazırladı ve birini önerdi.",
          secenekler: [...a.secenekler].sort((x, y) => Number(onerilen(y)) - Number(onerilen(x)))
            .map((o) => ({ etiket: o.ad + (onerilen(o) ? " (Önerilen)" : ""), aciklama: `Artı: ${o.arti} Eksi: ${o.eksi}` })),
          kapi: { tur: "adr", oneri: a.karar },
        });
      }
    }
    sorular.push({ ...ortak, baslik: "Belgenin geneli", soru: "Yukarıdaki maddelerin dışında değişmesini istediğin bir şey var mı? Belgenin tamamı Belgeler altında.",
      secenekler: [onayla, degistir], kapi: { tur: "genel" } });
    return this.sorulariSor(fid, asama, sorular, "kapi");
  }

  // ------------------------------ ajanla konuşma ------------------------------
  sohbetOku(fid: string): SohbetMesaji[] {
    return jsonOku<SohbetMesaji[]>(path.join(this.calisma, fid, ".kovan", "sohbet.json"), []);
  }

  private sohbetYaz(fid: string, mesajlar: SohbetMesaji[]): void {
    atomikYaz(path.join(this.calisma, fid, ".kovan", "sohbet.json"), JSON.stringify(mesajlar, null, 2));
  }

  /** Şu an kime soru sorulabilir: belgesi yazılmış her aşamanın ajanı ve (açıksa) Büyük Birader. */
  private sohbetHedefleri(f: Fikir): FikirDetayi["sohbet_hedefleri"] {
    const liste: FikirDetayi["sohbet_hedefleri"] = [];
    for (const a of this.asamalar(f)) {
      const kart = a.ajan ? this.kartlar.get(a.ajan) : undefined;
      if (!kart || !a.cikti || (a.tur !== "ajan" && a.tur !== "kesif") || !this.belgeOku(f.id, a.cikti)) continue;
      liste.push({ id: kart.id, ad: kart.ad, kisa: kart.kisaltma, asama_id: a.id, asama_ad: a.ad });
    }
    if (this.biraderAcik(f) && liste.length) {
      const kart = this.kartlar.get(BIRADER)!;
      liste.push({ id: kart.id, ad: kart.ad, kisa: kart.kisaltma, asama_id: null, asama_ad: null });
    }
    return liste;
  }

  /** Bir ajana (ya da Büyük Birader'e) soru sor. Cevap arka planda gelir; ajan hiçbir şeye yazamaz. */
  sor(fid: string, hedef: string, asamaId: string | null, soru: string): number {
    const f = this.fikirAl(fid);
    soru = (soru ?? "").trim();
    if (!soru) throw new KovanHatasi("Sorunu yaz.");
    if (soru.length > 4000) throw new KovanHatasi("Soru en fazla 4.000 karakter olabilir.");
    if (f.durum === "calisiyor" || f.durum === "sirada") throw new KovanHatasi("Fikir çalışırken soru sorulamaz; aşama bitince ya da fikri durdurunca sor.");
    if (this.sohbetCalisan.has(fid)) throw new KovanHatasi("Önceki sorunun cevabı bekleniyor; gelince yenisini sor.");
    const h = this.sohbetHedefleri(f).find((x) => x.id === hedef && (x.asama_id ?? null) === (hedef === BIRADER ? null : asamaId));
    if (!h) throw new KovanHatasi("Bu ajana şu an soru sorulamaz: belgesi yazılmış bir aşamanın ajanını ya da Büyük Birader'i seç.");
    if (this.butceAsildi(fid)) throw new KovanHatasi("Fikrin bütçesi doldu; soru sormak için önce bütçeyi artır.");
    const mesajlar = this.sohbetOku(fid);
    const mesaj: SohbetMesaji = { id: (mesajlar.at(-1)?.id ?? 0) + 1, asama_id: hedef === BIRADER ? asamaId : h.asama_id, hedef: h.id, hedef_ad: h.ad, soru, cevap: null, durum: "bekliyor", zaman: simdi(), karar: null };
    this.sohbetYaz(fid, [...mesajlar, mesaj]);
    this.sohbetCalisan.add(fid);
    void this.sohbetYurut(fid, mesaj.id)
      .catch((e) => this.sohbetGuncelle(fid, mesaj.id, { durum: "hata", cevap: `Soru cevaplanamadı: ${(e as Error).message}` }))
      .finally(() => this.sohbetCalisan.delete(fid));
    return mesaj.id;
  }

  private sohbetGuncelle(fid: string, id: number, alanlar: Partial<SohbetMesaji>): void {
    this.sohbetYaz(fid, this.sohbetOku(fid).map((m) => (m.id === id ? { ...m, ...alanlar } : m)));
  }

  private async sohbetYurut(fid: string, id: number): Promise<void> {
    const f = this.depo.fikir(fid)!;
    const mesaj = this.sohbetOku(fid).find((m) => m.id === id)!;
    const kart = this.kartlar.get(mesaj.hedef)!;
    const asama = mesaj.asama_id ? this.asamalar(f).find((a) => a.id === mesaj.asama_id) ?? null : null;
    const birader = kart.id === BIRADER;
    // Salt okunur: Büyük Birader fikrin klasörünü, kod ya da kaynak gören ajan kod/ klasörünü okur; diğerleri araçsız
    const kodOkur = !birader && kart.araclar.includes("Read") && (asama?.calisma_dizini === "kod" || Boolean(f.kaynak || f.proje));
    const cwd = path.join(this.calisma, fid, birader ? "" : kodOkur ? "kod" : "belgeler");
    const araclar = birader || kodOkur ? ["Read", "Glob", "Grep"] : [];
    const motor = this.motorSec(f, kart);
    const model = motor.modelSec(kart);
    const onceki = this.sohbetOku(fid).filter((m) => m.id < id && m.hedef === mesaj.hedef && m.asama_id === mesaj.asama_id && m.durum === "tamam").slice(-4);
    const belge = asama?.cikti ? this.belgeOku(fid, asama.cikti) : "";
    const p = ["# Soru (projenin sahibinden)", "", mesaj.soru];
    if (asama) p.push("", `## Bağlam: ${asama.ad}`, `### ${asama.cikti}`, belge.length > EN_UZUN_BELGE ? `${belge.slice(0, EN_UZUN_BELGE)}\n\n(belge uzun; kısaltıldı)` : belge || "(boş)");
    if (birader) p.push("", "## Gidişat", ...this.gidisat(fid), "", "## Önceki değerlendirmelerin",
      ...(this.biraderDefteri(fid).slice(-8).map((d) => `- ${d.asama_ad}, tur ${d.tur}: ${HUKUM_ADI[d.hukum]}. ${kisalt(d.ozet, 300)}`)), "",
      "Çalışma dizinin fikrin klasörü: `belgeler/`, `incelemeler/`, `kod/`. Gerekirse Read, Glob ve Grep ile aç.", DOSYA_ERISIMI);
    else if (kodOkur) p.push("", "Çalışma dizinin `kod/`: gerekirse dosyaları Read, Glob ve Grep ile aç. Dosya değiştiremezsin.", DOSYA_ERISIMI);
    p.push(...this.kararBolumu(fid));
    if (onceki.length) p.push("", "## Önceki konuşma", ...onceki.flatMap((m) => [`Soru: ${m.soru}`, `Cevabın: ${kisalt(m.cevap, 1500)}`, ""]));
    p.push("", "## Cevabın", "Yalnızca cevabını yaz (markdown).");
    const sistem = [kart.govde.trim(), ORTAK_KURALLAR, SOHBET_KURALLARI].join("\n\n");
    const adim = this.depo.adimEkle({ fikir_id: fid, asama_id: asama?.id ?? "-", asama_ad: asama?.ad ?? "-", tip: "sohbet", ajan: kart.id, ajan_ad: kart.ad, tur: f.tur, deneme: 1, durum: "calisiyor", motor: motor.ad, model });
    const cagri: AjanCagrisi = {
      rol: kart.id, asama_id: asama?.id ?? "-", gorev_turu: "sohbet", sistem, istem: p.join("\n"), model, araclar, izinli: [], cwd, sure_sn: kart.sure_dk * 60,
      sistem_modu: araclar.length ? "ekle" : kart.sistem_promptu, butce_usd: kart.butce_usd, sema: null, efor: kart.efor, surecCb: this.surecKaydedici(fid),
    };
    const son = await motor.calistir(cagri);
    const gunluk = this.gunlukYaz(fid, adim, motor, cagri, son);
    this.depo.maliyetEkle(fid, son.maliyet, son.girdi_token, son.cikti_token);
    if (son.ok && son.metin.trim()) {
      this.sohbetGuncelle(fid, id, { durum: "tamam", cevap: citAyikla(son.metin) });
      this.adimKapat(fid, adim, "tamam", son, kisalt(`Soru: ${mesaj.soru}`, 200), gunluk);
    } else {
      this.sohbetGuncelle(fid, id, { durum: son.hata ? "hata" : "durduruldu", cevap: son.hata ? `Soru cevaplanamadı: ${son.hata}` : "Soru yarıda kesildi." });
      this.adimKapat(fid, adim, son.zaman_asimi ? "takildi" : "hata", son, son.hata ?? "Cevap gelmedi", gunluk);
    }
  }

  /** Konuşmadan çıkan sonucu karara bağla: senin yazdığın cümle deftere girer, sonraki bütün ajanlar görür. */
  sohbetKarari(fid: string, id: number, metin: string): void {
    this.fikirAl(fid);
    metin = (metin ?? "").trim();
    if (!metin) throw new KovanHatasi("Kararı bir cümleyle yaz.");
    const mesaj = this.sohbetOku(fid).find((m) => m.id === id);
    if (!mesaj || mesaj.durum !== "tamam") throw new KovanHatasi("Karara bağlanacak cevap bulunamadı.");
    if (mesaj.karar) throw new KovanHatasi("Bu cevap zaten karara bağlandı.");
    const asama = mesaj.asama_id ? this.asamalar(this.depo.fikir(fid)!).find((a) => a.id === mesaj.asama_id) : undefined;
    this.kararlariYaz(fid, [...this.kararlar(fid), {
      zaman: simdi(), asama_id: asama?.id ?? null, asama_ad: asama?.ad ?? null, soran: mesaj.hedef_ad, baslik: kisalt(metin, 60),
      soru: `Konuşmadan çıkan karar. Sorulan: ${kisalt(mesaj.soru, 300)}`, cevap: metin, karar_veren: "insan",
    }]);
    this.sohbetGuncelle(fid, id, { karar: metin });
    this.sistemAdimi(fid, asama ?? null, "Karara bağlandı", "karar", `${mesaj.hedef_ad} ile konuşmadan: ${kisalt(metin, 240)}`);
  }

  // ------------------------------ mevcut proje üzerinde iş ------------------------------
  private isYolu(fid: string) { return path.join(this.calisma, fid, ".kovan", "is.json"); }
  private projeAsilYolu(fid: string) { return path.join(this.calisma, fid, ".kovan", "proje-asil"); }

  private isOku(fid: string): IsKaydi | null {
    return jsonOku<IsKaydi | null>(this.isYolu(fid), null);
  }

  private isYaz(fid: string, is: IsKaydi): void {
    atomikYaz(this.isYolu(fid), JSON.stringify(is, null, 2));
  }

  /** Keşif belgesindeki (henüz onaylanmamış) iş önerisi. */
  private isOnerisi(fid: string, asamaId: string | null): IsOnerisi | null {
    const f = this.depo.fikir(fid);
    const a = f ? this.asamalar(f).find((x) => x.id === asamaId) : undefined;
    return a?.cikti ? isCikar(this.belgeOku(fid, a.cikti)).is ?? null : null;
  }

  /** Bu aşamadan sonraki bir aşama daha önce üretim yaptı mı (aşamaya geri dönüldü mü)? */
  private sonrakiKodYazildi(fid: string, asama: Asama): boolean {
    const liste = this.asamalar(this.depo.fikir(fid)!);
    const sonrakiler = new Set(liste.slice(liste.findIndex((a) => a.id === asama.id) + 1).map((a) => a.id));
    return this.depo.adimlar(fid).some((s) => s.tip === "uret" && s.durum === "tamam" && sonrakiler.has(s.asama_id));
  }

  /** Test komutu senin yazdığın tek satırdır; orkestratör proje kökünde bash ile koşar. */
  private komutDenetle(ham: string): string {
    const k = (ham ?? "").trim();
    if (!k) throw new KovanHatasi("Test komutu boş olamaz: projenin testlerini koşan komutu yaz (ör. mvn -q test).");
    if (/[\r\n]/.test(k) || k.length > 300) throw new KovanHatasi("Test komutu tek satır ve en fazla 300 karakter olmalı.");
    return k;
  }

  /** Önerilen yazma yolları projede karşılığı olan yerler mi: yolun kendisi ya da üst klasörü var olmalı (uydurma yol geri döner). */
  private olmayanYollar(fid: string, is: IsOnerisi): string[] {
    const kod = path.join(this.calisma, fid, "kod");
    const hatalar: string[] = [];
    for (const [taraf, a] of Object.entries(is.taraflar)) {
      for (const y of a.yazma_alani) {
        if (!fs.existsSync(path.join(kod, y)) && !fs.existsSync(path.dirname(path.join(kod, y))))
          hatalar.push(`${taraf}.yazma_alani: \`${y}\` projede yok (üst klasörü de yok). Yolu Glob ile doğrula.`);
      }
    }
    return hatalar;
  }

  /** Teslim planında izin verilen yazılımcılar: mevcut proje işinde yalnızca işin taraflarındakiler. */
  private planGelistiricileri(fid: string, liste: string[]): string[] {
    const f = this.depo.fikir(fid);
    const is = f?.proje ? this.isOku(fid) : null;
    if (!f || !is) return liste;
    const harita = Object.assign({}, ...(this.akislar.get(f.profil)?.asamalar ?? []).map((a) => a.gelistiriciler)) as Asama["gelistiriciler"];
    const uygun = liste.filter((g) => !harita[g] || harita[g].taraf in is.taraflar);
    return uygun.length ? uygun : liste;
  }

  /** Öneri kartı: keşfin önerdiği tür, boyut ve yazma alanı ile saptanan test komutu sana gelir; onaylar ya da düzeltirsin. */
  private kesifSor(fid: string, asama: Asama): Sonuc {
    const f = this.depo.fikir(fid)!;
    const oneri = this.isOnerisi(fid, asama.id);
    if (!oneri) return this.bekleyeAl(fid, asama, "hata", "Keşif belgesindeki iş önerisi okunamadı.", secenekler(["tekrar_dene", "durdur"], "tekrar_dene"));
    const kart = this.kartlar.get(asama.ajan!)!;
    const ortak = { coklu: false, soran: kart.id, soran_ad: kart.ad, insan: true };
    const isaret = (secili: boolean) => (secili ? " (Önerilen)" : "");
    const komut = f.proje?.test_komutu ?? null;
    const alanlar = Object.entries(oneri.taraflar)
      .map(([t, a]) => `${t.toUpperCase()}: ${a.yazma_alani.map((y) => `\`${y}\``).join(", ")}; yeni testler \`${a.test_alani}\``).join(" · ");
    const sorular: AjanSorusu[] = [
      { ...ortak, baslik: "İş türü", soru: `Keşfe göre bu iş: ${IS_TURLERI[oneri.tur].toLocaleLowerCase("tr")}. Gerekçe: ${oneri.gerekce}`,
        neden: "İşin türü, boyutu ve dokunulacak alan senin kararın; ekip bu soruları oylamaz.",
        secenekler: (Object.keys(IS_TURLERI) as IsTuru[]).map((k) => ({ etiket: IS_TURLERI[k] + isaret(k === oneri.tur), aciklama: TUR_ACIKLAMA[k] })) },
      { ...ortak, baslik: "Boyut", soru: "İş hangi yoldan geçsin? Boyut, koşacak aşamaları belirler; küçük iş için derin planlama yapılmaz.",
        secenekler: (Object.keys(IS_BOYUTLARI) as IsBoyutu[]).map((k) => ({ etiket: IS_BOYUTLARI[k] + isaret(k === oneri.boyut), aciklama: BOYUT_ACIKLAMA[k] })) },
      { ...ortak, baslik: "Test komutu", soru: "Projenin testleri hangi komutla koşsun? Komut proje kökünde çalışır: işe başlamadan önce (baz çizgisi) ve her kod aşamasından sonra." +
          (komut ? "" : " Projenin yapısından bir komut saptanamadı; kendi komutunu yaz."),
        secenekler: komut ? [{ etiket: `${komut} (Önerilen)`, aciklama: "Projenin yapısından saptandı. Farklıysa kendi komutunu aşağıya yaz (ör. yalnızca ilgili modülün testleri)." }] : [] },
      { ...ortak, baslik: "Yazma alanı", soru: `Ajanlar yalnızca şu yollara yazabilecek; projenin gerisine dokunulamaz. ${alanlar}`,
        secenekler: [{ etiket: `${ALAN_ONAYI} (Önerilen)`, aciklama: "Alan uygun. Uygun değilse seçme; neyin değişmesi gerektiğini aşağıya yaz, keşif notunla yeniden çalışır." }] },
    ];
    return this.sorulariSor(fid, asama, sorular, "kesif");
  }

  /** Ajansız aşama (baz çizgisi): yalnızca komut koşar. Kırmızıysa iş başlamaz; komutu değiştirir ya da durdurursun. */
  private async kontrolYurut(fid: string, asama: Asama): Promise<Sonuc> {
    for (const v of asama.dogrulama) {
      const [yesil, cikti] = await this.komutKos(fid, asama, v, this.depo.fikir(fid)!.tur);
      if (yesil === null) return "dur";
      if (!yesil) {
        return this.bekleyeAl(fid, asama, "hata", `${v.ad}: projenin testleri işe başlamadan kırmızı (\`${v.komut}\`). Kırmızı bir baz çizgisinde hangi hatanın ` +
          "bu işten geldiği ayırt edilemez. Komutu daralt (ör. yalnızca ilgili modül) ya da çalışma kopyasını düzeltip tekrar dene.",
          secenekler(["komut_degistir", "tekrar_dene", "durdur"], "komut_degistir"), kuyruk(cikti, 3000));
      }
    }
    return "ok";
  }

  private yamaOzeti(fid: string): YamaOzeti | null {
    return jsonOku<YamaOzeti | null>(path.join(this.calisma, fid, ".kovan", "yama.json"), null);
  }

  /** Dokunulmamış kopya ile çalışma kopyasının farkını cikti/ altına yazar: yama, yamaya girmeyen dosyalar, OKU ve değişiklik notu. */
  private yamaCikar(fid: string, sessiz = false): void {
    const f = this.depo.fikir(fid);
    if (!f?.proje) return;
    const d = path.join(this.calisma, fid);
    const cikti = path.join(d, "cikti");
    const y = yamaYaz(this.projeAsilYolu(fid), path.join(d, "kod", PROJE_KLASORU), cikti);
    fs.writeFileSync(path.join(cikti, "OKU.md"), yamaOkuBeni(y, f.proje.yol), "utf8");
    const not = path.join(d, "belgeler", "degisiklik-notu.md");
    if (fs.existsSync(not)) fs.copyFileSync(not, path.join(cikti, "degisiklik-notu.md"));
    atomikYaz(path.join(d, ".kovan", "yama.json"), JSON.stringify({ dosya: `cikti/${YAMA_DOSYASI}`, dosyalar: y.dosyalar } satisfies YamaOzeti, null, 2));
    if (sessiz) return;
    const ayri = y.dosyalar.filter((x) => x.ayri).length;
    this.sistemAdimi(fid, null, "Yama", "tamam", y.dosyalar.length
      ? `${y.dosyalar.length} dosya: cikti/${YAMA_DOSYASI}` + (ayri ? `; ${ayri} dosya yamaya girmedi (cikti/dosyalar/)` : "")
      : "Projede değişiklik yok; yama boş.");
  }

  /** "kalemler" girdisi: her kalemin kapsamı ve kalem aşamalarının çıktıları (yazılımcı notları, test özetleri). */
  private kalemlerBelgesi(fid: string): string {
    const f = this.depo.fikir(fid);
    const plan = this.planOku(fid);
    if (!f || !plan) return "";
    const asamalar = this.asamalar(f);
    const p = ["# İş kalemleri", ""];
    for (const k of plan.kalemler) {
      p.push(`## ${k.id} ${k.baslik} (${this.kartlar.get(k.gelistirici)?.kisaltma ?? k.gelistirici})`, `Kapsam: ${k.kapsam}`, `Kabul: ${k.kabul.join(", ") || "-"}`);
      for (const a of asamalar.filter((x) => x.kalem?.id === k.id && x.cikti)) {
        const m = this.belgeDosyasi(fid, a.cikti!);
        if (m) p.push("", `### ${a.ad}`, kisalt(m, 1500));
      }
      p.push("");
    }
    return p.join("\n").trim();
  }

  private async tekrarOncesiBekle(motor: Motor, deneme: number): Promise<void> {
    if (deneme < this.cfg.deneme_sayisi && motor.tur !== "deneme") await bekle(3000);
  }

  private butceAsildi(fid: string): boolean {
    const f = this.depo.fikir(fid);
    return Boolean(f && f.butce_usd && f.maliyet_usd >= f.butce_usd);
  }

  private butceBeklemesi(fid: string, asama: Asama): "bekle" {
    const f = this.depo.fikir(fid)!;
    return this.bekleyeAl(fid, asama, "butce",
      `Fikir bütçesi doldu: $${f.maliyet_usd.toFixed(3)} / $${f.butce_usd.toFixed(2)}. Abonelikte bu tutar faturalanmaz ama kullanım limitinden yer; yükün göstergesidir.`,
      secenekler(["butce_artir", "durdur"], "butce_artir"));
  }

  private durdurUygula(fid: string): void {
    this.durdurIstekleri.delete(fid);
    const f = this.depo.fikir(fid);
    if (!f || f.durum === "durduruldu") return;
    this.depo.fikirGuncelle(fid, { durum: "durduruldu", bitis: simdi() });
    this.sistemAdimi(fid, null, "Durduruldu", "durduruldu", "Senin isteğinle durduruldu.");
  }

  private surecKaydedici(fid: string) {
    return (p: import("node:child_process").ChildProcess, bitti: boolean) => {
      const kume = this.surecler.get(fid) ?? new Set();
      if (bitti) kume.delete(p); else kume.add(p);
      this.surecler.set(fid, kume);
    };
  }

  calisanSurecSayisi(fid: string): number {
    return this.surecler.get(fid)?.size ?? 0;
  }

  /** Kapanışta çalışan ajan ve test süreçlerini (süreç grubuyla) kapatır; yarım kalan iş açılışta sana sorulur. */
  async kapat(): Promise<void> {
    const hepsi = [...this.surecler.values()].flatMap((k) => [...k]);
    for (const p of hepsi) if (p.pid && p.exitCode === null) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* bitmiş */ } }
    const t0 = Date.now();
    while (hepsi.some((p) => p.exitCode === null && p.signalCode === null) && Date.now() - t0 < 2000) await bekle(50);
    for (const p of hepsi) if (p.pid && p.exitCode === null && p.signalCode === null) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* bitmiş */ } }
  }

  private sistemAdimi(fid: string, asama: Asama | null, baslik: string, durum: string, ozet: string, kapat = true): number {
    const f = this.depo.fikir(fid);
    const id = this.depo.adimEkle({ fikir_id: fid, asama_id: asama?.id ?? "-", asama_ad: asama?.ad ?? "-", tip: "sistem", ajan: "-", ajan_ad: baslik, tur: f?.tur ?? 1, deneme: 1, durum, ozet: kisalt(ozet, 300), motor: "sistem", model: null });
    if (kapat) this.depo.adimGuncelle(fid, id, { bitis: simdi(), sure_sn: 0 });
    return id;
  }

  private adimKapat(fid: string, adim: number, durum: string, s: AjanSonucu | null, ozet: string, dosya = ""): void {
    const alanlar: Partial<Adim> = { durum, bitis: simdi(), ozet: kisalt(ozet ?? "", 300), dosya };
    if (s) Object.assign(alanlar, { sure_sn: Math.round(s.sure_sn * 10) / 10, maliyet_usd: Math.round(s.maliyet * 10_000) / 10_000, girdi_token: s.girdi_token, cikti_token: s.cikti_token, ajan_turu: s.tur_sayisi });
    this.depo.adimGuncelle(fid, adim, alanlar);
    if (s?.izin_retleri.length) {
      const a = this.depo.adim(fid, adim)!;
      this.sistemAdimi(fid, { ...bosAsama(a.asama_id, a.asama_ad) }, "İzin reddi", "uyari",
        `${a.ajan_ad} izinsiz ${s.izin_retleri.length} çağrı denedi, sistem reddetti: ${s.izin_retleri.slice(0, 5).join(", ")}`);
    }
  }

  private belgeOku(fid: string, anahtar: string | null): string {
    if (!anahtar) return "";
    if (anahtar === "kalemler") return this.kalemlerBelgesi(fid);
    return this.belgeDosyasi(fid, anahtar);
  }

  private belgeDosyasi(fid: string, anahtar: string): string {
    const p = path.join(this.calisma, fid, "belgeler", `${anahtar}.md`);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
  }

  private belgeKaydet(fid: string, anahtar: string, metin: string, adim: number): string {
    const d = path.join(this.calisma, fid, "belgeler");
    fs.mkdirSync(path.join(d, "_surumler"), { recursive: true });
    const icerik = metin.trimEnd() + "\n";
    fs.writeFileSync(path.join(d, `${anahtar}.md`), icerik, "utf8");
    fs.writeFileSync(path.join(d, "_surumler", `${anahtar}-adim${adim}.md`), icerik, "utf8");
    return `belgeler/_surumler/${anahtar}-adim${adim}.md`;
  }

  private incelemeKaydet(fid: string, asama: Asama, v: Dogrulayici, kart: AjanKarti, tur: number, adim: number,
    karar: { karar: string; gerekce: string; bulgular: string[] }): string {
    const rel = `incelemeler/${asama.id}-tur${tur}-${kart.id}-adim${adim}.md`;
    const satirlar = [`# ${v.ad}: ${asama.ad}, tur ${tur}`, "", `İnceleyen: ${kart.ad}`, `Karar: **${karar.karar}**`, "", `Gerekçe: ${karar.gerekce}`, "", "## Bulgular",
      ...(karar.bulgular.length ? karar.bulgular.map((b) => `- ${b}`) : ["- (yok)"])];
    fs.writeFileSync(path.join(this.calisma, fid, rel), satirlar.join("\n") + "\n", "utf8");
    return rel;
  }

  private gunlukYaz(fid: string, adim: number, motor: Motor, c: AjanCagrisi, s: AjanSonucu): string {
    const rel = `gunluk/adim-${adim}.json`;
    const veri: Record<string, unknown> = {
      adim, motor: motor.ad, rol: c.rol, asama: c.asama_id, gorev_turu: c.gorev_turu, model: c.model, araclar: c.araclar,
      izinli: c.izinli, cwd: c.cwd, sure_siniri_sn: c.sure_sn, sistem: c.sistem, istem: c.istem,
      sonuc: { ok: s.ok, hata: s.hata, zaman_asimi: s.zaman_asimi, maliyet_usd: s.maliyet, girdi_token: s.girdi_token, cikti_token: s.cikti_token,
        tur_sayisi: s.tur_sayisi, sure_sn: Math.round(s.sure_sn * 100) / 100, metin: s.metin.slice(0, 20_000), yapisal: s.yapisal,
        izin_retleri: s.izin_retleri, ham: s.ham },
    };
    if (motor.komut) {
      try { veri.komut = motor.komut(c).map((x) => (x.length < 200 ? x : x.slice(0, 80) + " …")); } catch { /* yok say */ }
    }
    fs.writeFileSync(path.join(this.calisma, fid, rel), JSON.stringify(veri, null, 2), "utf8");
    return rel;
  }

  /** kod/ altındaki ajan dosyaları (Kovan'ın koyduğu kök package.json hariç). */
  private kodDosyalari(fid: string): string[] {
    return this.agac(path.join(this.calisma, fid, "kod"), [KAYNAK_KLASORU]).filter((r) => !path.basename(r).startsWith(".") && r !== "package.json");
  }

  private teslimOzeti(fid: string): string | null {
    const adimlar = this.depo.adimlar(fid);
    const satirlar: string[] = [];
    const plan = this.planOku(fid);
    if (plan) { satirlar.push("İş kalemleri:"); for (const k of plan.kalemler) satirlar.push(`  ${k.id} ${k.baslik}`); }
    const kararlar = this.kararlar(fid);
    const ekip = kararlar.filter((k) => k.karar_veren === "ekip");
    const insan = kararlar.filter((k) => k.karar_veren !== "ekip");
    if (ekip.length) { satirlar.push("Ekibin kendi aldığı kararlar:"); for (const k of ekip) satirlar.push(`  ${k.baslik}: ${k.cevap}`); }
    if (insan.length) { satirlar.push("Senin kararların:"); for (const k of insan) satirlar.push(`  ${k.baslik}: ${k.cevap}`); }
    const testler = new Map<string, string>();
    for (const s of adimlar) if (s.tip === "kontrol") testler.set(s.ajan_ad, s.ozet);
    if (testler.size) { satirlar.push("Son denetimler:"); for (const [ad, oz] of testler) satirlar.push(`  ${ad}: ${oz}`); }
    const notlar = new Map<string, string>();
    for (const s of adimlar) if (s.tip === "inceleme" && (s.durum === "onay" || s.durum === "duzelt")) notlar.set(s.ajan_ad, s.ozet);
    if (notlar.size) { satirlar.push("Onay kurulunun son notları:"); for (const [ad, oz] of notlar) satirlar.push(`  ${ad}: ${oz}`); }
    const yama = this.yamaOzeti(fid);
    const dosyalar = yama ? [] : this.kodDosyalari(fid);
    if (yama) {
      const etiket = { eklendi: "eklendi", silindi: "silindi", degisti: "değişti" };
      satirlar.push(`Yama (${yama.dosya}): ` + (yama.dosyalar.slice(0, 30).map((x) => `${x.yol} (${etiket[x.durum]})`).join(", ") || "değişiklik yok") + (yama.dosyalar.length > 30 ? " …" : ""));
    }
    if (dosyalar.length) satirlar.push("Kod dosyaları: " + dosyalar.slice(0, 30).join(", ") + (dosyalar.length > 30 ? " …" : ""));
    return satirlar.join("\n") || null;
  }

  /** Tarayıcıda açılabilecek çıktılar: UX prototipi, frontend build'i (yoksa statik index.html). */
  private onizlemeler(fid: string): { ad: string; yol: string }[] {
    const kod = path.join(this.calisma, fid, "kod");
    const var_ = (rel: string) => fs.existsSync(path.join(kod, rel));
    const liste: { ad: string; yol: string }[] = [];
    if (var_("tasarim/prototip.html")) liste.push({ ad: "UX prototipi", yol: "kod/tasarim/prototip.html" });
    if (var_("frontend/dist/index.html")) liste.push({ ad: "Frontend (build)", yol: "kod/frontend/dist/index.html" });
    else if (var_("frontend/index.html") && !/src=["']\/?src\//.test(fs.readFileSync(path.join(kod, "frontend/index.html"), "utf8")))
      liste.push({ ad: "Frontend", yol: "kod/frontend/index.html" });
    return liste;
  }

  private dosyaListesi(fid: string) {
    const d = path.join(this.calisma, fid);
    const listele = (alt: string) => this.agac(path.join(d, alt))
      .filter((r) => !r.split("/").includes("_surumler") && !path.basename(r).startsWith("."))
      .map((r) => {
        const yol = `${alt}/${r}`;
        let boyut = 0;
        try { boyut = fs.statSync(path.join(d, yol)).size; } catch { /* yok */ }
        return { yol, boyut };
      });
    const kod = listele("kod").filter((x) => x.yol !== "kod/package.json");
    const kaynakOnek = `kod/${KAYNAK_KLASORU}/`;
    const projeOnek = this.depo.fikir(fid)?.proje ? `kod/${PROJE_KLASORU}/` : null;
    const projede = (yol: string) => projeOnek !== null && yol.startsWith(projeOnek);
    return {
      belgeler: listele("belgeler"), incelemeler: listele("incelemeler"),
      kod: kod.filter((x) => !x.yol.startsWith(kaynakOnek) && !projede(x.yol)), kaynak: kod.filter((x) => x.yol.startsWith(kaynakOnek)),
      proje: kod.filter((x) => projede(x.yol)), cikti: listele("cikti"),
    };
  }
}

interface IncelemeSonucu {
  tur: "ok" | "soru" | "hata" | "dur";
  karar?: { karar: string; gerekce: string; bulgular: string[] };
  kapsam_disi?: boolean;
  sorular?: HamSoru[];
  mesaj?: string;
}
