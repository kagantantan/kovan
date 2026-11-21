# Kovan arayüzü: tasarım notları

Konu: kişisel bir ajan takımının yönetim ekranı. Kim kullanır: takımın sahibi, tek kişi, her gün, kendi Mac'inde tarayıcıdan.
Birincil iş: hangi fikrin nerede olduğunu görmek ve ajanların getirdiği kararları bağlamıyla, hızlıca vermek.

## Renk
| Ad | Açık | Koyu | Rol |
|---|---|---|---|
| duman | #EDF0EC | #181513 | sayfa zemini (arıcının körüğünden çıkan duman grisi, hafif yeşil) |
| petek | #FBFCFA | #221C18 | yüzeyler |
| propolis | #2E231C | #EFE8E1 | metin ve birincil düğme (siyah değil, koyu reçine kahvesi) |
| bal | #E3A43A | #EDB458 | yalnızca "seni bekliyor" ve çalışan hücrenin dolgusu |
| yosun | #3F7A4C | #7DB68A | onay, yeşil test |
| pas | #B24A2E | #E2806A | düzelt, kırmızı test, hata |
| motor | Claude #6656A8, yerel #2B7A83 | | hangi ajan hangi motorda (hibrit yapının kendisi) |

## Yazı
- Recursive (değişken): arayüz metni Linear (CASL 0), başlıklar yarı el yazısı (CASL 0.6), kod ve günlük MONO 1. Tek aile, üç ses.
- Literata (değişken, opsz): ajanların yazdığı belgeler. Belge gibi okunsun, satır en fazla ~70 karakter.
- Ölçek: 12 / 13 / 15 / 18 / 21 / 28. Para ve süre tabular-nums, mono değil.

## Yerleşim
```
┌ Kovan  Fikirler Ajanlar Akışlar ─────────────── Claude ● yerel ○  Bildirim ┐
│ + Yeni fikir │ Başlık                                        Durdur        │
│ fikir satırı │ akış, mod, aşama, süre, bütçe çizgisi                       │
│ fikir satırı │         ◉  ← Büyük Birader'in gözü (şeridin tepesinde)       │
│ fikir satırı │ ⬡⬡⬢⬡⬡⬡⬡  ← petek şeridi (imza öğe)                         │
│ ...          │ ┌ karar yuvası (bal kenarlı, tek yükseltilmiş öğe) ┐         │
│              │ └──────────────────────────────────────────────────┘         │
│              │ zaman çizelgesi (aşamaya göre)  │ belgeler / incelemeler / kod│
└──────────────┴──────────────────────────────────┴───────────────────────────┘
```
Sola hizalı. Geniş ekranda alt bölüm ekran yüksekliğini doldurur, iki sütun kendi içinde kayar; dar ekranda her şey alt alta.

## İlkeler
1. Cesaret tek yerde: petek şeridi. Aşamalar birbirine yapışık altıgen hücreler; çalışan hücre balla dolar, onaylanan hücre mumla sırlanır (kilit = sırlama). Gerisi sakin.
   Şeridin tepesinde Büyük Birader'in gözü durur: ortada, büyük, tek başına. Rengi son hükmüdür (yosun: uygun, bal: dikkat, pas: veto), bakışı o anki aşamaya döner, değerlendirme yaparken kırpar. Şeridin parçasıdır; ikinci bir "cesur" öğe değildir.
2. Karar birinci sınıf: karar yuvası petekle zaman çizelgesi arasında, katlanmanın üstünde. Seçenekler açıklamalı, önerilen ilk sırada, kendi cevabını yazmak her zaman mümkün.
3. Kimin yaptığı görünür: her adımda ajan ve motor (Claude ya da yerel). Hibrit yapı ürünün kendisi.
4. Belgeler belge gibi (serif), günlükler günlük gibi (mono).

## Kaçınılanlar (bilerek)
Krem zemin, tek renk vurgulu siyah zemin, her şeyi aynı kart yapan SaaS kiti, BÜYÜK HARF etiketler, "A · B · C" meta dizileri, düğmelerde ok, sayfa açılışında kayarak gelen bölümler.
Hareket yalnızca çalışan hücrenin bal seviyesinde; azaltılmış hareket tercihinde durur.
