#!/bin/bash
# Kovan başlatıcı. Mac'te çift tıkla ya da Terminal'de: bash Baslat.command
cd "$(dirname "$0")" || exit 1

dur() {
  echo ""
  echo "$1"
  echo ""
  read -r -p "Kapatmak için Enter'a bas..." _
  exit 1
}

if ! command -v python3 >/dev/null 2>&1; then
  dur "python3 bulunamadı. Terminal'de 'xcode-select --install' çalıştırıp tekrar dene."
fi

if [ ! -x .venv/bin/python ]; then
  echo "İlk kurulum: sanal ortam hazırlanıyor (bir kerelik)..."
  python3 -m venv .venv || dur "Sanal ortam (.venv) oluşturulamadı."
fi

if [ ! -f .venv/.kurulum-tamam ] || [ requirements.txt -nt .venv/.kurulum-tamam ]; then
  echo "Paketler kuruluyor (fastapi, uvicorn, pyyaml)..."
  .venv/bin/python -m pip install -q --upgrade pip >/dev/null 2>&1
  .venv/bin/python -m pip install -q -r requirements.txt || dur "Paket kurulumu başarısız. İnternet bağlantını kontrol et."
  touch .venv/.kurulum-tamam
fi

PORT=${KOVAN_PORT:-$(.venv/bin/python -c "import yaml; print((yaml.safe_load(open('kovan.yaml')) or {}).get('port', 8765))" 2>/dev/null || echo 8765)}
URL="http://127.0.0.1:$PORT"

if curl -s -o /dev/null "$URL/api/durum"; then
  echo "Kovan zaten çalışıyor, tarayıcıda açıyorum: $URL"
  open "$URL"
  exit 0
fi

# Sunucu ayağa kalkınca tarayıcıyı aç
( for _ in $(seq 1 60); do
    sleep 0.5
    if curl -s -o /dev/null "$URL/api/durum"; then open "$URL"; break; fi
  done ) &

.venv/bin/python -m kovan "$@"
