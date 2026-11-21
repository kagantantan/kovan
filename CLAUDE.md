# Kovan: Claude Code için proje notları

Kovan, sınırları belli ajanlardan oluşan, tarayıcıdan yönetilen bir yazılım ekibi. Bir fikri, replatform edilecek mevcut bir sistemi ya da var olan bir projedeki işi (hata, özellik, entegrasyon), akış tanımındaki aşamalardan geçirir. Her aşamada bir ajan üretir, sınır denetimi ve testler koşar, onay kurulu (paralel ajanlar) onaylar ya da düzeltme ister; sonra Büyük Birader işin tamamına bakar (veto edebilir) ve kapı açıksa aşamanın kararları kullanıcının onayına gelir. Ekip bir soruda anlaşamazsa soru kullanıcıya gelir. Kullanıcı belgesi: `README.md`.

## Komutlar

- `npm install`: Node 20.19+ ya da 22.12+ gerekir
- `npm test`: Vitest. Gerçek `claude`'u ya da bir LLM'i çağırmaz
- `npx vitest run sunucu/test/kurum-llm.test.ts`: tek dosya
- `npm run typecheck`: sunucu ve arayüz
- `npm run build`: arayüzü `arayuz/dist`'e derler; `npm start` bunu sunar
- `npm start`: http://127.0.0.1:8765. `npm run deneme` token harcamaz
- `npm run gelistir`: Vite (5173), API isteklerini çalışan Kovan'a (8765) yönlendirir

Bir değişikliği bitmiş saymadan önce: `npm run typecheck && npm test && npm run build`.

## Yapı

| Yol | Ne |
|---|---|
| `sunucu/src/orkestrator.ts` | Durum makinesi: aşamalar, Üret → Doğrula döngüsü, onay kurulu, Büyük Birader (hüküm, veto), aşama sonu onay kapısı, ajanla konuşma, ortak karar (oylama), yazma alanı ve kilit denetimi, süre/bütçe/tur sınırları, kurtarma |
| `sunucu/src/motor.ts` | `Motor` arayüzü. `ClaudeMotoru` (`claude -p`, abonelik), `OllamaMotoru` (aynı CLI, yerel model), `DenemeMotoru` |
| `sunucu/src/uyumlu.ts` | OpenAI uyumlu motor (kurum içi LLM). Her ajan çağrısını `sunucu/src/ajan/kovan-ajan.ts` alt sürecinde çalıştırır |
| `sunucu/src/ajan/` | Kovan'ın kendi ajan döngüsü (`dongu.ts`) ve araçları (`araclar.ts`: Read, Write, Edit, MultiEdit, Glob, Grep, Bash) |
| `sunucu/src/kasa.ts` | API anahtarı için işletim sisteminin kasası (Ayarlar ekranındaki "kalıcı" kayıt) |
| `sunucu/src/ayarlar.ts` | `kovan.yaml` ve dış ayar dosyası (`--ayar`, `KOVAN_AYAR`) katmanları, doğrulama |
| `sunucu/src/kartlar.ts`, `akislar.ts` | Ajan kartları (`ajanlar/*.md`) ve akışlar (`akislar/*.yaml`) |
| `sunucu/src/kaynak.ts` | Replatform: kaynak içe alma, envanter, kod atıfları denetimi (mevcut projede ekler de buradan alınır) |
| `sunucu/src/proje.ts` | Mevcut proje üzerinde iş: projenin birebir kopyası (`kod/proje/`, `.kovan/proje-asil/`), test komutu önerisi, yama üretimi (`cikti/`) |
| `sunucu/src/plan.ts` | `kovan-plan`, `kovan-gelisim`, `kovan-adr`, `kovan-is` (öneri kartı) ve `kovan-ozet` (karar özeti) blokları, iş kalemi şablonu, `kosul` ve öneri kartı yer tutucuları |
| `sunucu/src/sunucu.ts`, `depo.ts`, `tipler.ts` | Fastify API, kayıtlar (`calisma/F-xxx/.kovan/`), sunucu ile arayüzün paylaştığı tipler |
| `arayuz/src/` | Vite + React arayüz. Tasarım notları: `arayuz/TASARIM.md` |
| `sunucu/test/` | Vitest. Ortak yardımcılar ve sahte `claude`: `sunucu/test/yardimci/` |
| `ornekler/` | `kurum-ayar.ornek.yaml` (dış ayar), `reeskont-eski/` (replatform için uydurma bir eski sistem), `proje-ornek/` (mevcut proje işi için uydurma, bilerek hatalı küçük proje; deneme motoru ve testler onu kullanır) |

## Kurallar

- **Dil:** tanımlayıcılar, yorumlar, arayüz metinleri, hata mesajları ve test adları Türkçe; mevcut stile uy. Standartlaşmış teknik terimler İngilizce kalır (tool calling, endpoint, streaming).
- **Repo herkese açık:** kişi, kurum ya da şirket adı, e-posta ya da iç adres yazma. Örneklerde `kurum`, `llm.kurum.local` gibi nötr adlar kullan.
- **Sırlar:** API anahtarı ayar dosyasına, repoya, günlüğe, isteme ya da `/api/durum`'a girmez. Ayarda yalnızca yeri durur (`anahtar_degiskeni` ya da `anahtar_dosyasi`); `ayarlar.ts` anahtarın kendisini reddeder. Anahtar alt sürece `KOVAN_LLM_ANAHTAR` ile geçer ve Bash'in ortamından silinir. Ayarlar ekranından girilen anahtar bellekte ya da işletim sisteminin kasasında (`sunucu/src/kasa.ts`: Anahtar Zinciri, Secret Service) durur; kasaya stdin'den yazılır. Testler kasaya dokunmaz (`kovanOlustur()` varsayılan `kasa: null`). Bunu koruyan testler var; gevşetme.
- **Ajan yetkisi kartta:** dış ayar yalnızca `motor`, `model`, `yerel_model`, `sure_dk`, `butce_usd`, `efor` değiştirir. Araçlar, izinler ve sistem promptu dışarıdan genişletilmez.
- **Sınırlar:** yazma alanı ve kilitli dosyalar orkestratörde denetlenir. Araçlarda yol hapsi (`..`, mutlak yol, sembolik bağ) ve Bash izin kalıpları (`Bash(npm test:*)`, `$( )` yasak) var. Bunları gevşeten bir değişiklikten önce sor.
- **Mevcut proje işi (`akislar/proje.yaml`):** verilen klasöre ve sürüm kontrolüne asla yazılmaz; çıktı yalnızca yamadır. Yazma alanı öneri kartından gelir ve kullanıcı onaylamadan yürürlüğe girmez (`.kovan/is.json`); yollar `isCikar`/`isDenetle` denetiminden geçer. Test komutunu kullanıcı onaylar; ajan çıktısından komut alınıp koşturulmaz. Sır taşıyabilecek dosyalar (`.env`, anahtar, sertifika) kopyalanmaz. Bunları gevşeten bir değişiklikten önce sor.
- **Büyük Birader ve konuşma salt okunur:** `ajanlar/buyuk-birader.md` yalnızca `Read, Glob, Grep` alır; konuşma (`sor`) çağrılarında ajan ne olursa olsun yazma ve Bash aracı verilmez. Veto kanıt ister (kanıtsız veto DİKKAT'e düşer), kullanıcının kararını veto edemez, aşama başına `en_fazla_veto` ile sınırlıdır ve hata verirse akışı kilitlemez. Kapıda onaylar karar defterine yazılmaz (yalnızca değişiklikler); kilit ve ADR yazımı kapı onayından sonradır (`asamaTamamla`). Bunları gevşeten bir değişiklikten önce sor.
- **Testlerde kapı ve Büyük Birader kapalı:** `kovanOlustur()` varsayılan `katilim: "sonda"` ve `buyuk_birader.acik: false` verir; açmak için `ayar` ile geç (`sunucu/test/kapi.test.ts`).
- **Testler ağa çıkmaz:** sahte `claude` (`sunucu/test/yardimci/sahte-claude.mjs`), sahte Ollama ve sahte OpenAI uyumlu sunucu kullan. Davranış değişikliği test ister.
- **Test ortamı:** `kovanOlustur()` varsayılan olarak dış ayarı kapatır (`dis_ayar: null`); geliştiricinin `KOVAN_AYAR`'ı testlere sızmasın.
- **Belge:** yeni bir ayar, motor ya da hata mesajı eklediğinde README'nin ilgili bölümünü ve Sorun giderme tablosunu güncelle.
- **Sürüm** `package.json`'da durur; arayüz ve `/api/durum` oradan okur.

## Durum (v0.8)

- Motorlar: Claude (abonelik), Ollama (yerel Qwen, hibrit mod), OpenAI uyumlu (kurum içi LLM), deneme.
- Başlangıçlar: sıfırdan (mini, standart, tam yığın), mevcut proje üzerinde iş (tek akış; küçük, orta, büyük yol öneri kartından), mevcut sistemi yeniden yaz (replatform).
- Onay kapıları (`katilim`: planlama, her_asama, sonda), Büyük Birader (her aşamada hüküm, veto) ve ajanla konuşma: yalnızca deneme motoruyla sınandı. Küçük yerel modelin (`qwen3:8b`) `kovan-ozet` bloğunu ve Büyük Birader'in JSON hükmünü tutarlı üretip üretmediği ölçülmedi.
- Modlar: hibrit, yerel, claude, deneme. Dış ayar `modlar` ile daraltabilir, `claude: false` ile Claude'u kapatabilir.
- Doğrulanmamış varsayım: hedef kurumun LLM servisi OpenAI uyumlu `/v1/chat/completions` sunuyor, tool calling açık, anahtar `Authorization: Bearer` başlığında. Gerçek servise karşı henüz denenmedi.
- Mevcut proje işi gerçek bir projeyle ve gerçek bir modelle henüz denenmedi (yalnızca deneme motoru ve `ornekler/proje-ornek`). Büyük projede her ajan çağrısından önceki anlık kopya (`onKopyaAl`) yavaş olabilir; ölçülmedi.
- Bilinen sınırlar: kurum LLM'ine istekler akışsız (streaming yok); Windows'ta Git Bash ya da WSL gerekir, denenmedi; kurum LLM'inde maliyet 0 görünür.
- Sıradaki adaylar: README sonundaki Yol haritası (sıfırdan başlangıçta da öneri kartı, yaşayan belgeler, Büyük Birader'in vetolarının isabet oranı); Kovan'ın kendi akışlarını Temporal üzerinde dayanıklı yürütmek (konuşuldu, başlanmadı, kapsamı netleştirilmeli).
