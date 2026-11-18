#!/bin/bash
# Kovan başlatıcı. Mac'te çift tıkla ya da Terminal'de: bash Baslat.command  (deneme modu: bash Baslat.command --deneme)
cd "$(dirname "$0")" || exit 1

dur() {
  echo ""
  echo "$1"
  echo ""
  read -r -p "Kapatmak için Enter'a bas..." _
  exit 1
}

ac() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
  fi
}

# Finder'dan çift tıklayınca kabuk ayarların (~/.zshrc) okunmaz; Node'un yaygın kurulum yollarını ekle.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

command -v node >/dev/null 2>&1 || dur "Node.js bulunamadı. https://nodejs.org adresinden LTS sürümünü (22 ya da üstü) kur, sonra tekrar çift tıkla."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>=23?0:1)' \
  || dur "Node.js $(node -v) eski. Kovan için 20.19+ ya da 22.12+ gerekli: https://nodejs.org (LTS)."

if [ ! -f node_modules/.kovan-kurulum ] || [ package.json -nt node_modules/.kovan-kurulum ] || [ package-lock.json -nt node_modules/.kovan-kurulum ]; then
  echo "Paketler kuruluyor (bir kerelik, internet gerekir)..."
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=error || dur "Paket kurulumu başarısız. İnternet bağlantını kontrol et."
  else npm install --no-audit --no-fund --loglevel=error || dur "Paket kurulumu başarısız. İnternet bağlantını kontrol et."
  fi
  touch node_modules/.kovan-kurulum
fi

if [ ! -f arayuz/dist/index.html ] || [ -n "$(find arayuz/src arayuz/index.html vite.config.ts -newer arayuz/dist/index.html 2>/dev/null | head -1)" ]; then
  echo "Arayüz derleniyor..."
  npm run build --silent >/dev/null || dur "Arayüz derlenemedi. Terminal'de 'npm run build' çalıştırıp hatayı gör."
fi

PORT=${KOVAN_PORT:-$(sed -n 's/^port:[[:space:]]*\([0-9][0-9]*\).*/\1/p' kovan.yaml 2>/dev/null | head -1)}
PORT=${PORT:-8765}
URL="http://127.0.0.1:$PORT"

if curl -s -o /dev/null "$URL/api/durum"; then
  echo "Kovan zaten çalışıyor, tarayıcıda açıyorum: $URL"
  ac "$URL"
  exit 0
fi

# Sunucu ayağa kalkınca tarayıcıyı aç
( for _ in $(seq 1 60); do
    sleep 0.5
    if curl -s -o /dev/null "$URL/api/durum"; then ac "$URL"; break; fi
  done ) &

# Dış ayar: KOVAN_AYAR verilmemişse ~/.kovan/kovan.yaml varsa onu kullan (kurum LLM'i, anahtarın yeri, ajanlar).
# Çift tıklayınca ~/.zshrc okunmaz: anahtar için ortam değişkeni yerine anahtar_dosyasi kullan.
if [ -z "${KOVAN_AYAR:-}" ] && [ -f "$HOME/.kovan/kovan.yaml" ]; then
  export KOVAN_AYAR="$HOME/.kovan/kovan.yaml"
fi

KOVAN_PORT=$PORT ./node_modules/.bin/tsx sunucu/src/index.ts "$@"
