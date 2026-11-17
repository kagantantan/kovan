"""Ajan kartları: ajanlar/<id>.md dosyaları.

Her kart iki parçadır:
  1. YAML ön bilgi (---) : model, araçlar, izinli komutlar, süre ve bütçe sınırları
  2. Markdown gövde     : ajanın sistem promptu (rolü, görevi, sınırları, çıktı formatı)

Sınırın bir kısmı prompt'ta (gövde), bir kısmı sistemde (araçlar, izinli komutlar,
süre, bütçe, kilitli dosyalar) uygulanır.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

import yaml

BILINEN_ARACLAR = {
    "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash",
    "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite", "Task",
}

_ON_BILGI = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.DOTALL)


@dataclass
class AjanKarti:
    id: str
    ad: str
    kisaltma: str
    motor: str = "claude"              # claude | kovan.yaml'daki yerel motor adı (ör. qwen-yerel)
    model: str = "sonnet"              # Claude modeli (hepsi-Claude modunda yerel ajanlar da bunu kullanır)
    yerel_model: Optional[str] = None  # yerel motorda bu ajana özel model (boşsa motorun modeli)
    aciklama: str = ""
    araclar: List[str] = field(default_factory=list)
    izinli_komutlar: List[str] = field(default_factory=list)
    sure_dk: float = 10.0
    butce_usd: Optional[float] = None
    sistem_promptu: str = "degistir"   # degistir: kartı tek sistem promptu yap | ekle: Claude Code'unkine ekle
    efor: Optional[str] = None
    govde: str = ""
    dosya: str = ""

    def bolum(self, baslik: str) -> str:
        """Gövdeden '# <baslik>' bölümünü döndürür (bir sonraki # başlığına kadar)."""
        desen = re.compile(r"^#\s+" + re.escape(baslik) + r"\s*$(.*?)(?=^#\s|\Z)", re.MULTILINE | re.DOTALL)
        m = desen.search(self.govde)
        return m.group(1).strip() if m else ""

    def ozet(self) -> dict:
        return {
            "id": self.id, "ad": self.ad, "kisaltma": self.kisaltma, "model": self.model,
            "motor": self.motor, "yerel_model": self.yerel_model,
            "aciklama": self.aciklama, "araclar": self.araclar,
            "izinli_komutlar": self.izinli_komutlar, "sure_dk": self.sure_dk,
            "butce_usd": self.butce_usd, "sistem_promptu": self.sistem_promptu,
            "sinirlar": self.bolum("Sınırların"), "govde": self.govde, "dosya": self.dosya,
        }


def kart_oku(yol: Path) -> AjanKarti:
    metin = yol.read_text(encoding="utf-8").replace("\r\n", "\n")
    m = _ON_BILGI.match(metin)
    if not m:
        raise ValueError(f"{yol.name}: kart '---' ile başlayan YAML ön bilgi içermeli")
    on = yaml.safe_load(m.group(1)) or {}
    govde = m.group(2).strip()
    if not isinstance(on, dict):
        raise ValueError(f"{yol.name}: ön bilgi anahtar: değer biçiminde olmalı")
    for zorunlu in ("ad", "kisaltma"):
        if not on.get(zorunlu):
            raise ValueError(f"{yol.name}: '{zorunlu}' alanı zorunlu")
    if not govde:
        raise ValueError(f"{yol.name}: kartın gövdesi (sistem promptu) boş olamaz")

    araclar = list(on.get("araclar") or [])
    bilinmeyen = [a for a in araclar if a not in BILINEN_ARACLAR]
    if bilinmeyen:
        raise ValueError(f"{yol.name}: bilinmeyen araç(lar): {', '.join(bilinmeyen)}")
    sistem_promptu = str(on.get("sistem_promptu") or "degistir")
    if sistem_promptu not in ("degistir", "ekle"):
        raise ValueError(f"{yol.name}: sistem_promptu 'degistir' ya da 'ekle' olmalı")

    butce = on.get("butce_usd")
    return AjanKarti(
        id=yol.stem,
        ad=str(on["ad"]),
        kisaltma=str(on["kisaltma"]),
        motor=str(on.get("motor") or "claude"),
        model=str(on.get("model") or "sonnet"),
        yerel_model=str(on["yerel_model"]) if on.get("yerel_model") else None,
        aciklama=str(on.get("aciklama") or ""),
        araclar=araclar,
        izinli_komutlar=[str(k) for k in (on.get("izinli_komutlar") or [])],
        sure_dk=float(on.get("sure_dk") or 10),
        butce_usd=float(butce) if butce not in (None, "") else None,
        sistem_promptu=sistem_promptu,
        efor=str(on["efor"]) if on.get("efor") else None,
        govde=govde,
        dosya=str(yol),
    )


def yukle(dizin: Path) -> Dict[str, AjanKarti]:
    kartlar: Dict[str, AjanKarti] = {}
    for yol in sorted(dizin.glob("*.md")):
        if yol.name.startswith("_"):
            continue
        kart = kart_oku(yol)
        kartlar[kart.id] = kart
    if not kartlar:
        raise ValueError(f"{dizin} içinde ajan kartı bulunamadı")
    return kartlar
