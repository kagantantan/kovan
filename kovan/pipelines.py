"""Akışlar: akislar/<id>.yaml dosyaları.

Bir akış, sıralı aşamalardan oluşur. Her aşama "Üret -> Doğrula" döngüsüdür:
  - ajan    : üreten ajan (kart id)
  - dogrulama: sırayla çalışan doğrulayıcılar
        komut     -> deterministik kontrol (ör. bash test.sh). Kırmızıysa döngü geri döner.
        inceleyen -> başka bir ajanın ONAY / DUZELT kararı
  - en_fazla_tur: onay gelmezse kaç tur denenecek; sonra karar sana kalır
  - tur: insan -> senin onay kapın
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

import yaml

from .cards import AjanKarti


@dataclass
class Dogrulayici:
    tip: str                  # "komut" | "ajan"
    ad: str
    komut: Optional[str] = None
    inceleyen: Optional[str] = None
    odak: str = ""
    sure_dk: float = 5.0


@dataclass
class Asama:
    id: str
    ad: str
    tur: str = "ajan"         # "ajan" | "insan"
    ajan: Optional[str] = None
    gorev: str = ""
    girdiler: List[str] = field(default_factory=list)
    cikti: Optional[str] = None
    calisma_dizini: Optional[str] = None   # "kod" -> ajan kod/ klasöründe araçlarla çalışır
    yazabilir: List[str] = field(default_factory=list)   # boşsa kod/ içinde her yere (kilitliler hariç)
    kilitle: List[str] = field(default_factory=list)
    dogrulama: List[Dogrulayici] = field(default_factory=list)
    en_fazla_tur: int = 2
    soru: str = ""
    geri_donus: Optional[str] = None


@dataclass
class Akis:
    id: str
    ad: str
    aciklama: str
    fikir_butcesi_usd: float
    asamalar: List[Asama]

    def indeks(self, asama_id: str) -> int:
        for i, a in enumerate(self.asamalar):
            if a.id == asama_id:
                return i
        raise KeyError(asama_id)

    def ozet(self, kartlar: Dict[str, AjanKarti]) -> dict:
        def ajan_ad(k):
            return kartlar[k].ad if k and k in kartlar else None

        return {
            "id": self.id, "ad": self.ad, "aciklama": self.aciklama,
            "fikir_butcesi_usd": self.fikir_butcesi_usd,
            "asamalar": [
                {
                    "id": a.id, "ad": a.ad, "tur": a.tur, "ajan": a.ajan, "ajan_ad": ajan_ad(a.ajan),
                    "girdiler": a.girdiler, "cikti": a.cikti, "kilitle": a.kilitle,
                    "yazabilir": a.yazabilir,
                    "en_fazla_tur": a.en_fazla_tur,
                    "dogrulama": [
                        {"ad": d.ad, "tip": d.tip, "komut": d.komut, "inceleyen": d.inceleyen,
                         "inceleyen_ad": ajan_ad(d.inceleyen)}
                        for d in a.dogrulama
                    ],
                }
                for a in self.asamalar
            ],
        }


def _yol(ham) -> str:
    """'./backend/' -> 'backend' ; kod/ altında göreli ve güvenli yol."""
    y = str(ham).strip().replace("\\", "/")
    while y.startswith("./"):
        y = y[2:]
    y = y.strip("/")
    if not y or y.startswith("..") or "/../" in f"/{y}/":
        raise ValueError(f"geçersiz yol: {ham}")
    return y


def _akis_oku(yol: Path, kartlar: Dict[str, AjanKarti]) -> Akis:
    ad_dosya = yol.name
    veri = yaml.safe_load(yol.read_text(encoding="utf-8")) or {}
    if not isinstance(veri, dict) or not veri.get("asamalar"):
        raise ValueError(f"{ad_dosya}: 'asamalar' listesi zorunlu")

    asamalar: List[Asama] = []
    uretilenler = {"fikir"}
    idler = set()
    for i, ham in enumerate(veri["asamalar"], 1):
        if not isinstance(ham, dict) or not ham.get("id"):
            raise ValueError(f"{ad_dosya}: {i}. aşamanın 'id' alanı yok")
        aid = str(ham["id"])
        if aid in idler:
            raise ValueError(f"{ad_dosya}: '{aid}' aşaması iki kez tanımlı")
        idler.add(aid)
        tur = str(ham.get("tur") or "ajan")
        if tur not in ("ajan", "insan"):
            raise ValueError(f"{ad_dosya}/{aid}: tur 'ajan' ya da 'insan' olmalı")

        asama = Asama(
            id=aid,
            ad=str(ham.get("ad") or aid),
            tur=tur,
            ajan=ham.get("ajan"),
            gorev=str(ham.get("gorev") or "").strip(),
            girdiler=[str(g) for g in (ham.get("girdiler") or [])],
            cikti=ham.get("cikti"),
            calisma_dizini=ham.get("calisma_dizini"),
            kilitle=[_yol(k) for k in (ham.get("kilitle") or [])],
            yazabilir=[_yol(k) for k in (ham.get("yazabilir") or [])],
            en_fazla_tur=int(ham.get("en_fazla_tur") or 2),
            soru=str(ham.get("soru") or ""),
            geri_donus=ham.get("geri_donus"),
        )

        if tur == "ajan":
            if not asama.ajan or asama.ajan not in kartlar:
                raise ValueError(f"{ad_dosya}/{aid}: ajan '{asama.ajan}' için kart yok (ajanlar/ klasörü)")
            if not asama.cikti:
                raise ValueError(f"{ad_dosya}/{aid}: 'cikti' (belge adı) zorunlu")
            for g in asama.girdiler:
                if g not in uretilenler:
                    raise ValueError(f"{ad_dosya}/{aid}: girdi '{g}' daha önceki bir aşamada üretilmiyor")
            if asama.calisma_dizini not in (None, "kod"):
                raise ValueError(f"{ad_dosya}/{aid}: calisma_dizini şimdilik yalnızca 'kod' olabilir")
            if (asama.kilitle or asama.yazabilir) and asama.calisma_dizini != "kod":
                raise ValueError(f"{ad_dosya}/{aid}: kilitle/yazabilir yalnızca calisma_dizini: kod ile kullanılır")
            for j, d in enumerate(ham.get("dogrulama") or [], 1):
                if not isinstance(d, dict):
                    raise ValueError(f"{ad_dosya}/{aid}: {j}. doğrulayıcı geçersiz")
                if d.get("komut"):
                    asama.dogrulama.append(Dogrulayici(
                        tip="komut", ad=str(d.get("ad") or "Kontrol"), komut=str(d["komut"]),
                        sure_dk=float(d.get("sure_dk") or 5)))
                elif d.get("inceleyen"):
                    if d["inceleyen"] not in kartlar:
                        raise ValueError(f"{ad_dosya}/{aid}: inceleyen '{d['inceleyen']}' için kart yok")
                    kart = kartlar[d["inceleyen"]]
                    asama.dogrulama.append(Dogrulayici(
                        tip="ajan", ad=str(d.get("ad") or f"{kart.kisaltma} incelemesi"),
                        inceleyen=str(d["inceleyen"]), odak=str(d.get("odak") or "").strip(),
                        sure_dk=float(d.get("sure_dk") or kart.sure_dk)))
                else:
                    raise ValueError(f"{ad_dosya}/{aid}: doğrulayıcıda 'komut' ya da 'inceleyen' olmalı")
                if asama.dogrulama[-1].tip == "komut" and asama.calisma_dizini != "kod":
                    raise ValueError(f"{ad_dosya}/{aid}: komut doğrulaması için calisma_dizini: kod gerekli")
            uretilenler.add(str(asama.cikti))
        asamalar.append(asama)

    for a in asamalar:
        if a.geri_donus and a.geri_donus not in idler:
            raise ValueError(f"{ad_dosya}/{a.id}: geri_donus '{a.geri_donus}' diye bir aşama yok")

    return Akis(
        id=yol.stem,
        ad=str(veri.get("ad") or yol.stem),
        aciklama=str(veri.get("aciklama") or "").strip(),
        fikir_butcesi_usd=float(veri.get("fikir_butcesi_usd") or 5),
        asamalar=asamalar,
    )


def yukle(dizin: Path, kartlar: Dict[str, AjanKarti]) -> Dict[str, Akis]:
    akislar: Dict[str, Akis] = {}
    for yol in sorted(dizin.glob("*.yaml")):
        akislar[yol.stem] = _akis_oku(yol, kartlar)
    if not akislar:
        raise ValueError(f"{dizin} içinde akış bulunamadı")
    return akislar
