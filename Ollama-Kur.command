#!/bin/bash
# Kovan: Qwen hibrit kurulumu (macOS). Finder'da çift tıkla.
#   1. Bilgisayarını kontrol eder (macOS 14+, Apple Silicon, bellek)
#   2. Ollama yoksa resmî uygulamayı indirip Uygulamalar'a kurar
#   3. Bağlam uzunluğunu 64k yapar (kalıcı; Ollama'yı yeniden başlatır)
#   4. Belleğine uygun Qwen modelini indirir ve kovan.yaml'daki model satırını günceller
#   5. Kovan'ın kullandığı yolu (Anthropic uyumlu /v1/messages) gerçek bir istekle dener
# Tekrar çalıştırmak güvenlidir: kurulu olanı yeniden kurmaz.
# Ayarlar: KOVAN_MODEL=<model> ile model seçimini ezebilirsin.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

UYGULAMALAR="${KOVAN_UYGULAMALAR:-/Applications}"
ADRES="http://127.0.0.1:11434"
BAGLAM=65536
AJAN_ETIKETI="com.kovan.ollama-baglam"

renk() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
adim() { echo; renk "1;33" "▸ $1"; }
tamam() { renk "32" "  ✓ $1"; }
uyari() { renk "33" "  ! $1"; }
hata() { renk "31" "  ✗ $1"; }
bitir() {
  echo
  if [ -t 0 ]; then read -r -p "Kapatmak için Enter'a bas..." _; fi
  exit "${1:-0}"
}
api_hazir() { curl -fsS --max-time 3 "$ADRES/api/version" >/dev/null 2>&1; }

renk "1" "Kovan · Qwen hibrit kurulumu"
echo "Kodu yerel Qwen yazar, analiz ve onaylar Claude'da kalır. Bu betik yerel tarafı hazırlar."

# ------------------------------------------------------------------ 1. kontrol
adim "Bilgisayarın kontrol ediliyor"
if [ "$(uname -s)" != "Darwin" ]; then
  hata "Bu betik macOS içindir. Diğer sistemlerde README'deki 'Qwen hibrit kurulumu' adımlarını izle."
  bitir 1
fi
SURUM=$(sw_vers -productVersion)
if [ "${SURUM%%.*}" -lt 14 ]; then
  hata "macOS $SURUM: Ollama uygulaması macOS 14 (Sonoma) ya da sonrasını istiyor."
  bitir 1
fi
CIP=$(uname -m)
BELLEK_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
tamam "macOS $SURUM, $CIP, ${BELLEK_GB} GB bellek"
[ "$CIP" = "arm64" ] || uyari "Intel Mac: yerel model yalnızca işlemcide ve çok yavaş çalışır. 'Hepsi Claude' modunu öneririm."

if [ -n "${KOVAN_MODEL:-}" ]; then
  MODEL="$KOVAN_MODEL"
elif [ "$BELLEK_GB" -ge 32 ]; then
  MODEL="qwen3-coder:30b"      # MoE, ~19 GB; 32 GB'lık Mac'te 64k bağlamla rahat
elif [ "$BELLEK_GB" -ge 16 ]; then
  MODEL="qwen3.5:9b"           # ~7 GB; basit kalemlerde iş görür
  uyari "${BELLEK_GB} GB bellekte büyük model sığmaz; küçük modeli kuruyorum. Zor kalemlerde 'Claude'a devret' seçeneğini kullanırsın."
else
  hata "${BELLEK_GB} GB bellek yerel kodlama modeli için az. Kovan'ı 'Hepsi Claude' modunda kullan; kurulum gerekmez."
  bitir 1
fi
tamam "Model: $MODEL"
BOS_GB=$(df -g "$HOME" | awk 'NR==2 {print $4}')
if [ -n "$BOS_GB" ] && [ "$BOS_GB" -lt 25 ]; then
  uyari "Diskte ${BOS_GB} GB boş yer var; model ve Ollama için en az 25 GB önerilir."
fi

# ------------------------------------------------------------------ 2. Ollama
adim "Ollama"
OLLAMA=""
if [ -x "$UYGULAMALAR/Ollama.app/Contents/Resources/ollama" ]; then
  OLLAMA="$UYGULAMALAR/Ollama.app/Contents/Resources/ollama"
elif command -v ollama >/dev/null 2>&1; then
  OLLAMA=$(command -v ollama)
fi
if [ -z "$OLLAMA" ]; then
  echo "  Ollama kurulu değil; resmî uygulamayı indiriyorum..."
  GECICI=$(mktemp -d)
  if ! curl -fL --progress-bar -o "$GECICI/Ollama.dmg" "https://ollama.com/download/Ollama.dmg" &&
     ! curl -fL --progress-bar -o "$GECICI/Ollama.dmg" "https://github.com/ollama/ollama/releases/latest/download/Ollama.dmg"; then
    hata "İndirilemedi. İnternet bağlantını kontrol et ya da https://ollama.com/download adresinden elle kur, sonra bu betiği yeniden çalıştır."
    rm -rf "$GECICI"; bitir 1
  fi
  BAGLAMA=$(hdiutil attach -nobrowse -readonly "$GECICI/Ollama.dmg" | awk -F'\t' '/\/Volumes\// {print $NF; exit}')
  if [ -z "$BAGLAMA" ] || [ ! -d "$BAGLAMA/Ollama.app" ]; then
    hata "İndirilen disk görüntüsü açılamadı."
    [ -n "$BAGLAMA" ] && hdiutil detach -quiet "$BAGLAMA"
    rm -rf "$GECICI"; bitir 1
  fi
  if ! ditto "$BAGLAMA/Ollama.app" "$UYGULAMALAR/Ollama.app"; then
    hata "$UYGULAMALAR klasörüne kopyalanamadı. Disk görüntüsünü elle açıp Ollama'yı Uygulamalar'a sürükle."
    hdiutil detach -quiet "$BAGLAMA"; rm -rf "$GECICI"; bitir 1
  fi
  hdiutil detach -quiet "$BAGLAMA"
  rm -rf "$GECICI"
  OLLAMA="$UYGULAMALAR/Ollama.app/Contents/Resources/ollama"
  tamam "Ollama kuruldu: $UYGULAMALAR/Ollama.app"
  echo "  İlk açılışta Ollama 'ollama' komutunu terminale eklemek için izin isteyebilir; kabul etmen yeterli (Kovan için şart değil)."
else
  tamam "Ollama kurulu: $("$OLLAMA" --version 2>/dev/null | tail -1)"
fi

# ------------------------------------------------------------------ 3. bağlam uzunluğu
adim "Bağlam uzunluğu: 64k"
# macOS uygulaması kabuk ayarlarını (.zshrc) okumaz; değişken launchctl ile verilir.
launchctl setenv OLLAMA_CONTEXT_LENGTH "$BAGLAM"
AJAN_DOSYASI="$HOME/Library/LaunchAgents/$AJAN_ETIKETI.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$AJAN_DOSYASI" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AJAN_ETIKETI</string>
  <key>ProgramArguments</key>
  <array><string>/bin/launchctl</string><string>setenv</string><string>OLLAMA_CONTEXT_LENGTH</string><string>$BAGLAM</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$AJAN_ETIKETI" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$AJAN_DOSYASI" >/dev/null 2>&1 || launchctl load -w "$AJAN_DOSYASI" >/dev/null 2>&1 || true
tamam "OLLAMA_CONTEXT_LENGTH=$BAGLAM (yeniden başlatmalardan sonra da geçerli: $AJAN_DOSYASI)"

echo "  Ollama yeniden başlatılıyor (yeni ayarı okusun)..."
osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
pkill -f "Ollama.app/Contents/Resources/ollama serve" >/dev/null 2>&1 || true
sleep 2
if [ -d "$UYGULAMALAR/Ollama.app" ]; then
  open -a "$UYGULAMALAR/Ollama.app"
elif api_hazir; then
  uyari "Ollama uygulama olmadan (ör. Homebrew servisi) çalışıyor; yeniden başlatamadım. Servisi OLLAMA_CONTEXT_LENGTH=$BAGLAM ile yeniden başlat."
else
  ( OLLAMA_CONTEXT_LENGTH="$BAGLAM" nohup "$OLLAMA" serve >/dev/null 2>&1 & )
fi
for _ in $(seq 1 60); do api_hazir && break; sleep 1; done
if ! api_hazir; then
  hata "Ollama 60 saniyede açılmadı. Menü çubuğundaki Ollama simgesine bak, sonra bu betiği yeniden çalıştır."
  bitir 1
fi
tamam "Ollama çalışıyor: $(curl -fsS "$ADRES/api/version")"

# ------------------------------------------------------------------ 4. model
adim "Model: $MODEL"
if "$OLLAMA" list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$MODEL"; then
  tamam "Zaten indirilmiş"
else
  echo "  İndiriliyor (ilk sefer uzun sürer; bağlantına göre 10-40 dakika)..."
  if ! "$OLLAMA" pull "$MODEL"; then
    hata "Model indirilemedi. Bağlantını kontrol edip betiği yeniden çalıştır (kaldığı yerden devam eder)."
    bitir 1
  fi
  tamam "İndirildi"
fi

if [ -f kovan.yaml ]; then
  ESKI=$(awk '/^  qwen-yerel:/ {ic=1} ic && /^    model:/ {sub(/^    model:[ ]*/, ""); print; exit}' kovan.yaml)
  if [ "$ESKI" != "$MODEL" ]; then
    awk -v m="$MODEL" '/^  qwen-yerel:/ {ic=1} ic && /^    model:/ {print "    model: " m; ic=0; next} {print}' kovan.yaml > kovan.yaml.yeni &&
      mv kovan.yaml.yeni kovan.yaml
    tamam "kovan.yaml: qwen-yerel modeli '$ESKI' -> '$MODEL'"
  else
    tamam "kovan.yaml zaten bu modeli kullanıyor"
  fi
else
  uyari "kovan.yaml bulunamadı; betik Kovan klasöründe mi? Model satırını elle güncelle: motorlar > qwen-yerel > model: $MODEL"
fi

# ------------------------------------------------------------------ 5. deneme
adim "Deneme: Kovan'ın kullandığı yol (Anthropic uyumlu /v1/messages)"
echo "  Model belleğe yükleniyor; ilk cevap bir dakika sürebilir..."
CEVAP=$(curl -sS --max-time 300 "$ADRES/v1/messages" \
  -H "content-type: application/json" -H "x-api-key: ollama" -H "anthropic-version: 2023-06-01" \
  -d "{\"model\": \"$MODEL\", \"max_tokens\": 32, \"messages\": [{\"role\": \"user\", \"content\": \"Yalnızca TAMAM yaz.\"}]}" 2>&1)
if printf "%s" "$CEVAP" | grep -q '"content"'; then
  tamam "Model cevap verdi: $(printf "%s" "$CEVAP" | sed -n 's/.*"text":"\([^"]*\)".*/\1/p' | head -c 60)"
else
  hata "Beklenen cevap gelmedi: $(printf "%s" "$CEVAP" | head -c 300)"
  echo "  Ollama sürümü Anthropic uyumluluğu için 0.14 ya da sonrası olmalı. Menü çubuğundan Ollama'yı güncelle."
  bitir 1
fi
# Yüklü modelin gerçek bağlamı (yeni Ollama sürümleri /api/ps'te gösterir)
BAGLAM_SAYISI=$(curl -fsS --max-time 5 "$ADRES/api/ps" 2>/dev/null | sed -n 's/.*"context_length":\([0-9][0-9]*\).*/\1/p' | head -1)
if [ -n "$BAGLAM_SAYISI" ]; then
  if [ "$BAGLAM_SAYISI" -lt 60000 ]; then
    uyari "Yüklü modelin bağlamı $BAGLAM_SAYISI. Ollama > Settings > Context length'i 64k yap (uygulama ayarı ortam değişkenini ezebilir), sonra Ollama'yı yeniden başlat."
  else
    tamam "Yüklü modelin bağlamı: $BAGLAM_SAYISI"
  fi
fi

if command -v claude >/dev/null 2>&1; then
  tamam "Claude Code: $(claude --version 2>/dev/null | head -1)"
else
  uyari "Claude Code (claude komutu) bulunamadı. Kovan iki motor için de onu kullanır: https://docs.claude.com/en/docs/claude-code/overview"
fi

echo
renk "1;32" "Hazır."
echo "Şimdi Baslat.command'a çift tıkla, Yeni fikir > Mod: Hibrit seç."
echo "Kovan'ın üst çubuğunda 'Yerel hazır' görünmeli. Kodlayan ajanlar (BE, FE) yerelde, diğerleri Claude'da çalışır."
bitir 0
