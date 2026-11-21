# taksit-hesap (uydurma örnek)

Kovan'ın **Mevcut proje üzerinde iş** akışını denemek için küçük, bağımlılıksız bir Node projesi. Gerçek bir sistemle ilgisi yoktur.

- `src/taksit.mjs`: bir tutarı eşit taksitlere böler (kuruş cinsinden tam sayılarla).
- `src/vade.mjs`: taksitlerin vade tarihlerini üretir.
- `test/`: mevcut testler. `npm test` ile koşar (Node'un kendi test koşucusu).

## Bilinen hata (deneme için bilerek bırakıldı)

Tutar taksit sayısına tam bölünmüyorsa kalan kuruş kaybolur: 100,00 TL 3 taksitte 33,33 + 33,33 + 33,33 = 99,99 TL eder. Mevcut testler yalnızca tam bölünen tutarları sınadığı için yeşildir.

Kovan'da denemek için: Yeni fikir → Mevcut proje üzerinde iş → bu klasörü ver → isteğe hatayı yaz.
