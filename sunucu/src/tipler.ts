// Sunucu ile arayüzün paylaştığı tipler. Bu dosya hiçbir şey import etmez: tarayıcı tarafı da kullanır.

export type Mod = "hibrit" | "claude" | "deneme";
export type FikirDurumu = "sirada" | "calisiyor" | "bekliyor" | "tamamlandi" | "durduruldu";
export type BeklemeSebebi = "insan" | "tur_siniri" | "hata" | "butce" | "kesildi" | "ajan_sorusu";

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

/** Ajanın insana sorduğu çoktan seçmeli soru. */
export interface AjanSorusu {
  baslik: string;
  soru: string;
  coklu: boolean;
  secenekler: SoruSecenegi[];
  soran: string;        // ajan kart id
  soran_ad: string;
}

export interface Bekleme {
  sebep: BeklemeSebebi;
  asama_id: string | null;
  asama_ad: string | null;
  mesaj: string;
  secenekler: Secenek[];
  sorular?: AjanSorusu[];
  kaynak?: "uret" | "inceleme";
  bekleyen_geri_bildirim?: string | null;   // onaycı sorusunda: cevaptan sonra üreticiye gidecek bulgular
  detay: string | null;
  adim_id: number;
  zaman: string;
  geri_hedefler?: { id: string; ad: string }[];
  varsayilan_hedef?: string | null;
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
  geri_bildirim: string | null;
  bekleme: Bekleme | null;
  butce_usd: number;
  maliyet_usd: number;
  girdi_token: number;
  cikti_token: number;
  istisnalar: Record<string, string>;
  olusturma: string;
  guncelleme: string;
  baslama: string | null;
  bitis: string | null;
}

export type AdimTipi = "uret" | "inceleme" | "kontrol" | "sistem";

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

/** Karar defterindeki bir kayıt: ajanın sorusu ve senin cevabın. */
export interface Karar {
  zaman: string;
  asama_id: string | null;
  asama_ad: string | null;
  soran: string;
  baslik: string;
  soru: string;
  cevap: string;
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
  tur: "ajan" | "insan";
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
  akis_ad: string;
  asamalar: AsamaGorunumu[];
  adimlar: Adim[];
  bekleme: Bekleme | null;
  kararlar: Karar[];
  dosyalar: { belgeler: DosyaBilgisi[]; incelemeler: DosyaBilgisi[]; kod: DosyaBilgisi[] };
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
}

export interface DurumYaniti {
  surum: string;
  varsayilan_motor: Mod;
  calisma: string;
  paralel_fikir: number;
  paralel_inceleme: boolean;
  ajan_sorulari: boolean;
  en_fazla_soru_turu: number;
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
  uretir: string[];
  onaylar: string[];
}

export interface AkisAsamaOzeti {
  id: string;
  ad: string;
  tur: "ajan" | "insan";
  ajan: string | null;
  ajan_ad: string | null;
  ajan_kisa: string | null;
  girdiler: string[];
  cikti: string | null;
  kilitle: string[];
  yazabilir: string[];
  en_fazla_tur: number;
  dogrulama: { ad: string; tip: "komut" | "ajan"; komut: string | null; inceleyen: string | null; inceleyen_ad: string | null }[];
}

export interface AkisOzeti {
  id: string;
  ad: string;
  aciklama: string;
  fikir_butcesi_usd: number;
  asamalar: AkisAsamaOzeti[];
}
