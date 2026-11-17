"""kovan.yaml ayarlarını okur. Ortam değişkenleri (KOVAN_*) testler için ayarları ezer."""
from __future__ import annotations

import copy
import os
from pathlib import Path

import yaml

VARSAYILAN = {
    "port": 8765,
    "motor": "hibrit",               # yeni fikirde varsayılan mod: hibrit | claude | deneme
    "claude_yolu": "claude",         # claude komutu PATH'te değilse tam yolunu yaz
    "api_anahtarini_yoksay": True,   # ANTHROPIC_API_KEY varsa yok say -> abonelik girişin kullanılsın
    "paralel_fikir": 1,              # aynı anda kaç fikir çalışsın (abonelik limiti için 1 iyi)
    "paralel_inceleme": True,        # bir aşamanın onaycıları aynı anda mı çalışsın
    "deneme_sayisi": 2,              # geçici hatada bir adımı kaç kez denesin
    "deneme_gecikme_sn": 1.0,        # deneme motorunda her adımın yaklaşık süresi
    "calisma_dizini": None,          # boşsa kovan/calisma
    "motorlar": {                    # kartlarda `motor: <ad>` ile seçilen yerel motorlar
        "qwen-yerel": {"tur": "ollama", "adres": "http://127.0.0.1:11434", "model": "qwen3-coder:30b"},
    },
}

MODLAR = ("hibrit", "claude", "deneme")


def yukle(kok: Path) -> dict:
    cfg = copy.deepcopy(VARSAYILAN)
    dosya = kok / "kovan.yaml"
    if dosya.exists():
        veri = yaml.safe_load(dosya.read_text(encoding="utf-8")) or {}
        if not isinstance(veri, dict):
            raise ValueError("kovan.yaml bir sözlük (anahtar: değer) olmalı")
        cfg.update(veri)

    ortam = {
        "KOVAN_PORT": ("port", int),
        "KOVAN_MOTOR": ("motor", str),
        "KOVAN_CLAUDE_YOLU": ("claude_yolu", str),
        "KOVAN_DENEME_GECIKME": ("deneme_gecikme_sn", float),
        "KOVAN_CALISMA": ("calisma_dizini", str),
        "KOVAN_DENEME_SAYISI": ("deneme_sayisi", int),
    }
    for anahtar, (alan, tip) in ortam.items():
        if os.environ.get(anahtar):
            cfg[alan] = tip(os.environ[anahtar])

    motorlar = cfg.get("motorlar") or {}
    if not isinstance(motorlar, dict):
        raise ValueError("kovan.yaml: motorlar bir sözlük olmalı")
    for ad, m in motorlar.items():
        if ad in ("claude", "deneme"):
            raise ValueError(f"kovan.yaml: '{ad}' adı ayrılmış, yerel motora başka bir ad ver")
        if not isinstance(m, dict) or m.get("tur") != "ollama" or not m.get("model"):
            raise ValueError(f"kovan.yaml: motorlar.{ad} için 'tur: ollama' ve 'model' zorunlu")
        m.setdefault("adres", "http://127.0.0.1:11434")
        if os.environ.get("KOVAN_OLLAMA_ADRES"):
            m["adres"] = os.environ["KOVAN_OLLAMA_ADRES"]
    cfg["motorlar"] = motorlar

    if cfg["motor"] not in MODLAR:
        raise ValueError(f"kovan.yaml: motor şunlardan biri olmalı: {', '.join(MODLAR)}")
    return cfg
