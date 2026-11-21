// Taksit planı: tutarlar kuruş cinsinden tam sayıdır (kayan nokta hatası olmasın diye).

/**
 * Toplam tutarı eşit taksitlere böler.
 * @param {number} toplamKurus toplam tutar, kuruş
 * @param {number} adet taksit sayısı (1-36)
 * @returns {number[]} taksit tutarları, kuruş
 */
export function taksitPlani(toplamKurus, adet) {
  if (!Number.isInteger(toplamKurus) || toplamKurus <= 0) throw new RangeError("Tutar pozitif bir tam sayı (kuruş) olmalı");
  if (!Number.isInteger(adet) || adet < 1 || adet > 36) throw new RangeError("Taksit sayısı 1 ile 36 arasında olmalı");
  const taksit = Math.floor(toplamKurus / adet);
  return Array.from({ length: adet }, () => taksit);
}
