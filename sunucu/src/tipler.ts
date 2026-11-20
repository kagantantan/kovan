// Sunucu ile arayüzün paylaştığı tipler. Bu dosya hiçbir şey import etmez: tarayıcı tarafı da kullanır.

export type Mod = "hibrit" | "claude" | "deneme" | "yerel";
export type FikirDurumu = "sirada" | "calisiyor" | "bekliyor" | "tamamlandi" | "durduruldu";
export type BeklemeSebebi = "insan" | "tur_siniri" | "hata" | "butce" | "kesildi" | "ajan_sorusu";
/** Sorunun nereden geldiği: üreten ajan, onaycı ya da Ürün Sahibi'nin gelişim önerileri. */
export type BeklemeKaynagi = "uret" | "inceleme" | "gelisim";
export type AsamaTuru = "ajan" | "insan" | "kalemler" | "gelisim";

/** Sistem kararlarında bir seçenek (arayüzde kart olarak görünür). */
export interface Secenek {
  anahtar: string;
  etiket: string;
  aciklama: string;
  onerilen?: boolean;
  tehlikeli?: boolean;
}

export interface SoruSecenegi {
  etiket: string;
  aciklama: string;
}

/** Ortak kararda bir ajanın oyu. */
export interface Oy {
  ajan: string;         // kart id
  ajan_ad: string;
  kisa: string;         // kısaltma (PO, TKM...)
  secim: string[];      // seçtiği seçeneklerin etiketleri; insana bıraktıysa boş
  insana: boolean;      // "bu karar projenin sahibinin"
  gerekce: string;
  soran?: boolean;      // soruyu soran ajan (oyu kendi önerisidir)
}

/** Ajanın sorduğu çoktan seçmeli soru. Önce ekip oylar; anlaşamazsa insana gelir. */
/** is_kurali: doküman-kod çelişkisi, hesap, tarih, kapsam, hata davranışı, mevzuat yorumu; teknik: uygulama ve teknoloji tercihi. */
export type SoruKonusu = "is_kurali" | "teknik";

export interface AjanSorusu {
  baslik: string;
  soru: string;
  coklu: boolean;
  secenekler: SoruSecenegi[];
  soran: string;        // ajan kart id
  soran_ad: string;
  insan?: boolean;      // soran ajana göre bu kararı yalnızca projenin sahibi verebilir
  konu?: SoruKonusu;    // is_kurali_sana aşamalarında yönlendirme için
  oylar?: Oy[];         // ekip oyladıysa: kim neyi seçti
  neden?: string;       // neden sana geldi
  oneri_id?: string;    // gelişim önerisi (kaynak: gelisim)
}

export interface Bekleme {
  sebep: BeklemeSebebi;
  asama_id: string | null;
  asama_ad: string | null;
  mesaj: string;
  secenekler: Secenek[];
  sorular?: AjanSorusu[];
  kaynak?: BeklemeKaynagi;
  bekleyen_geri_bildirim?: string | null;   // onaycı sorusunda: cevaptan sonra üreticiye gidecek bulgular
  ekip_kararlari?: Karar[];                 // aynı soru turunda ekibin kendisinin karar verdiği sorular
  detay: string | null;
  adim_id: number;
  zaman: string;
  geri_hedefler?: { id: string; ad: string }[];
  varsayilan_hedef?: string | null;
}

export interface KaynakBilgisi {
  yollar: string[];      // senin makinendeki asıl yollar
  dosya_sayisi: number;
  satir: number;
  boyut: number;
  donusturulen: number;  // HTML'e çevrilen Word belgeleri
  atlanan: number;
}

export interface Fikir {
  id: string;
  baslik: string;
  metin: string;
  profil: string;
  motor: Mod;
  durum: FikirDurumu;
  asama_idx: number;
  tur: number;
  faz: "uret" | "dogrula";
  ek_tur: number;
  soru_turu: number;
  onaylayanlar?: string[];   // bu aşama döngüsünde ONAY veren onaycılar (kart id); revizyon turunda yeniden bakmaz
  geri_bildirim: string | null;
  bekleme: Bekleme | null;
  butce_usd: number;
  maliyet_usd: number;
  girdi_token: number;
  cikti_token: number;
  istisnalar: Record<string, string>;
  surum?: number;                 // 1, 2, ...: gelişim önerileriyle başlatılan her yeni sürüm bir artar
  temel_fikir?: string | null;    // önceki sürümün fikir id'si
  sonraki_surum?: string | null;  // bu fikirden başlatılan yeni sürüm
  kapsam_disi?: string[];         // "bu fikirde alanıma giren konu yok" diyen onaycılar (ör. mevzuat)
  kaynak?: KaynakBilgisi | null;   // replatform: mevcut sistemin kodu ve dokümanları (kod/kaynak/)
  hedef_yigin?: string | null;     // yeni kodun teknolojisi (karar defterine de yazılır)
  olusturma: string;
  guncelleme: string;
  baslama: string | null;
  bitis: string | null;
}

export type AdimTipi = "uret" | "inceleme" | "kontrol" | "sistem" | "oy";

export interface Adim {
  id: number;
  fikir_id: string;
  asama_id: string;
  asama_ad: string;
  tip: AdimTipi;
  ajan: string;
  ajan_ad: string;
  tur: number;
  deneme: number;
  durum: string;
  basla: string;
  bitis: string | null;
  sure_sn: number | null;
  maliyet_usd: number;
  girdi_token: number;
  cikti_token: number;
  ajan_turu: number;
  ozet: string;
  dosya: string;
  motor: string | null;
  model: string | null;
}

/** Karar defterindeki bir kayıt: ajanın sorusu ve kararı ekibin mi senin mi verdiği. */
export interface Karar {
  zaman: string;
  asama_id: string | null;
  asama_ad: string | null;
  soran: string;
  baslik: string;
  soru: string;
  cevap: string;
  karar_veren?: "insan" | "ekip";   // eski kayıtlarda yok: insan
  kural?: "oybirligi" | "cogunluk";
  oylar?: Oy[];
}

/** Teslim planındaki bir iş kalemi (Proje Yöneticisi'nin kovan-plan bloğundan). */
export interface PlanKalemi {
  id: string;            // P1, P2...
  baslik: string;
  gelistirici: string;   // kart id: be-yazilimci, fe-yazilimci
  bagimli: string[];
  kabul: string[];       // karşıladığı kabul kriterleri (K1...)
  kapsam: string;
}

export interface PlanKalemiGorunumu extends PlanKalemi {
  gelistirici_ad: string;
  gelistirici_kisa: string;
  durum: "tamam" | "aktif" | "bekliyor" | "sirada";
  asamalar: string[];    // bu kalemin aşama id'leri
}

/** Ürün Sahibi'nin teslimden sonra getirdiği gelişim önerisi. */
export interface GelisimOnerisi {
  id: string;            // G1, G2...
  baslik: string;
  aciklama: string;
  deger: string;         // kullanıcıya ne kazandırır
  efor: string;          // S, M, L
  oncelik: string;       // yuksek, orta, dusuk
}

/** Mimari karar kaydı (ADR): Mimar teknik planda ```kovan-adr bloğuyla yazar; onaydan sonra kod/adr/ altına dosya olarak çıkar. */
export interface AdrSecenegi {
  ad: string;
  arti: string;
  eksi: string;
}

export interface Adr {
  id: string;            // ADR-1, ADR-2...
  baslik: string;
  alan: string;          // calisma_bicimi, veri, performans, hata, guvenlik, entegrasyon, test, diger
  baglam: string;
  secenekler: AdrSecenegi[];
  karar: string;         // seçilen seçeneğin adı
  gerekce: string;
  sonuclar: string;
  kurallar: string[];    // ilgili kurallar ve kalemler (E3, P2...)
}

export type GelisimKarari = "al" | "degistir" | "simdilik_hayir" | "asla";

/** Gelişim defteri: önerilere senin kararların. Sonraki sürümlerde PO bunlara bakar. */
export interface GelisimKaydi extends GelisimOnerisi {
  karar: GelisimKarari;
  not: string;
  zaman: string;
  surum: number;
  fikir_id: string;
}

export interface Cevap {
  secilenler: string[];
  serbest?: string;
}

// ------------------------------------ API yanıtları ------------------------------------

export interface FikirOzeti {
  id: string;
  baslik: string;
  durum: FikirDurumu;
  profil: string;
  akis_ad: string;
  motor: Mod;
  maliyet_usd: number;
  butce_usd: number;
  olusturma: string;
  guncelleme: string;
  asama_ad: string;
  asama_no: number;
  asama_sayisi: number;
  bekleme_sebebi: BeklemeSebebi | null;
}

export interface OnayRozeti {
  ad: string;
  kisa: string;
  durum: string | null;
}

export type AsamaDurumu = "tamam" | "atlandi" | "bekliyor" | "aktif" | "sirada" | "durdu" | "bekleyen";

export interface AsamaGorunumu {
  id: string;
  ad: string;
  tur: AsamaTuru;
  kalem: string | null;          // iş kalemi aşamasıysa kalem kimliği (P1)
  kalem_baslik: string | null;
  durum: AsamaDurumu;
  ajan: string;        // kısaltma
  ajan_ad: string;
  motor: string | null;
  yazabilir: string[];
  kilitle: string[];
  en_fazla_tur: number;
  onaylar: OnayRozeti[];
}

export interface DosyaBilgisi {
  yol: string;
  boyut: number;
}

export interface FikirDetayi {
  fikir: Fikir;
  klasor: string;        // fikrin bu makinedeki klasörü: belgeler/, kod/ (ürün), incelemeler/
  akis_ad: string;
  asamalar: AsamaGorunumu[];
  adimlar: Adim[];
  bekleme: Bekleme | null;
  kararlar: Karar[];
  plan: PlanKalemiGorunumu[] | null;
  gelisim: GelisimKaydi[];
  adrler: Adr[];
  sonraki_surum_metni: string | null;   // kabul edilen gelişim önerileri varsa yeni sürümün tohum metni
  dosyalar: { belgeler: DosyaBilgisi[]; incelemeler: DosyaBilgisi[]; kod: DosyaBilgisi[]; kaynak: DosyaBilgisi[] };
  onizlemeler: { ad: string; yol: string }[];
  aktif_sure_sn: number;
  ajan_cagrisi: number;
  motor_cagrilari: Record<string, number>;
}

export interface DosyaIcerigi {
  yol: string;
  icerik: string;
  kesildi: boolean;
  boyut: number;
}

export interface MotorDurumu {
  hazir: boolean;
  surum: string;
  hata: string | null;
  yol: string | null;
  tur: string;
  yerel: boolean;
  model: string | null;
  adres?: string;
  ollama_surum?: string | null;
  /** OpenAI uyumlu motor: anahtar nereden geliyor. Anahtarın kendisi hiçbir yanıtta yok. */
  anahtar_kaynagi?: AnahtarKaynagi | null;
  anahtar_basligi?: string;
  /** İşletim sisteminin kasası (ör. "macOS Anahtar Zinciri"); yoksa null. */
  kasa?: string | null;
}

/** Ayarlar ekranındaki kaydet, dene ve sil işlemlerinin yanıtı. */
export interface BaglantiSonucu extends MotorDurumu {
  modeller: string[];
}

/** ekran: Ayarlar ekranından girildi (bellekte); kasa: işletim sisteminin kasası; dosya: anahtar_dosyasi; degisken: anahtar_degiskeni. */
export type AnahtarKaynagi = "ekran" | "kasa" | "dosya" | "degisken";

export interface HedefYigin {
  id: string;
  ad: string;
  aciklama: string;   // ajanlara bağlayıcı karar olarak giden metin
}

export interface DurumYaniti {
  surum: string;
  varsayilan_motor: Mod;
  calisma: string;
  paralel_fikir: number;
  paralel_inceleme: boolean;
  claude_inceleme_modeli: string | null;
  ajan_sorulari: boolean;
  en_fazla_soru_turu: number;
  ortak_karar: { acik: boolean; kurul: { id: string; ad: string; kisa: string }[]; kural: "oybirligi" | "cogunluk" };
  hedef_yiginlar: HedefYigin[];
  ornek_kaynak: string | null;  // Kovan'la gelen kurgusal eski sistem (ornekler/reeskont-eski), replatform örneği için
  yerel_motor: string | null;
  modlar: Mod[];                // bu kurulumda açık modlar
  dis_ayar: string | null;      // okunan dış ayar dosyası   // "Hepsi yerel" modunda bütün ajanların kullandığı motor
  motorlar: Record<string, MotorDurumu>;
}

export interface AjanOzeti {
  id: string;
  ad: string;
  kisaltma: string;
  motor: string;
  model: string;
  yerel_model: string | null;
  aciklama: string;
  araclar: string[];
  izinli_komutlar: string[];
  sure_dk: number;
  butce_usd: number | null;
  sistem_promptu: "degistir" | "ekle";
  sinirlar: string;
  govde: string;
  dosya: string;
  motor_modeli: string;
  motor_yerel: boolean;
  secim: { motor: string; model: string } | null;   // Ajanlar ekranından seçilen motor ve model
  uretir: string[];
  onaylar: string[];
}

export interface AkisAsamaOzeti {
  id: string;
  ad: string;
  tur: AsamaTuru;
  ajan: string | null;
  ajan_ad: string | null;
  ajan_kisa: string | null;
  girdiler: string[];
  cikti: string | null;
  salt_okunur: boolean;
  kilitle: string[];
  yazabilir: string[];
  en_fazla_tur: number;
  is_kurali_sana: boolean;
  once_soru: boolean;
  dogrulama: { ad: string; tip: "komut" | "ajan" | "plan" | "atif" | "adr"; komut: string | null; inceleyen: string | null; inceleyen_ad: string | null; atlanabilir: boolean; taraf: string | null; adr_zorunlu: string[] }[];
  kalem_adimlari: AkisAsamaOzeti[];   // tur: kalemler ise her kalem için tekrarlanan adımlar
}

export interface AkisOzeti {
  id: string;
  ad: string;
  aciklama: string;
  fikir_butcesi_usd: number;
  ortak_karar: boolean;
  kaynak: "zorunlu" | "yok";   // zorunlu: fikir mevcut sistemin kaynaklarıyla başlar (replatform)
  asamalar: AkisAsamaOzeti[];
}
