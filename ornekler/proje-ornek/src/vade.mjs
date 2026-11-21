// Vade tarihleri: ilk taksit verilen tarihte, sonrakiler birer ay arayla.

/**
 * @param {string} ilkVade YYYY-AA-GG
 * @param {number} adet taksit sayısı
 * @returns {string[]} vade tarihleri, YYYY-AA-GG
 */
export function vadeTarihleri(ilkVade, adet) {
  const [yil, ay, gun] = ilkVade.split("-").map(Number);
  return Array.from({ length: adet }, (_, i) => {
    const hedefAy = ay - 1 + i;
    const sonGun = new Date(Date.UTC(yil, hedefAy + 1, 0)).getUTCDate();   // ayın son günü: 31 Ocak'tan sonra 28/29 Şubat
    return new Date(Date.UTC(yil, hedefAy, Math.min(gun, sonGun))).toISOString().slice(0, 10);
  });
}
