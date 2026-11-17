"""Orkestratör: her fikri akışındaki aşamalardan geçiren durum makinesi.

Bir aşama = Üret -> Doğrula döngüsü:
    1. Üret     : aşamanın ajanı çıktısını yazar (belge ya da kod/ klasöründe dosyalar)
    2. Denetle  : yazma alanı dışındaki ve kilitli dosyalardaki değişiklikler geri alınır, ihlal kaydedilir
    3. Doğrula  : önce deterministik komutlar (test), sonra onay kurulu (inceleyen ajanlar, paralel)
    4. Bulgu varsa tur artar ve bulgular üreten ajana geri gider; tur sınırında karar sana kalır

Motor seçimi: fikrin modu (hibrit | claude | deneme) + ajan kartındaki `motor` alanı.
Her adım (ajan çağrısı, kontrol, karar) SQLite'a ve calisma/<fikir>/gunluk/ altına yazılır.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .cards import AjanKarti
from .config import MODLAR
from .engine import KARAR_SEMASI, AjanCagrisi, AjanSonucu, json_cikar, kisalt, sureci_oldur
from .pipelines import Akis, Asama, Dogrulayici
from .store import Depo, simdi

YOKSAY_KLASOR = {"__pycache__", ".pytest_cache", ".git", "node_modules", ".venv", "venv", "test-results",
                 "playwright-report", "coverage", "dist", "build", ".next", ".vite", ".cache", ".turbo",
                 ".parcel-cache", ".mypy_cache", ".ruff_cache"}
YOKSAY_DOSYA = {".DS_Store", ".coverage"}
YOKSAY_UZANTI = {".pyc", ".pyo", ".log"}

ORTAK_KURALLAR = """# Ortak kurallar (her ajan için)
- Yalnızca sana verilen girdilere ve rolüne dayan. Girdilerde olmayan bilgiyi uydurma.
- Bir şeyi varsaymak zorundaysan "VARSAYIM:" diye açıkça işaretle.
- Emin değilsen "BİLMİYORUM" de. Emin görünen yanlış bir cevap, eksik bir cevaptan daha kötüdür.
- Rolünün dışındaki işi yapma; başka rolün kararını değiştirme.
- Türkçe yaz; yerleşmiş teknik terimleri (test, interface, rounding, edge case gibi) İngilizce bırak."""

INCELEME_KURALLARI = """# İnceleme kuralları
- Somut ve düzeltilebilir bir eksik ya da hata varsa DUZELT ver; yoksa ONAY ver.
- Stil ve zevk farkı için DUZELT verme. Mükemmel değil ama doğru ve yeterliyse ONAY.
- Yalnızca kendi rolünün alanına bak; başka onaycının alanındaki konular için DUZELT verme.
- Her bulgu tek cümle: neyin, neden yanlış olduğu ve hangi kritere/kurala aykırı olduğu. En fazla 5 bulgu.
- Emin olmadığın bir konuda bulgu yazma; doğrulayamadığın bir şeyi hata sayma.
- Senin rolün incelemek: düzeltmeyi kendin yazma, dosya değiştirme."""

SECIM_ETIKET = {
    "devam": "Olduğu gibi kabul edildi, devam",
    "bir_tur_daha": "Bir tur daha verildi",
    "tekrar_dene": "Tekrar denendi",
    "atla": "Aşama atlandı",
    "butce_artir": "Bütçe artırıldı",
    "kabul": "Kabul edildi",
    "geri_gonder": "Notla geri gönderildi",
    "claude_devral": "Aşama Claude'a devredildi",
    "durdur": "Durduruldu",
}


def _ozet_satiri(metin: str) -> str:
    for satir in (metin or "").splitlines():
        s = satir.strip().lstrip("#>*-| ").strip()
        if s and not s.startswith("```"):
            return kisalt(s, 140)
    return ""


def _cit_ayikla(metin: str) -> str:
    """Belgeyi saran ```markdown ... ``` çitini kaldırır."""
    s = metin.strip()
    if s.startswith("```"):
        ilk, _, govde = s.partition("\n")
        if ilk.strip("`").strip().lower() in ("", "markdown", "md") and govde.rstrip().endswith("```"):
            return govde.rstrip()[:-3].rstrip()
    return s


def _kuyruk(metin: str, n: int) -> str:
    metin = metin or ""
    return metin if len(metin) <= n else "…\n" + metin[-n:]


def _test_ozeti(cikti: str, kod: int) -> str:
    satirlar = [s.strip() for s in (cikti or "").splitlines() if s.strip() and not set(s.strip()) <= set("-=")]
    onemli = [s for s in satirlar if s.startswith(("Ran ", "OK", "FAILED")) or " passed" in s or " failed" in s]
    secilen = onemli[-2:] if onemli else satirlar[-2:]
    on = "Yeşil" if kod == 0 else f"Kırmızı (çıkış kodu {kod})"
    return kisalt(on + (" · " + " · ".join(secilen) if secilen else ""), 200)


def _altinda(rel: str, yol: str) -> bool:
    return rel == yol or rel.startswith(yol.rstrip("/") + "/")


class Orkestrator:
    def __init__(self, calisma: Path, cfg: dict, depo: Depo, kartlar: Dict[str, AjanKarti],
                 akislar: Dict[str, Akis], motorlar: dict):
        self.calisma = calisma
        self.cfg = cfg
        self.depo = depo
        self.kartlar = kartlar
        self.akislar = akislar
        self.motorlar = motorlar
        self.deneme_sayisi = max(1, int(cfg.get("deneme_sayisi") or 2))
        self.paralel_inceleme = bool(cfg.get("paralel_inceleme", True))
        self.havuz = ThreadPoolExecutor(max_workers=max(1, int(cfg.get("paralel_fikir") or 1)),
                                        thread_name_prefix="kovan")
        self.kilit = threading.RLock()
        self.durdur_istekleri: set = set()
        self.surecler: Dict[str, set] = {}
        self.planlananlar: set = set()
        self.tekrar_planla: set = set()
        for kart in kartlar.values():
            if kart.motor not in motorlar or kart.motor == "deneme":
                raise ValueError(f"ajanlar/{kart.id}.md: motor '{kart.motor}' tanımlı değil "
                                 f"(claude ya da kovan.yaml'daki motorlar: {', '.join(k for k in motorlar if k != 'deneme')})")
        self._kurtar()

    # =============================== motor seçimi ===============================
    @staticmethod
    def _istisnalar(f: dict) -> dict:
        try:
            return json.loads(f.get("istisnalar") or "{}")
        except (json.JSONDecodeError, TypeError):
            return {}

    def _motor(self, f: dict, kart: AjanKarti, asama: Optional[Asama] = None, uretici: bool = False):
        mod = f.get("motor") or "claude"
        if mod == "deneme":
            return self.motorlar["deneme"]
        if mod == "hibrit":
            if uretici and asama is not None:
                ist = self._istisnalar(f).get(asama.id)
                if ist in self.motorlar:
                    return self.motorlar[ist]
            return self.motorlar.get(kart.motor) or self.motorlar["claude"]
        return self.motorlar["claude"]          # "claude": hepsi Claude

    def _gereken_motorlar(self, akis: Akis, mod: str) -> List[str]:
        if mod in ("deneme", "claude"):
            return [mod]
        adlar = []
        for a in akis.asamalar:
            roller = ([a.ajan] if a.ajan else []) + [v.inceleyen for v in a.dogrulama if v.inceleyen]
            for r in roller:
                m = self.kartlar[r].motor
                if m not in adlar:
                    adlar.append(m)
        return adlar or ["claude"]

    def _devralinabilir(self, f: dict, asama: Asama) -> bool:
        if (f.get("motor") or "") != "hibrit" or not asama.ajan:
            return False
        motor = self._motor(f, self.kartlar[asama.ajan], asama, uretici=True)
        return bool(getattr(motor, "yerel", False))

    # =============================== dış arayüz ===============================
    def yeni_fikir(self, baslik: str, metin: str, profil: str, motor: str) -> str:
        metin = (metin or "").strip()
        if not metin:
            raise ValueError("Fikir metni boş olamaz.")
        if profil not in self.akislar:
            raise ValueError(f"Bilinmeyen akış: {profil}")
        if motor not in MODLAR:
            raise ValueError(f"Bilinmeyen mod: {motor} (hibrit, claude ya da deneme)")
        for ad in self._gereken_motorlar(self.akislar[profil], motor):
            m = self.motorlar[ad]
            if not m.saglik(zorla=True):
                ipucu = " Yerel motor olmadan çalıştırmak için 'Hepsi Claude' modunu seç." if m.yerel else ""
                raise ValueError(f"'{ad}' motoru hazır değil: {m.hata}{ipucu}")
        with self.kilit:
            fid = self.depo.yeni_id()
            d = self.calisma / fid
            for alt in ("belgeler", "kod", "incelemeler", "gunluk", ".kovan"):
                (d / alt).mkdir(parents=True, exist_ok=True)
            (d / "belgeler" / "fikir.md").write_text(metin + "\n", encoding="utf-8")
            baslik = (baslik or "").strip() or kisalt(metin.splitlines()[0], 70)
            self.depo.fikir_ekle(id=fid, baslik=baslik, metin=metin, profil=profil, motor=motor,
                                 durum="sirada", asama_idx=0, tur=1, faz="uret", ek_tur=0,
                                 butce_usd=self.akislar[profil].fikir_butcesi_usd, istisnalar="{}")
        self._planla(fid)
        return fid

    def karar_ver(self, fid: str, secim: str, not_: str = "", hedef: Optional[str] = None) -> None:
        not_ = (not_ or "").strip()
        with self.kilit:
            f = self.depo.fikir(fid)
            if not f:
                raise KeyError(fid)
            if f["durum"] != "bekliyor":
                raise ValueError("Bu fikir şu an senden karar beklemiyor.")
            b = json.loads(f["bekleme"] or "{}")
            if secim not in b.get("secenekler", []):
                raise ValueError(f"Bu bekleme için geçersiz seçim: {secim}")
            akis = self.akislar[f["profil"]]
            idx = int(f["asama_idx"])
            asama = akis.asamalar[idx] if idx < len(akis.asamalar) else None
            g: dict = {"bekleme": None, "durum": "sirada"}

            def not_ekle(gb: Optional[str]) -> str:
                return ((gb or "") + (f"\n\n### Kağan'ın notu\n{not_}" if not_ else "")).strip()

            if secim == "durdur":
                g.update(durum="durduruldu", bitis=simdi())
            elif secim in ("devam", "kabul", "atla"):
                if secim == "devam" and asama and asama.kilitle:
                    self._kilitle(fid, asama)
                if secim == "atla" and asama:
                    self._sistem_adimi(fid, asama, "Atlandı", "atlandi", "Aşama senin kararınla atlandı.")
                g.update(self._ilerleme_alanlari(fid, akis, idx + 1))
            elif secim == "bir_tur_daha":
                g.update(ek_tur=int(f["ek_tur"] or 0) + 1, tur=int(f["tur"] or 1) + 1, faz="uret",
                         geri_bildirim=not_ekle(f["geri_bildirim"]))
            elif secim == "tekrar_dene":
                if not_ and f["faz"] == "uret":
                    g["geri_bildirim"] = not_ekle(f["geri_bildirim"])
            elif secim == "claude_devral":
                if not asama:
                    raise ValueError("Devredilecek aşama yok.")
                ist = self._istisnalar(f)
                ist[asama.id] = "claude"
                g["istisnalar"] = json.dumps(ist, ensure_ascii=False)
                if b.get("sebep") == "tur_siniri":
                    g.update(ek_tur=int(f["ek_tur"] or 0) + 1, tur=int(f["tur"] or 1) + 1, faz="uret",
                             geri_bildirim=not_ekle(f["geri_bildirim"]))
                elif not_:
                    g["geri_bildirim"] = not_ekle(f["geri_bildirim"])
            elif secim == "butce_artir":
                eski = float(f["butce_usd"] or 0)
                g["butce_usd"] = round(max(eski * 1.5, eski + 1.0), 2)
            elif secim == "geri_gonder":
                if not not_:
                    raise ValueError("Geri gönderirken ne istediğini not olarak yaz.")
                hedef = (hedef or "").strip() or (asama.geri_donus if asama and asama.geri_donus else None)
                if hedef is None:
                    onceki = [a for a in akis.asamalar[:idx] if a.tur == "ajan"]
                    if not onceki:
                        raise ValueError("Geri gönderilecek bir ajan aşaması yok.")
                    hedef = onceki[-1].id
                try:
                    hidx = akis.indeks(hedef)
                except KeyError:
                    raise ValueError(f"Böyle bir aşama yok: {hedef}")
                if hidx >= idx or akis.asamalar[hidx].tur != "ajan":
                    raise ValueError("Yalnızca önceki bir ajan aşamasına geri gönderebilirsin.")
                g.update(asama_idx=hidx, tur=1, faz="uret", ek_tur=0,
                         geri_bildirim=f"### Kağan'ın notu\n{not_}")

            etiket = SECIM_ETIKET.get(secim, secim) + (f" · Not: {not_}" if not_ else "")
            if b.get("adim_id"):
                self.depo.adim_guncelle(int(b["adim_id"]), durum="karar", bitis=simdi(),
                                        ozet=kisalt(f"{b.get('mesaj', '')} → {etiket}", 300))
            self.depo.fikir_guncelle(fid, **g)
            if g["durum"] == "sirada":
                self.durdur_istekleri.discard(fid)
        if g["durum"] == "sirada":
            self._planla(fid)

    def durdur(self, fid: str) -> None:
        f = self.depo.fikir(fid)
        if not f:
            raise KeyError(fid)
        if f["durum"] in ("sirada", "calisiyor"):
            with self.kilit:
                self.durdur_istekleri.add(fid)
                surecler = list(self.surecler.get(fid, ()))
                bosta = fid not in self.planlananlar
            for p in surecler:
                sureci_oldur(p)
            if bosta:
                self._durdur_uygula(fid)
        elif f["durum"] == "bekliyor":
            b = json.loads(f["bekleme"] or "{}")
            if b.get("adim_id"):
                self.depo.adim_guncelle(int(b["adim_id"]), durum="karar", bitis=simdi(),
                                        ozet=kisalt(f"{b.get('mesaj', '')} → Durduruldu", 300))
            self.depo.fikir_guncelle(fid, durum="durduruldu", bekleme=None, bitis=simdi())
        else:
            raise ValueError("Bu fikir zaten durmuş ya da bitmiş.")

    def devam_ettir(self, fid: str) -> None:
        f = self.depo.fikir(fid)
        if not f:
            raise KeyError(fid)
        if f["durum"] != "durduruldu":
            raise ValueError("Yalnızca durdurulmuş bir fikir devam ettirilebilir.")
        self.depo.fikir_guncelle(fid, durum="sirada", bitis=None)
        self._sistem_adimi(fid, None, "Devam", "tamam", "Kaldığı yerden devam ediyor.")
        self._planla(fid)

    def fikir_listesi(self) -> List[dict]:
        sonuc = []
        for f in self.depo.fikirler():
            akis = self.akislar.get(f["profil"])
            idx = int(f["asama_idx"] or 0)
            asama_ad = akis.asamalar[idx].ad if akis and idx < len(akis.asamalar) else "Teslim"
            sonuc.append({
                "id": f["id"], "baslik": f["baslik"], "durum": f["durum"], "profil": f["profil"],
                "motor": f["motor"], "maliyet_usd": f["maliyet_usd"], "butce_usd": f["butce_usd"],
                "olusturma": f["olusturma"], "asama_ad": asama_ad, "asama_no": idx + 1,
                "asama_sayisi": len(akis.asamalar) if akis else 0,
            })
        return sonuc

    def fikir_detayi(self, fid: str) -> dict:
        f = self.depo.fikir(fid)
        if not f:
            raise KeyError(fid)
        akis = self.akislar.get(f["profil"])
        adimlar = self.depo.adimlar(fid)
        asamalar = []
        if akis:
            idx = int(f["asama_idx"] or 0)
            for i, a in enumerate(akis.asamalar):
                if f["durum"] == "tamamlandi" or i < idx:
                    atlandi = any(s["asama_id"] == a.id and s["durum"] == "atlandi" for s in adimlar)
                    durum = "atlandi" if atlandi else "tamam"
                elif i == idx:
                    durum = {"bekliyor": "bekliyor", "calisiyor": "aktif", "sirada": "sirada",
                             "durduruldu": "durdu"}.get(f["durum"], "aktif")
                else:
                    durum = "bekleyen"
                uretici_motor = None
                if a.ajan:
                    uretici_motor = self._motor(f, self.kartlar[a.ajan], a, uretici=True).ad
                asamalar.append({
                    "id": a.id, "ad": a.ad, "tur": a.tur, "durum": durum,
                    "ajan": self.kartlar[a.ajan].kisaltma if a.ajan else "Sen",
                    "motor": uretici_motor, "yazabilir": a.yazabilir,
                    "onaylar": self._onay_rozetleri(a, adimlar),
                })
        aktif_sure = sum(float(s["sure_sn"] or 0) for s in adimlar if s["tip"] in ("uret", "inceleme", "kontrol"))
        motor_cagrilari: Dict[str, int] = {}
        for s in adimlar:
            if s["tip"] in ("uret", "inceleme") and s.get("motor"):
                motor_cagrilari[s["motor"]] = motor_cagrilari.get(s["motor"], 0) + 1
        return {
            "fikir": f,
            "akis_ad": akis.ad if akis else f["profil"],
            "asamalar": asamalar,
            "adimlar": adimlar,
            "bekleme": json.loads(f["bekleme"]) if f.get("bekleme") else None,
            "dosyalar": self._dosya_listesi(fid),
            "aktif_sure_sn": round(aktif_sure, 1),
            "ajan_cagrisi": sum(1 for s in adimlar if s["tip"] in ("uret", "inceleme")),
            "motor_cagrilari": motor_cagrilari,
        }

    def _onay_rozetleri(self, a: Asama, adimlar: List[dict]) -> List[dict]:
        rozetler = []
        for v in a.dogrulama:
            if v.tip == "komut":
                son = [s for s in adimlar if s["asama_id"] == a.id and s["tip"] == "kontrol" and s["ajan_ad"] == v.ad]
                rozetler.append({"ad": v.ad, "kisa": "TEST", "durum": son[-1]["durum"] if son else None})
            else:
                kart = self.kartlar[v.inceleyen]
                son = [s for s in adimlar if s["asama_id"] == a.id and s["tip"] == "inceleme" and s["ajan"] == kart.id]
                rozetler.append({"ad": f"{v.ad} · {kart.ad}", "kisa": kart.kisaltma,
                                 "durum": son[-1]["durum"] if son else None})
        return rozetler

    def dosya_oku(self, fid: str, yol: str) -> dict:
        p = self.dosya_yolu(fid, yol)
        veri = p.read_bytes()
        kesildi = len(veri) > 300_000
        try:
            metin = veri[:300_000].decode("utf-8")
        except UnicodeDecodeError:
            metin = "(ikili dosya, gösterilemiyor)"
        return {"yol": yol, "icerik": metin, "kesildi": kesildi, "boyut": len(veri)}

    def dosya_yolu(self, fid: str, yol: str) -> Path:
        kok = (self.calisma / fid).resolve()
        p = (kok / yol).resolve()
        if kok not in p.parents:
            raise PermissionError("Bu dosyaya erişilemez.")
        if not p.is_file():
            raise FileNotFoundError(yol)
        return p

    # ================================ çalıştırma ================================
    def _kurtar(self) -> None:
        """Sunucu kapanıp açıldıysa yarıda kalan işleri senin kararına bırakır."""
        self.depo.calisan_adimlari_kapat()
        for f in self.depo.durumdakiler("calisiyor", "sirada"):
            akis = self.akislar.get(f["profil"])
            idx = int(f["asama_idx"] or 0)
            asama = akis.asamalar[idx] if akis and idx < len(akis.asamalar) else None
            self._bekle(f["id"], asama, "kesildi",
                        "Kovan yeniden başladı; bu iş yarıda kalmıştı. Kaldığı yerden devam edebilirsin.",
                        ["tekrar_dene", "durdur"])

    def _planla(self, fid: str) -> None:
        with self.kilit:
            if fid in self.planlananlar:
                self.tekrar_planla.add(fid)
                return
            self.planlananlar.add(fid)
        self.havuz.submit(self._calistir_guvenli, fid)

    def _calistir_guvenli(self, fid: str) -> None:
        try:
            self._calistir(fid)
        except Exception as e:  # beklenmeyen hata: işi kaybetme, sana sor
            iz = traceback.format_exc()
            try:
                (self.calisma / fid / "gunluk" / "orkestrator-hatasi.txt").write_text(iz, encoding="utf-8")
                self._bekle(fid, None, "hata", f"Orkestratör hatası: {e}", ["tekrar_dene", "durdur"],
                            detay=kisalt(iz, 3000))
            except Exception:
                traceback.print_exc()
        finally:
            with self.kilit:
                self.planlananlar.discard(fid)
                tekrar = fid in self.tekrar_planla
                self.tekrar_planla.discard(fid)
            if tekrar:
                self._planla(fid)

    def _calistir(self, fid: str) -> None:
        f = self.depo.fikir(fid)
        if not f or f["durum"] not in ("sirada", "calisiyor"):
            return
        if fid in self.durdur_istekleri:
            self._durdur_uygula(fid)
            return
        akis = self.akislar.get(f["profil"])
        if akis is None:
            self._bekle(fid, None, "hata", f"Akış bulunamadı: {f['profil']}", ["durdur"])
            return
        self.depo.fikir_guncelle(fid, durum="calisiyor", baslama=f["baslama"] or simdi())
        while True:
            if fid in self.durdur_istekleri:
                self._durdur_uygula(fid)
                return
            f = self.depo.fikir(fid)
            idx = int(f["asama_idx"] or 0)
            if idx >= len(akis.asamalar):
                self.depo.fikir_guncelle(fid, durum="tamamlandi", bitis=simdi())
                self._sistem_adimi(fid, None, "Teslim", "tamam", "Akış tamamlandı.")
                return
            asama = akis.asamalar[idx]
            if self._asama(fid, asama) != "ilerle":
                return
            self.depo.fikir_guncelle(fid, **self._ilerleme_alanlari(fid, akis, idx + 1))

    def _asama(self, fid: str, asama: Asama) -> str:
        if asama.tur == "insan":
            return self._bekle(fid, asama, "insan", asama.soru or "Onayın gerekiyor.",
                               ["kabul", "geri_gonder", "durdur"], detay=self._teslim_ozeti(fid))
        while True:
            if fid in self.durdur_istekleri:
                self._durdur_uygula(fid)
                return "dur"
            f = self.depo.fikir(fid)
            tur = int(f["tur"] or 1)
            sinir = asama.en_fazla_tur + int(f["ek_tur"] or 0)
            ek_bulgular: List[str] = []
            if f["faz"] != "dogrula":
                r, ek_bulgular = self._uret(fid, asama, tur, f["geri_bildirim"])
                if r != "ok":
                    return r
                self.depo.fikir_guncelle(fid, faz="dogrula")
            bulgular, r = self._dogrula(fid, asama, tur)
            if r != "ok":
                return r
            if not bulgular:
                if asama.kilitle:
                    self._kilitle(fid, asama)
                return "ilerle"
            gb = "\n\n".join(ek_bulgular + bulgular)
            if tur >= sinir:
                self.depo.fikir_guncelle(fid, faz="uret", geri_bildirim=gb)
                secenekler = ["bir_tur_daha"]
                if self._devralinabilir(self.depo.fikir(fid), asama):
                    secenekler.append("claude_devral")
                return self._bekle(
                    fid, asama, "tur_siniri",
                    f"'{asama.ad}' {tur} turda onay alamadı. Bulgular aşağıda; nasıl ilerleyelim?",
                    secenekler + ["devam", "durdur"], detay=gb)
            self.depo.fikir_guncelle(fid, tur=tur + 1, faz="uret", geri_bildirim=gb)

    # ---------------------------------- üret ----------------------------------
    def _uret(self, fid: str, asama: Asama, tur: int, geri_bildirim: Optional[str]) -> Tuple[str, List[str]]:
        kart = self.kartlar[asama.ajan]
        f = self.depo.fikir(fid)
        motor = self._motor(f, kart, asama, uretici=True)
        model = motor.model_sec(kart)
        d = self.calisma / fid
        dizin_modu = asama.calisma_dizini == "kod"
        cwd = d / "kod" if dizin_modu else d / "belgeler"
        if asama.kilitle:
            self._kilit_kaldir(fid, asama.kilitle)
        istem = self._uretim_istemi(fid, asama, tur, geri_bildirim, dizin_modu)
        sistem = kart.govde.strip() + "\n\n" + ORTAK_KURALLAR
        sonuc: Optional[AjanSonucu] = None
        deneme = 0
        for deneme in range(1, self.deneme_sayisi + 1):
            if self._butce_asildi(fid):
                return self._butce_beklemesi(fid, asama), []
            adim = self.depo.adim_ekle(fid, asama.id, asama.ad, "uret", kart.id, kart.ad, tur, deneme, "calisiyor",
                                       motor=motor.ad, model=model)
            if dizin_modu:
                self._on_kopya_al(fid)
            cagri = AjanCagrisi(
                rol=kart.id, asama_id=asama.id, gorev_turu="uret", sistem=sistem, istem=istem,
                model=model, araclar=list(kart.araclar), izinli=list(kart.izinli_komutlar),
                cwd=str(cwd), sure_sn=kart.sure_dk * 60, sistem_modu=kart.sistem_promptu,
                butce_usd=kart.butce_usd, efor=kart.efor, surec_cb=self._surec_cb(fid),
            )
            sonuc = motor.calistir(cagri)
            gunluk = self._gunluk(fid, adim, motor, cagri, sonuc)
            self.depo.maliyet_ekle(fid, sonuc.maliyet, sonuc.girdi_token, sonuc.cikti_token)
            ek = (self._alan_denetle(fid, asama, kart) + self._kilit_denetle(fid, asama, kart)) if dizin_modu else []
            if fid in self.durdur_istekleri:
                self._adim_kapat(adim, "durduruldu", sonuc, "Kullanıcı durdurdu", gunluk)
                self._durdur_uygula(fid)
                return "dur", []
            if sonuc.ok and (sonuc.metin.strip() or dizin_modu):
                metin = sonuc.metin.strip() or "(ajan özet yazmadı)"
                yol = self._belge_kaydet(fid, asama.cikti, metin if dizin_modu else _cit_ayikla(metin), adim)
                self._adim_kapat(adim, "tamam", sonuc, _ozet_satiri(metin), yol)
                if "TEST ŞÜPHESİ" in metin:
                    self._sistem_adimi(fid, asama, "Test şüphesi", "uyari",
                                       kisalt(metin.split("TEST ŞÜPHESİ", 1)[1].lstrip(": "), 400))
                return "ok", ek
            self._adim_kapat(adim, "takildi" if sonuc.zaman_asimi else "hata", sonuc,
                             sonuc.hata or "Ajan boş çıktı döndürdü", gunluk)
            if sonuc.kalici_hata:
                break
            self._tekrar_oncesi_bekle(motor, deneme)
        neden = sonuc.hata if sonuc else ""
        secenekler = ["tekrar_dene"] + (["claude_devral"] if self._devralinabilir(f, asama) else []) + ["atla", "durdur"]
        return self._bekle(fid, asama, "hata", f"{kart.ad} başarısız oldu ({deneme} deneme): {neden}",
                           secenekler), []

    # -------------------------------- doğrula ---------------------------------
    def _dogrula(self, fid: str, asama: Asama, tur: int) -> Tuple[List[str], str]:
        bulgular: List[str] = []
        for v in [v for v in asama.dogrulama if v.tip == "komut"]:
            if fid in self.durdur_istekleri:
                self._durdur_uygula(fid)
                return [], "dur"
            yesil, cikti = self._komut_kos(fid, asama, v, tur)
            if yesil is None:
                return [], "dur"
            if not yesil:
                bulgular.append(f"### {v.ad}: KIRMIZI\nKomut: `{v.komut}`\n```\n{_kuyruk(cikti, 3500)}\n```")
                return bulgular, "ok"   # kırmızı koda onay kurulu harcamayız

        kurul = [v for v in asama.dogrulama if v.tip == "ajan"]
        if not kurul:
            return bulgular, "ok"
        if fid in self.durdur_istekleri:
            self._durdur_uygula(fid)
            return [], "dur"
        if self._butce_asildi(fid):
            return [], self._butce_beklemesi(fid, asama)

        if self.paralel_inceleme and len(kurul) > 1:
            with ThreadPoolExecutor(max_workers=len(kurul), thread_name_prefix=f"kurul-{fid}") as ex:
                sonuclar = list(ex.map(lambda v: self._incele(fid, asama, v, tur), kurul))
        else:
            sonuclar = []
            for v in kurul:
                sonuclar.append(self._incele(fid, asama, v, tur))
                if sonuclar[-1][0] == "dur":
                    break

        if fid in self.durdur_istekleri or any(s[0] == "dur" for s in sonuclar):
            self._durdur_uygula(fid)
            return [], "dur"
        hatalar = [(v, s[1]) for v, s in zip(kurul, sonuclar) if s[0] == "hata"]
        if hatalar:
            mesaj = "; ".join(f"{self.kartlar[v.inceleyen].ad}: {m}" for v, m in hatalar)
            return [], self._bekle(fid, asama, "hata", f"Onay kurulu tamamlanamadı. {mesaj}",
                                   ["tekrar_dene", "atla", "durdur"])
        for v, (_, karar) in zip(kurul, sonuclar):
            if karar["karar"] == "DUZELT":
                kart = self.kartlar[v.inceleyen]
                maddeler = "\n".join(f"- {b}" for b in karar["bulgular"]) or "- (madde yazılmadı)"
                bulgular.append(f"### {v.ad} ({kart.ad}): DÜZELT\nGerekçe: {karar.get('gerekce', '')}\n{maddeler}")
        return bulgular, "ok"

    def _komut_kos(self, fid: str, asama: Asama, v: Dogrulayici, tur: int) -> Tuple[Optional[bool], str]:
        d = self.calisma / fid
        adim = self.depo.adim_ekle(fid, asama.id, asama.ad, "kontrol", "-", v.ad, tur, 1, "calisiyor",
                                   motor="sistem")
        kaydet = self._surec_cb(fid)
        t0 = time.time()
        zaman_asimi = False
        try:
            p = subprocess.Popen(v.komut, shell=True, cwd=str(d / "kod"), stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                                 start_new_session=True)
            kaydet(p)
            try:
                cikti, _ = p.communicate(timeout=v.sure_dk * 60)
                kod = p.returncode
            except subprocess.TimeoutExpired:
                sureci_oldur(p)
                cikti, kod, zaman_asimi = f"(süre sınırı aşıldı: {v.sure_dk} dk)", -1, True
            finally:
                kaydet(p, True)
        except OSError as e:
            cikti, kod = f"Komut çalıştırılamadı: {e}", -1
        sure = round(time.time() - t0, 1)
        yol = f"gunluk/adim-{adim}-kontrol.txt"
        (d / yol).write_text(f"$ {v.komut}\n(çıkış kodu: {kod})\n\n{cikti}", encoding="utf-8")
        if fid in self.durdur_istekleri:
            self.depo.adim_guncelle(adim, durum="durduruldu", bitis=simdi(), sure_sn=sure,
                                    ozet="Kullanıcı durdurdu", dosya=yol)
            self._durdur_uygula(fid)
            return None, cikti
        yesil = kod == 0
        durum = "yesil" if yesil else ("takildi" if zaman_asimi else "kirmizi")
        self.depo.adim_guncelle(adim, durum=durum, bitis=simdi(), sure_sn=sure,
                                ozet=_test_ozeti(cikti, kod), dosya=yol)
        return yesil, cikti

    def _incele(self, fid: str, asama: Asama, v: Dogrulayici, tur: int) -> Tuple[str, Optional[object]]:
        """('ok', karar) | ('hata', mesaj) | ('dur', None). Beklemeye geçişi çağıran yapar (paralel güvenli)."""
        kart = self.kartlar[v.inceleyen]
        f = self.depo.fikir(fid)
        motor = self._motor(f, kart)
        model = motor.model_sec(kart)
        d = self.calisma / fid
        dizin_modu = asama.calisma_dizini == "kod"
        cwd = d / "kod" if dizin_modu else d / "belgeler"
        istem = self._inceleme_istemi(fid, asama, v, tur, dizin_modu)
        sistem = kart.govde.strip() + "\n\n" + ORTAK_KURALLAR + "\n\n" + INCELEME_KURALLARI
        sonuc: Optional[AjanSonucu] = None
        for deneme in range(1, self.deneme_sayisi + 1):
            adim = self.depo.adim_ekle(fid, asama.id, asama.ad, "inceleme", kart.id, kart.ad, tur, deneme,
                                       "calisiyor", motor=motor.ad, model=model)
            cagri = AjanCagrisi(
                rol=kart.id, asama_id=asama.id, gorev_turu="inceleme", sistem=sistem, istem=istem,
                model=model, araclar=["Read", "Glob", "Grep"] if dizin_modu else [], izinli=[],
                cwd=str(cwd), sure_sn=v.sure_dk * 60,
                sistem_modu="ekle" if dizin_modu else kart.sistem_promptu,
                butce_usd=kart.butce_usd, sema=KARAR_SEMASI, efor=kart.efor, surec_cb=self._surec_cb(fid),
            )
            sonuc = motor.calistir(cagri)
            gunluk = self._gunluk(fid, adim, motor, cagri, sonuc)
            self.depo.maliyet_ekle(fid, sonuc.maliyet, sonuc.girdi_token, sonuc.cikti_token)
            if fid in self.durdur_istekleri:
                self._adim_kapat(adim, "durduruldu", sonuc, "Kullanıcı durdurdu", gunluk)
                return "dur", None
            karar = sonuc.yapisal or json_cikar(sonuc.metin)
            if sonuc.ok and isinstance(karar, dict) and str(karar.get("karar", "")).upper() in ("ONAY", "DUZELT"):
                ham_bulgular = karar.get("bulgular") or []
                if not isinstance(ham_bulgular, list):
                    ham_bulgular = [ham_bulgular]
                karar = {"karar": str(karar["karar"]).upper(), "gerekce": str(karar.get("gerekce") or ""),
                         "bulgular": [str(b) for b in ham_bulgular if str(b).strip()][:8]}
                yol = self._inceleme_kaydet(fid, asama, v, kart, tur, adim, karar)
                durum = "onay" if karar["karar"] == "ONAY" else "duzelt"
                ozet = kisalt(karar["gerekce"], 160)
                if durum == "duzelt":
                    ozet = f"{len(karar['bulgular'])} bulgu · {ozet}"
                self._adim_kapat(adim, durum, sonuc, ozet, yol)
                return "ok", karar
            self._adim_kapat(adim, "takildi" if sonuc.zaman_asimi else "hata", sonuc,
                             sonuc.hata or "Karar (ONAY/DUZELT) okunamadı", gunluk)
            if sonuc.kalici_hata:
                break
            self._tekrar_oncesi_bekle(motor, deneme)
        return "hata", ((sonuc.hata if sonuc else "") or "karar okunamadı")

    # -------------------------------- istemler --------------------------------
    def _uretim_istemi(self, fid: str, asama: Asama, tur: int, geri_bildirim: Optional[str], dizin_modu: bool) -> str:
        p = [f"# Görev: {asama.ad}", "", asama.gorev or "-", "", "## Girdiler"]
        for g in asama.girdiler:
            p += ["", f"### {g}", self._belge_oku(fid, g) or "(bu belge henüz yok)"]
        if dizin_modu:
            kilitli = self._kilit_oku(fid)["yollar"]
            dosyalar = self._kod_dosyalari(fid)
            p += ["", "## Çalışma dizini",
                  "Şu an `kod/` klasöründesin. Bu klasörün dışına çıkma."]
            if asama.yazabilir:
                p.append("YAZMA ALANIN (yalnızca buraya yazabilirsin; dışındaki her değişiklik sistemce geri alınır "
                         "ve ihlal olarak kaydedilir): " + ", ".join(f"`{y}/`" for y in asama.yazabilir))
            if kilitli:
                p.append("KİLİTLİ (yalnızca okunur; değiştirirsen sistem geri alır ve ihlal olarak kaydeder): "
                         + ", ".join(f"`{k}`" for k in kilitli))
            p.append("Mevcut dosyalar: " + (", ".join(f"`{x}`" for x in dosyalar[:80]) if dosyalar else "(boş)"))
        if geri_bildirim:
            onceki = self._belge_oku(fid, asama.cikti) if asama.cikti else ""
            if dizin_modu:
                p += ["", "## Önceki çalışman", "Önceki turdaki dosyaların yerinde duruyor; onları güncelle."]
            elif onceki:
                p += ["", "## Önceki çıktın", onceki]
            p += ["", "## Düzeltme istekleri", geri_bildirim, "",
                  "Yalnızca bu isteklere göre düzelt; onaylanmış kısımları bozma."]
        p += ["", "## Çıktı"]
        if dizin_modu:
            p.append("İşin bitince son mesajında kısa bir özet yaz: ne yaptın, hangi dosyalar, testlerin son durumu.")
        else:
            p.append("Yalnızca istenen belgeyi markdown olarak yaz. Giriş ya da kapanış cümlesi ekleme.")
        return "\n".join(p)

    def _inceleme_istemi(self, fid: str, asama: Asama, v: Dogrulayici, tur: int, dizin_modu: bool) -> str:
        yazar = self.kartlar[asama.ajan]
        p = [f"# İnceleme: {asama.ad} (tur {tur})", "",
             f"Yazar: {yazar.ad}. Bu onay kurulunda senin odağın:",
             v.odak or "Çıktı, referans belgelerdeki gereksinimleri doğru ve eksiksiz karşılıyor mu?", ""]
        if dizin_modu:
            p += ["## İncelenen",
                  "Çalışma dizinindeki (`kod/`) dosyaları Read, Glob ve Grep ile oku. Dosya değiştiremezsin."]
            if asama.yazabilir:
                p.append("Yazarın yazma alanı: " + ", ".join(f"`{y}/`" for y in asama.yazabilir))
            p += ["", "### Yazarın özeti", self._belge_oku(fid, asama.cikti) or "-"]
            son_test = [s for s in self.depo.adimlar(fid) if s["asama_id"] == asama.id and s["tip"] == "kontrol"]
            if son_test:
                p += ["", "### Son test sonucu", son_test[-1]["ozet"] or "-"]
        else:
            p += ["## İncelenen belge", f"### {asama.cikti}", self._belge_oku(fid, asama.cikti) or "(boş)"]
        p += ["", "## Referans belgeler"]
        for g in asama.girdiler:
            p += ["", f"### {g}", self._belge_oku(fid, g) or "(yok)"]
        p += ["", "## Kararın",
              'Yalnızca JSON döndür: {"karar": "ONAY" | "DUZELT", "gerekce": "...", "bulgular": ["..."]}']
        return "\n".join(p)

    # --------------------------- yazma alanı ve kilitler ---------------------------
    @staticmethod
    def _gizli_mi(rel: Path) -> bool:
        return (any(parca in YOKSAY_KLASOR for parca in rel.parts) or rel.name in YOKSAY_DOSYA
                or rel.suffix in YOKSAY_UZANTI)

    def _agac(self, kok: Path) -> List[Path]:
        """kok altındaki dosyalar (göreli), yok sayılan klasörlere hiç girmeden."""
        sonuc: List[Path] = []
        if not kok.exists():
            return sonuc
        for dizin, altlar, dosyalar in os.walk(kok):
            altlar[:] = sorted(a for a in altlar if a not in YOKSAY_KLASOR)
            for ad in sorted(dosyalar):
                rel = (Path(dizin) / ad).relative_to(kok)
                if not self._gizli_mi(rel):
                    sonuc.append(rel)
        return sonuc

    def _agac_hash(self, kok: Path) -> Dict[str, str]:
        sonuc: Dict[str, str] = {}
        for rel in self._agac(kok):
            p = kok / rel
            if p.is_symlink():
                sonuc[rel.as_posix()] = "link:" + os.readlink(p)
            elif p.is_file():
                sonuc[rel.as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
        return sonuc

    def _on_kopya_al(self, fid: str) -> None:
        d = self.calisma / fid
        onceki = d / ".kovan" / "onceki"
        if onceki.exists():
            shutil.rmtree(onceki)
        shutil.copytree(d / "kod", onceki, symlinks=True,
                        ignore=shutil.ignore_patterns(*YOKSAY_KLASOR, *YOKSAY_DOSYA, "*.pyc", "*.pyo", "*.log"))

    def _alan_denetle(self, fid: str, asama: Asama, kart: AjanKarti) -> List[str]:
        """Yazma alanı dışındaki ve kilitli yollardaki değişiklikleri çalıştırma öncesine geri alır."""
        d = self.calisma / fid
        kod, onceki = d / "kod", d / ".kovan" / "onceki"
        if not onceki.exists():
            return []
        once, sonra = self._agac_hash(onceki), self._agac_hash(kod)
        degisen = sorted(k for k in set(once) | set(sonra) if once.get(k) != sonra.get(k))
        kilitli = self._kilit_oku(fid)["yollar"]
        ihlaller = []
        for rel in degisen:
            kilitte = any(_altinda(rel, y) for y in kilitli)
            alan_disi = bool(asama.yazabilir) and not any(_altinda(rel, y) for y in asama.yazabilir)
            if not (kilitte or alan_disi):
                continue
            ihlaller.append(f"{rel} ({'kilitli' if kilitte else 'alan dışı'})")
            hedef = kod / rel
            if hedef.is_dir() and not hedef.is_symlink():
                shutil.rmtree(hedef)
            elif hedef.is_symlink() or hedef.exists():
                hedef.unlink()
            if rel in once:
                hedef.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(onceki / rel, hedef, follow_symlinks=False)
        if not ihlaller:
            return []
        liste = ", ".join(ihlaller[:12]) + (f" (+{len(ihlaller) - 12})" if len(ihlaller) > 12 else "")
        not_ = f"{kart.ad} sınır dışına yazdı: {liste}. Sistem geri aldı."
        self._sistem_adimi(fid, asama, "Sınır ihlali", "ihlal", not_)
        alan = ", ".join(f"`{y}/`" for y in asama.yazabilir) or "kilitli olmayan her yer"
        return [f"### Sınır ihlali\n{not_}\nYazma alanın: {alan}. Kilitli: {', '.join(kilitli) or '-'}. "
                f"Bir test ya da tasarım yanlışsa değiştirme; son mesajında 'TEST ŞÜPHESİ:' diye gerekçesiyle yaz."]

    def _kilit_yolu(self, fid: str) -> Path:
        return self.calisma / fid / ".kovan" / "kilitler.json"

    def _kilit_oku(self, fid: str) -> dict:
        p = self._kilit_yolu(fid)
        if p.exists():
            try:
                veri = json.loads(p.read_text(encoding="utf-8"))
                return {"yollar": list(veri.get("yollar") or []), "hashler": dict(veri.get("hashler") or {})}
            except (json.JSONDecodeError, AttributeError):
                pass
        return {"yollar": [], "hashler": {}}

    def _kilit_yaz(self, fid: str, veri: dict) -> None:
        p = self._kilit_yolu(fid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(veri, ensure_ascii=False, indent=2), encoding="utf-8")

    def _hashle(self, kod: Path, yollar: List[str]) -> Dict[str, str]:
        tum = self._agac_hash(kod)
        return {k: v for k, v in tum.items() if any(_altinda(k, y) for y in yollar)}

    def _kilitle(self, fid: str, asama: Asama) -> None:
        d = self.calisma / fid
        kod = d / "kod"
        reg = self._kilit_oku(fid)
        yollar = sorted(set(reg["yollar"]) | set(asama.kilitle))
        hashler = self._hashle(kod, yollar)
        kopya = d / ".kovan" / "kilitli"
        if kopya.exists():
            shutil.rmtree(kopya)
        for rel in hashler:
            hedef = kopya / rel
            hedef.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(kod / rel, hedef, follow_symlinks=False)
        self._kilit_yaz(fid, {"yollar": yollar, "hashler": hashler})
        eksik = [y for y in asama.kilitle if not (kod / y).exists()]
        ozet = f"Kilitlendi: {', '.join(asama.kilitle)} ({len(hashler)} dosya, SHA-256)"
        if eksik:
            ozet += f" · bulunamayan: {', '.join(eksik)}"
        self._sistem_adimi(fid, asama, "Kilit", "kilit", ozet)

    def _kilit_kaldir(self, fid: str, yollar: List[str]) -> None:
        reg = self._kilit_oku(fid)
        if not any(y in reg["yollar"] for y in yollar):
            return
        kalan = [y for y in reg["yollar"] if y not in yollar]
        hashler = {k: v for k, v in reg["hashler"].items() if not any(_altinda(k, y) for y in yollar)}
        self._kilit_yaz(fid, {"yollar": kalan, "hashler": hashler})

    def _kilit_denetle(self, fid: str, asama: Asama, kart: AjanKarti) -> List[str]:
        """İkinci savunma hattı: kilit kaydındaki hash'lerle karşılaştırır (normalde _alan_denetle yakalar)."""
        reg = self._kilit_oku(fid)
        if not reg["yollar"]:
            return []
        d = self.calisma / fid
        kod, kopya = d / "kod", d / ".kovan" / "kilitli"
        simdiki = self._hashle(kod, reg["yollar"])
        eski = reg["hashler"]
        degisen = sorted(k for k in set(simdiki) | set(eski) if simdiki.get(k) != eski.get(k))
        if not degisen:
            return []
        for rel in degisen:
            hedef = kod / rel
            if rel in eski and (kopya / rel).exists():
                hedef.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(kopya / rel, hedef, follow_symlinks=False)
            elif hedef.is_symlink() or hedef.is_file():
                hedef.unlink()
        not_ = f"{kart.ad} kilitli dosyalara dokundu: {', '.join(degisen)}. Sistem dosyaları geri aldı."
        self._sistem_adimi(fid, asama, "Sınır ihlali", "ihlal", not_)
        return [f"### Sınır ihlali\n{not_} Kilitli dosyaları değiştirme."]

    # ------------------------------- yardımcılar -------------------------------
    def _ilerleme_alanlari(self, fid: str, akis: Akis, sonraki: int) -> dict:
        """Sonraki aşamaya geçiş. Aşama daha önce üretilmişse (geri dönüş sonrası) yeniden yazılmaz;
        yalnızca testler ve onay kurulu yeniden bakar. Sorun bulurlarsa normal döngü işler."""
        faz = "uret"
        if sonraki < len(akis.asamalar):
            a = akis.asamalar[sonraki]
            if a.tur == "ajan" and self._daha_once_uretildi(fid, a.id):
                faz = "dogrula"
                self._sistem_adimi(fid, a, "Yeniden doğrulama", "yeniden",
                                   "Önceki çıktı korunuyor; yalnızca testler ve onay kurulu yeniden bakıyor.")
        return {"asama_idx": sonraki, "tur": 1, "faz": faz, "ek_tur": 0, "geri_bildirim": None}

    def _daha_once_uretildi(self, fid: str, asama_id: str) -> bool:
        return any(s["asama_id"] == asama_id and s["tip"] == "uret" and s["durum"] == "tamam"
                   for s in self.depo.adimlar(fid))

    def _bekle(self, fid: str, asama: Optional[Asama], sebep: str, mesaj: str, secenekler: List[str],
               detay: Optional[str] = None) -> str:
        adim = self._sistem_adimi(fid, asama, "Seni bekliyor", "bekliyor", mesaj, kapat=False)
        b = {"sebep": sebep, "asama_id": asama.id if asama else None, "asama_ad": asama.ad if asama else None,
             "mesaj": mesaj, "secenekler": secenekler, "detay": detay, "adim_id": adim, "zaman": simdi()}
        if "geri_gonder" in secenekler:
            f = self.depo.fikir(fid)
            akis = self.akislar.get(f["profil"]) if f else None
            if akis and asama:
                idx = akis.indeks(asama.id)
                b["geri_hedefler"] = [{"id": a.id, "ad": a.ad} for a in akis.asamalar[:idx] if a.tur == "ajan"]
                b["varsayilan_hedef"] = asama.geri_donus or (b["geri_hedefler"][-1]["id"] if b["geri_hedefler"] else None)
        self.depo.fikir_guncelle(fid, durum="bekliyor", bekleme=json.dumps(b, ensure_ascii=False))
        return "bekle"

    def _tekrar_oncesi_bekle(self, motor, deneme: int) -> None:
        """Geçici hatalarda (yoğunluk, ağ) hemen tekrar denemek yerine kısa bir nefes."""
        if deneme < self.deneme_sayisi and getattr(motor, "tur", "") in ("claude", "ollama"):
            time.sleep(3)

    def _butce_asildi(self, fid: str) -> bool:
        f = self.depo.fikir(fid)
        return bool(f and f["butce_usd"] and float(f["maliyet_usd"] or 0) >= float(f["butce_usd"]))

    def _butce_beklemesi(self, fid: str, asama: Asama) -> str:
        f = self.depo.fikir(fid)
        return self._bekle(fid, asama, "butce",
                           f"Fikir bütçesi doldu: ${float(f['maliyet_usd']):.3f} / ${float(f['butce_usd']):.2f}. "
                           f"Abonelikte bu tutar faturalanmaz ama kullanım limitinden yer; yükün göstergesidir.",
                           ["butce_artir", "durdur"])

    def _durdur_uygula(self, fid: str) -> None:
        with self.kilit:
            self.durdur_istekleri.discard(fid)
        f = self.depo.fikir(fid)
        if f and f["durum"] == "durduruldu":
            return
        self.depo.fikir_guncelle(fid, durum="durduruldu", bitis=simdi())
        self._sistem_adimi(fid, None, "Durduruldu", "durduruldu", "Senin isteğinle durduruldu.")

    def _surec_cb(self, fid: str):
        def kaydet(p, bitti: bool = False):
            with self.kilit:
                kume = self.surecler.setdefault(fid, set())
                if bitti:
                    kume.discard(p)
                else:
                    kume.add(p)
        return kaydet

    def _sistem_adimi(self, fid: str, asama: Optional[Asama], baslik: str, durum: str, ozet: str,
                      kapat: bool = True) -> int:
        f = self.depo.fikir(fid)
        adim = self.depo.adim_ekle(fid, asama.id if asama else "-", asama.ad if asama else "-", "sistem",
                                   "-", baslik, int(f["tur"] or 1) if f else 1, 1, durum, ozet=kisalt(ozet, 300),
                                   motor="sistem")
        if kapat:
            self.depo.adim_guncelle(adim, bitis=simdi(), sure_sn=0)
        return adim

    def _adim_kapat(self, adim: int, durum: str, sonuc: Optional[AjanSonucu], ozet: str, dosya: str = "") -> None:
        alanlar = {"durum": durum, "bitis": simdi(), "ozet": kisalt(ozet or "", 300), "dosya": dosya}
        if sonuc is not None:
            alanlar.update(sure_sn=round(sonuc.sure_sn, 1), maliyet_usd=round(sonuc.maliyet, 4),
                           girdi_token=sonuc.girdi_token, cikti_token=sonuc.cikti_token,
                           ajan_turu=sonuc.tur_sayisi)
        self.depo.adim_guncelle(adim, **alanlar)
        if sonuc is not None and sonuc.izin_retleri:
            s = self.depo.adim(adim)
            if s:
                self._sistem_adimi(s["fikir_id"], Asama(id=s["asama_id"], ad=s["asama_ad"]), "İzin reddi", "uyari",
                                   f"{s['ajan_ad']} izinsiz {len(sonuc.izin_retleri)} çağrı denedi, sistem reddetti: "
                                   + ", ".join(sonuc.izin_retleri[:5]))

    def _belge_oku(self, fid: str, anahtar: Optional[str]) -> str:
        if not anahtar:
            return ""
        p = self.calisma / fid / "belgeler" / f"{anahtar}.md"
        return p.read_text(encoding="utf-8").strip() if p.exists() else ""

    def _belge_kaydet(self, fid: str, anahtar: str, metin: str, adim: int) -> str:
        d = self.calisma / fid / "belgeler"
        surumler = d / "_surumler"
        surumler.mkdir(parents=True, exist_ok=True)
        metin = metin.rstrip() + "\n"
        (d / f"{anahtar}.md").write_text(metin, encoding="utf-8")
        surum = surumler / f"{anahtar}-adim{adim}.md"
        surum.write_text(metin, encoding="utf-8")
        return surum.relative_to(self.calisma / fid).as_posix()

    def _inceleme_kaydet(self, fid: str, asama: Asama, v: Dogrulayici, kart: AjanKarti, tur: int,
                         adim: int, karar: dict) -> str:
        rel = f"incelemeler/{asama.id}-tur{tur}-{kart.id}-adim{adim}.md"
        satirlar = [f"# {v.ad}: {asama.ad}, tur {tur}", "", f"İnceleyen: {kart.ad}",
                    f"Karar: **{karar['karar']}**", "", f"Gerekçe: {karar.get('gerekce', '')}", "", "## Bulgular"]
        satirlar += [f"- {b}" for b in karar["bulgular"]] or ["- (yok)"]
        (self.calisma / fid / rel).write_text("\n".join(satirlar) + "\n", encoding="utf-8")
        return rel

    def _gunluk(self, fid: str, adim: int, motor, cagri: AjanCagrisi, sonuc: AjanSonucu) -> str:
        rel = f"gunluk/adim-{adim}.json"
        veri = {
            "adim": adim, "motor": getattr(motor, "ad", "?"), "rol": cagri.rol, "asama": cagri.asama_id,
            "gorev_turu": cagri.gorev_turu, "model": cagri.model, "araclar": cagri.araclar,
            "izinli": cagri.izinli, "cwd": cagri.cwd, "sure_siniri_sn": cagri.sure_sn,
            "sistem": cagri.sistem, "istem": cagri.istem,
            "sonuc": {
                "ok": sonuc.ok, "hata": sonuc.hata, "zaman_asimi": sonuc.zaman_asimi,
                "maliyet_usd": sonuc.maliyet, "girdi_token": sonuc.girdi_token,
                "cikti_token": sonuc.cikti_token, "tur_sayisi": sonuc.tur_sayisi,
                "sure_sn": round(sonuc.sure_sn, 2), "metin": sonuc.metin[:20000],
                "yapisal": sonuc.yapisal, "izin_retleri": sonuc.izin_retleri, "ham": sonuc.ham,
            },
        }
        if hasattr(motor, "komut"):
            try:
                veri["komut"] = [x if len(x) < 200 else x[:80] + " …" for x in motor.komut(cagri)]
            except Exception:
                pass
        (self.calisma / fid / rel).write_text(json.dumps(veri, ensure_ascii=False, indent=2), encoding="utf-8")
        return rel

    def _kod_dosyalari(self, fid: str) -> List[str]:
        kod = self.calisma / fid / "kod"
        return [r.as_posix() for r in self._agac(kod) if not r.name.startswith(".")]

    def _teslim_ozeti(self, fid: str) -> Optional[str]:
        dosyalar = self._kod_dosyalari(fid)
        adimlar = self.depo.adimlar(fid)
        satirlar = []
        testler: Dict[str, str] = {}
        for s in adimlar:
            if s["tip"] == "kontrol":
                testler[s["ajan_ad"]] = s["ozet"] or ""
        for ad, ozet in testler.items():
            satirlar.append(f"{ad}: {ozet}")
        notlar: Dict[str, str] = {}
        for s in adimlar:
            if s["tip"] == "inceleme" and s["durum"] in ("onay", "duzelt"):
                notlar[s["ajan_ad"]] = s["ozet"] or ""
        if notlar:
            satirlar.append("Onay kurulunun son notları:")
            satirlar += [f"  {ad}: {oz}" for ad, oz in notlar.items()]
        if dosyalar:
            satirlar.append("Kod dosyaları: " + ", ".join(dosyalar[:30]) + (" …" if len(dosyalar) > 30 else ""))
        return "\n".join(satirlar) or None

    def _dosya_listesi(self, fid: str) -> dict:
        d = self.calisma / fid

        def listele(alt: str) -> List[dict]:
            kok = d / alt
            if not kok.exists():
                return []
            sonuc = []
            for rel in self._agac(kok):
                yol = Path(alt) / rel
                if "_surumler" in yol.parts or yol.name.startswith("."):
                    continue
                try:
                    boyut = (d / yol).stat().st_size
                except OSError:
                    boyut = 0
                sonuc.append({"yol": yol.as_posix(), "boyut": boyut})
            return sonuc

        return {"belgeler": listele("belgeler"), "incelemeler": listele("incelemeler"), "kod": listele("kod")}
