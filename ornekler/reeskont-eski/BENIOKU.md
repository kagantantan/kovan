# Örnek eski sistem: kart reeskont gün sonu (kurgusal)

Replatform akışını denemek için küçük, **kurgusal** bir eski sistem. Gerçek bir kurumun kodu ya da verisi değildir.

| Dosya | Ne |
|---|---|
| `KART_REESKONT_GUNSONU.pkb` | PL/SQL paket gövdesi: faiz işleyen kart bakiyeleri için günlük faiz tahakkuku, özet bakiye ve muhasebe fişi |
| `analiz.docx` | Eski sistemin analiz dokümanı (Word). Kovan bunu HTML'e çevirip ajanlara okutur |
| `ornek-veri/girdi.csv`, `ornek-veri/beklenen.csv` | Eski sistemin örnek girdisi ve çıktısı: eşdeğerlik (altın) testleri bunlardan yazılır |

Bilerek bırakılmış üç iz var; Mevcut Sistem Analisti'nin bulması beklenir:

1. **Doküman ile kod farkı:** doküman gün esasını 360 diyor, kod 365 kullanıyor.
2. **Yeniden çalıştırma:** aynı tarih iki kez çalışırsa hareketler ve fiş iki kez yazılır.
3. **Sabit değer:** muhasebe hesabı kodun içinde sabit.

Denemek için: **Yeni fikir → "Örnekle doldur: Kart reeskont gün sonu"** (akış Replatform, kaynak bu klasör) → Mod **Deneme**.
