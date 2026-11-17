"""Motorlar: ajan çağrısını gerçekten çalıştıran katman.

ClaudeMotoru : `claude -p` (Claude Code headless). Aboneliğinle çalışır.
DenemeMotoru : Token harcamadan akışı göstermek için sahte motor.

Yeni bir motor (Anthropic API, kurum içi LLM ...) eklemek için aynı arayüzü
(hazir, surum, hata, calistir(AjanCagrisi) -> AjanSonucu) uygulaman yeterli.
"""
from __future__ import annotations

import json
import os
import random
import re
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional

KARAR_SEMASI = {
    "type": "object",
    "properties": {
        "karar": {"type": "string", "enum": ["ONAY", "DUZELT"]},
        "gerekce": {"type": "string"},
        "bulgular": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["karar", "gerekce", "bulgular"],
    "additionalProperties": False,
}

YEDEK_JSON_TALIMATI = (
    "\n\nYanıtının EN SONUNA yalnızca şu biçimde bir JSON bloğu koy:\n"
    "```json\n{\"karar\": \"ONAY\" | \"DUZELT\", \"gerekce\": \"...\", \"bulgular\": [\"...\"]}\n```"
)


@dataclass
class AjanCagrisi:
    rol: str                      # kart id
    asama_id: str
    gorev_turu: str               # "uret" | "inceleme"
    sistem: str
    istem: str
    model: str
    araclar: List[str]
    izinli: List[str]
    cwd: str
    sure_sn: float
    sistem_modu: str = "degistir"
    butce_usd: Optional[float] = None
    sema: Optional[dict] = None
    efor: Optional[str] = None
    surec_cb: Optional[Callable] = None


@dataclass
class AjanSonucu:
    ok: bool
    metin: str = ""
    yapisal: Optional[dict] = None
    maliyet: float = 0.0
    girdi_token: int = 0
    cikti_token: int = 0
    tur_sayisi: int = 0
    sure_sn: float = 0.0
    hata: Optional[str] = None
    zaman_asimi: bool = False
    ham: str = ""
    izin_retleri: Optional[List[str]] = None   # ajanın denediği ama sistemin reddettiği araç çağrıları
    kalici_hata: bool = False                  # oturum yok, limit doldu, bütçe aşıldı: hemen tekrar denemenin anlamı yok


def _izin_retleri(veri: dict) -> List[str]:
    sonuc = []
    for r in veri.get("permission_denials") or []:
        if isinstance(r, dict):
            girdi = r.get("tool_input") or {}
            ayrinti = ""
            if isinstance(girdi, dict):
                ayrinti = girdi.get("command") or girdi.get("file_path") or girdi.get("path") or ""
            sonuc.append(f"{r.get('tool_name', '?')}" + (f"({kisalt(str(ayrinti), 80)})" if ayrinti else ""))
        else:
            sonuc.append(kisalt(str(r), 80))
    return sonuc


def kisalt(metin: str, n: int) -> str:
    metin = (metin or "").strip()
    return metin if len(metin) <= n else metin[: n - 1] + "…"


def json_cikar(metin: str) -> Optional[dict]:
    """Serbest metnin içinden 'karar' içeren son JSON nesnesini bulur."""
    if not metin:
        return None
    # Önce ```json blokları (sondan başa), yoksa dengeli süslü parantezler (sondan başa)
    adaylar = list(reversed(re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", metin, re.DOTALL)))
    if not adaylar:
        derinlik, son = 0, None
        for i in range(len(metin) - 1, -1, -1):
            c = metin[i]
            if c == "}":
                if derinlik == 0:
                    son = i
                derinlik += 1
            elif c == "{" and derinlik:
                derinlik -= 1
                if derinlik == 0 and son is not None:
                    adaylar.append(metin[i: son + 1])
                    son = None
    for aday in adaylar:
        try:
            veri = json.loads(aday)
        except json.JSONDecodeError:
            continue
        if isinstance(veri, dict) and "karar" in veri:
            return veri
    return None


def sureci_oldur(p: subprocess.Popen) -> None:
    """Süreci ve açtığı alt süreçleri (aynı süreç grubu) kapatır."""
    try:
        os.killpg(p.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        return
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass


KALICI_ONEK = "[kalıcı] "


def _dostca_hata(metin: str) -> Optional[str]:
    """Bilinen hata metinlerini anlaşılır Türkçeye çevirir. Kalıcı olanlar KALICI_ONEK ile başlar."""
    k = (metin or "").lower()
    if any(s in k for s in ("please run /login", "not logged in", "invalid api key", "authentication", "oauth")):
        return KALICI_ONEK + "claude oturumu açık değil. Terminal'de bir kez `claude` yazıp giriş yap, sonra 'Tekrar dene'."
    if any(s in k for s in ("usage limit", "limit reached", "credit balance")):
        return KALICI_ONEK + "Abonelik kullanım limitine takıldı. Limit sıfırlanınca 'Tekrar dene'."
    if any(s in k for s in ("rate limit", "rate_limit", "overloaded")):
        return "Anlık yoğunluk/hız limiti. Kısa bir süre sonra tekrar denenecek."
    return None


def _kalici_ayikla(mesaj: Optional[str]):
    if mesaj and mesaj.startswith(KALICI_ONEK):
        return mesaj[len(KALICI_ONEK):], True
    return mesaj, False


class ClaudeMotoru:
    ad = "claude"
    tur = "claude"
    yerel = False
    yapisal_destek = True      # --json-schema ile yapısal çıktı
    YEDEK_YOLLAR = [
        "~/.claude/local/claude", "~/.local/bin/claude", "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude", "~/.npm-global/bin/claude",
    ]

    def __init__(self, yol: str = "claude", api_anahtarini_yoksay: bool = True):
        self.api_anahtarini_yoksay = api_anahtarini_yoksay
        self.yol = self._bul(yol)
        self.yardim = ""
        self.surum = ""
        self.hazir = False
        self.hata: Optional[str] = None
        if not self.yol:
            self.hata = ("claude komutu bulunamadı. Claude Code kurulu mu? Kuruluysa kovan.yaml'da "
                         "claude_yolu alanına tam yolunu yaz (Terminal'de: which claude).")
            return
        try:
            self.surum = subprocess.run([self.yol, "--version"], capture_output=True, text=True,
                                        timeout=60, env=self._env()).stdout.strip()
            self.yardim = subprocess.run([self.yol, "--help"], capture_output=True, text=True,
                                         timeout=60, env=self._env()).stdout
            self.hazir = "--print" in self.yardim
            if not self.hazir:
                self.hata = "claude --help çıktısında --print yok; Claude Code güncel mi?"
        except (OSError, subprocess.TimeoutExpired) as e:
            self.hata = f"claude çalıştırılamadı: {e}"

    def _bul(self, yol: str) -> Optional[str]:
        if os.sep in yol or yol.startswith("~"):
            p = Path(yol).expanduser()
            return str(p) if p.exists() else None
        bulunan = shutil.which(yol)
        if bulunan:
            return bulunan
        for aday in self.YEDEK_YOLLAR:
            p = Path(aday).expanduser()
            if p.exists():
                return str(p)
        return None

    # Claude Code'u başka bir sunucuya/anahtara yönlendiren değişkenler. Ollama rehberleri bunları
    # ~/.zshrc'ye yazdırır; o zaman "Claude" ajanları da sessizce yerel modele giderdi.
    YONLENDIRME = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
                   "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                   "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL")

    def _env(self) -> dict:
        env = dict(os.environ)
        if self.api_anahtarini_yoksay:
            for ad in self.YONLENDIRME:
                env.pop(ad, None)
        return env

    def var(self, bayrak: str) -> bool:
        """Yüklü claude sürümü bu bayrağı destekliyor mu? (--help çıktısına bakar)"""
        return re.search(re.escape(bayrak) + r"(?![\w-])", self.yardim) is not None

    def saglik(self, zorla: bool = False) -> bool:
        return self.hazir

    def model_sec(self, kart) -> str:
        return kart.model

    def durum_ozeti(self) -> dict:
        return {"hazir": self.saglik(), "surum": self.surum, "hata": self.hata, "yol": self.yol,
                "tur": self.tur, "yerel": self.yerel, "model": None}

    def komut(self, c: AjanCagrisi) -> List[str]:
        k = [self.yol or "claude", "-p", "--output-format", "json", "--model", c.model]
        if c.sistem_modu == "degistir" and self.var("--system-prompt"):
            k += ["--system-prompt", c.sistem]
        else:
            k += ["--append-system-prompt", c.sistem]

        if self.var("--tools"):
            k += ["--tools", ",".join(c.araclar)]          # "" -> hiç araç yok
        elif not c.araclar:
            k += ["--disallowedTools", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit",
                  "WebFetch", "WebSearch"]
        if c.izinli:
            k += ["--allowedTools", *c.izinli]
        if any(a in ("Write", "Edit", "MultiEdit") for a in c.araclar):
            k += ["--permission-mode", "acceptEdits"]       # sadece çalışma dizinindeki düzenlemeler
        if self.var("--permission-prompts"):
            k += ["--permission-prompts", "none"]           # izin isteyen her şey otomatik reddedilir
        if self.var("--no-session-persistence"):
            k += ["--no-session-persistence"]               # /resume listen ajan oturumlarıyla dolmasın
        if c.butce_usd and self.var("--max-budget-usd"):
            k += ["--max-budget-usd", f"{c.butce_usd:.2f}"]
        if c.sema and self.yapisal_destek and self.var("--json-schema"):
            k += ["--json-schema", json.dumps(c.sema, ensure_ascii=False)]
        if c.efor and self.var("--effort"):
            k += ["--effort", c.efor]
        return k

    def calistir(self, c: AjanCagrisi) -> AjanSonucu:
        if not self.saglik():
            return AjanSonucu(ok=False, hata=self.hata or f"{self.ad} hazır değil", kalici_hata=True)
        istem = c.istem
        if c.sema and not (self.yapisal_destek and self.var("--json-schema")):
            istem += YEDEK_JSON_TALIMATI
        t0 = time.time()
        try:
            p = subprocess.Popen(
                self.komut(c), cwd=c.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                env=self._env(), start_new_session=True,
            )
        except OSError as e:
            return AjanSonucu(ok=False, hata=f"claude başlatılamadı: {e}")
        if c.surec_cb:
            c.surec_cb(p)
        try:
            cikti, hata = p.communicate(input=istem, timeout=c.sure_sn)
        except subprocess.TimeoutExpired:
            sureci_oldur(p)
            try:
                p.communicate(timeout=5)
            except (subprocess.TimeoutExpired, ValueError):
                pass
            return AjanSonucu(ok=False, zaman_asimi=True, sure_sn=time.time() - t0,
                              hata=f"Süre sınırı aşıldı ({int(c.sure_sn)} sn); süreç durduruldu")
        finally:
            if c.surec_cb:
                c.surec_cb(p, True)
        return self._coz(cikti, hata, p.returncode, time.time() - t0)

    def _coz(self, cikti: str, hata: str, kod: int, sure: float) -> AjanSonucu:
        s = (cikti or "").strip()
        veri = None
        if s:
            try:
                veri = json.loads(s)
            except json.JSONDecodeError:
                for satir in reversed(s.splitlines()):
                    try:
                        veri = json.loads(satir)
                        break
                    except json.JSONDecodeError:
                        continue
        if isinstance(veri, list):
            veri = next((m for m in reversed(veri) if isinstance(m, dict) and m.get("type") == "result"), None)
        if not isinstance(veri, dict):
            if kod is not None and kod < 0:
                return AjanSonucu(ok=False, sure_sn=sure, hata="Süreç durduruldu")
            neden, kalici = _kalici_ayikla(_dostca_hata((hata or "") + s))
            neden = neden or kisalt(hata or s or "boş çıktı", 600)
            return AjanSonucu(ok=False, sure_sn=sure, ham=(s or hata or "")[-4000:], kalici_hata=kalici,
                              hata=f"claude çıktısı okunamadı (çıkış kodu {kod}): {neden}")

        kullanim = veri.get("usage") or {}
        girdi = sum(int(kullanim.get(k) or 0) for k in
                    ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        metin = veri.get("result")
        if not isinstance(metin, str):
            metin = "" if metin is None else json.dumps(metin, ensure_ascii=False)
        yapisal = veri.get("structured_output")
        ok = (kod == 0) and not veri.get("is_error")
        hata_metni, kalici = None, False
        if not ok:
            alt = str(veri.get("subtype") or "")
            if alt == "error_max_budget_usd":
                hata_metni, kalici = "Adım bütçesi aşıldı (kartta butce_usd). Kartı büyütüp 'Tekrar dene'.", True
            elif alt == "error_max_turns":
                hata_metni = "Ajan tur sınırına takıldı"
            else:
                hata_metni, kalici = _kalici_ayikla(_dostca_hata(metin + (hata or "")))
                hata_metni = hata_metni or kisalt(metin or hata or alt or "hata", 600)
        return AjanSonucu(
            kalici_hata=kalici,
            ok=ok, metin=metin, yapisal=yapisal if isinstance(yapisal, dict) else None,
            maliyet=float(veri.get("total_cost_usd") or veri.get("cost_usd") or 0.0),
            girdi_token=girdi, cikti_token=int(kullanim.get("output_tokens") or 0),
            tur_sayisi=int(veri.get("num_turns") or 0), sure_sn=sure, hata=hata_metni, ham=s[-4000:],
            izin_retleri=_izin_retleri(veri),
        )


# --------------------------------------------------------------------------------------
# Yerel model: aynı `claude -p` harness'ı (araçlar, izinler, yazma alanı aynen geçerli),
# ama model Ollama'da çalışır. Ollama 0.14+ Anthropic Messages API'sini konuşur.
# --------------------------------------------------------------------------------------

def _surum_tuple(s: str):
    parcalar = re.findall(r"\d+", s or "")[:3]
    return tuple(int(x) for x in parcalar) + (0,) * (3 - len(parcalar))


class OllamaMotoru(ClaudeMotoru):
    tur = "ollama"
    yerel = True
    yapisal_destek = False     # yerel modellerde --json-schema'ya güvenmiyoruz; metinden JSON okunur
    EN_DUSUK_SURUM = (0, 14, 0)

    def __init__(self, ad: str, adres: str, model: str, claude_yolu: str = "claude"):
        # super().__init__ içinde _env() çağrıldığı için alanlar önce atanır
        self.ad = ad
        self.adres = adres.rstrip("/")
        self.model = model
        self.ollama_surum: Optional[str] = None
        self._son_kontrol = 0.0
        super().__init__(claude_yolu, api_anahtarini_yoksay=True)
        self.claude_hazir, self.claude_hata = self.hazir, self.hata
        self.saglik(zorla=True)

    def _env(self) -> dict:
        env = dict(os.environ)
        env.update({
            "ANTHROPIC_BASE_URL": self.adres,
            "ANTHROPIC_AUTH_TOKEN": "ollama",
            "ANTHROPIC_API_KEY": "",
            # Claude Code arka planda başka model isterse o da yerel modele gitsin
            "ANTHROPIC_DEFAULT_OPUS_MODEL": self.model,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": self.model,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": self.model,
            "ANTHROPIC_SMALL_FAST_MODEL": self.model,
            "CLAUDE_CODE_SUBAGENT_MODEL": self.model,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        })
        return env

    def _getir(self, yol: str, zaman: float = 3.0) -> dict:
        import urllib.request
        acici = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # localhost: vekil sunucu yok
        with acici.open(self.adres + yol, timeout=zaman) as yanit:
            return json.loads(yanit.read().decode("utf-8"))

    def saglik(self, zorla: bool = False) -> bool:
        if not zorla and time.time() - self._son_kontrol < 10:
            return self.hazir
        self._son_kontrol = time.time()
        self.hazir, self.hata = False, None
        if not getattr(self, "claude_hazir", False):
            self.hata = self.claude_hata or "claude komutu hazır değil"
            return False
        try:
            self.ollama_surum = str(self._getir("/api/version").get("version") or "")
        except Exception:
            self.hata = f"Ollama'ya ulaşılamadı ({self.adres}). Ollama uygulamasını aç."
            return False
        if _surum_tuple(self.ollama_surum) < self.EN_DUSUK_SURUM:
            self.hata = (f"Ollama {self.ollama_surum} eski. Claude Code uyumluluğu için 0.14 veya üstü gerekli; "
                         f"Ollama'yı güncelle.")
            return False
        try:
            modeller = self._getir("/api/tags").get("models") or []
        except Exception as e:
            self.hata = f"Ollama model listesi alınamadı: {e}"
            return False
        adlar = {str(m.get(k)) for m in modeller for k in ("name", "model") if m.get(k)}
        if self.model not in adlar and f"{self.model}:latest" not in adlar:
            self.hata = f"Model indirilmemiş: Terminal'de `ollama pull {self.model}`"
            return False
        self.hazir = True
        return True

    def model_sec(self, kart) -> str:
        return getattr(kart, "yerel_model", None) or self.model

    def komut(self, c: AjanCagrisi) -> List[str]:
        from dataclasses import replace
        return super().komut(replace(c, butce_usd=None, efor=None))   # yerelde $ bütçe ve efor anlamsız

    def _coz(self, cikti: str, hata: str, kod: int, sure: float) -> AjanSonucu:
        s = super()._coz(cikti, hata, kod, sure)
        s.maliyet = 0.0                                                  # yerel çıkarım: API maliyeti yok
        if not s.ok and s.hata:
            k = (s.hata + " " + (hata or "")).lower()
            if any(x in k for x in ("econnrefused", "connection error", "fetch failed", "unable to connect",
                                    "connection refused", "socket")):
                s.hata, s.kalici_hata = f"Ollama'ya bağlanılamadı ({self.adres}). Ollama açık mı?", True
            elif "not found" in k and "model" in k:
                s.hata, s.kalici_hata = f"Model bulunamadı: `ollama pull {self.model}`", True
        return s

    def durum_ozeti(self) -> dict:
        ozet = super().durum_ozeti()
        ozet.update(model=self.model, adres=self.adres, ollama_surum=self.ollama_surum)
        return ozet


# --------------------------------------------------------------------------------------
# Deneme motoru: gerçek ajan çalışmaz; döngüleri (DÜZELT, kırmızı test) göstermek için
# önceden tanımlı davranır. Maliyetler temsilidir.
# --------------------------------------------------------------------------------------

_DENEME_BE_TEST = """import unittest

from backend import sulama


class BeKabulTestleri(unittest.TestCase):
    \"\"\"Deneme modu BE testleri (TS-BE-1, TS-BE-2).\"\"\"

    def test_be1_sonraki_sulama_tarihi(self):
        self.assertEqual(sulama.sonraki_sulama("2026-11-17", 7), "2026-11-24")

    def test_be2_gecersiz_aralik_reddedilir(self):
        with self.assertRaises(ValueError):
            sulama.sonraki_sulama("2026-11-17", 0)
"""

_DENEME_FE_TEST = """import unittest
from pathlib import Path

KOK = Path(__file__).resolve().parents[2]


class FeKabulTestleri(unittest.TestCase):
    \"\"\"Deneme modu FE testleri (TS-FE-1, TS-FE-2). Gerçek modda Playwright testleri yazılır.\"\"\"

    def setUp(self):
        self.html = (KOK / "frontend" / "index.html").read_text(encoding="utf-8")

    def test_fe1_bugun_listesi_var(self):
        self.assertIn('id="bugun-listesi"', self.html)

    def test_fe2_hata_mesaji_alani_var(self):
        self.assertIn('id="hata"', self.html)
"""

_DENEME_SH = '#!/bin/bash\ncd "$(dirname "$0")"\npython3 -m unittest discover -s testler/{taraf} -t . -v\n'

_DENEME_BE_HATALI = """from datetime import date


def sonraki_sulama(son_sulama, aralik_gun):
    if aralik_gun <= 0:
        raise ValueError("Sulama aralığı en az 1 gün olmalı")
    return date.fromisoformat(son_sulama).isoformat()   # deneme: ilk turda bilerek hatalı (aralık eklenmedi)
"""

_DENEME_BE_DOGRU = """from datetime import date, timedelta


def sonraki_sulama(son_sulama, aralik_gun):
    \"\"\"Son sulama tarihine aralığı ekler; geçersiz aralığı reddeder.\"\"\"
    if aralik_gun <= 0:
        raise ValueError("Sulama aralığı en az 1 gün olmalı")
    return (date.fromisoformat(son_sulama) + timedelta(days=aralik_gun)).isoformat()
"""

_DENEME_FE = """<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>Flora AI · bakım paneli (deneme)</title></head>
<body>
  <main>
    <h1>Bitkilerim</h1>
    <label for="bitki-adi">Bitki adı</label> <input id="bitki-adi" type="text">
    <label for="aralik">Sulama aralığı (gün)</label> <input id="aralik" type="number" min="1">
    <button id="kaydet">Kaydet</button>
    {hata}
    <h2>Bugün sulanacaklar</h2>
    <ul id="bugun-listesi"></ul>
  </main>
</body>
</html>
"""

_DENEME_PROTOTIP = """<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><title>Flora AI · prototip (deneme)</title>
<style>body{font-family:system-ui;margin:40px;max-width:640px}section{border:1px solid #ccc;border-radius:8px;padding:16px;margin:12px 0}
.hata{color:#a8231b}</style></head>
<body>
  <h1>Flora AI · prototip (deneme modu)</h1>
  <section id="ekran-1"><h2>Ekran 1 · Bugün sulanacaklar</h2><p>Bitki kartları: ad, tür, son sulama, "Suladım" düğmesi. Liste boşsa: "Bugün sulanacak bitki yok."</p>
    <a href="#ekran-2">+ Bitki ekle →</a></section>
  <section id="ekran-2"><h2>Ekran 2 · Bitki ekle</h2><p>Ad, tür, sulama aralığı (gün), son sulama tarihi.</p>
    <p class="hata">Hata durumu: "Bitki adı boş olamaz."</p><a href="#ekran-1">← Bitkilerim</a></section>
</body>
</html>
"""


class DenemeMotoru:
    ad = "deneme"
    tur = "deneme"
    yerel = False
    hazir = True
    surum = "deneme (sahte motor)"
    hata = None

    def __init__(self, gecikme_sn: float = 1.0):
        self.gecikme = max(0.0, float(gecikme_sn))

    def saglik(self, zorla: bool = False) -> bool:
        return True

    def model_sec(self, kart) -> str:
        return "deneme"

    def durum_ozeti(self) -> dict:
        return {"hazir": True, "surum": self.surum, "hata": None, "yol": None, "tur": self.tur,
                "yerel": False, "model": "deneme"}

    def calistir(self, c: AjanCagrisi) -> AjanSonucu:
        t0 = time.time()
        time.sleep(self.gecikme * random.uniform(0.6, 1.3))
        if c.gorev_turu == "inceleme":
            yapisal = self._incele(c)
            metin = json.dumps(yapisal, ensure_ascii=False)
        else:
            yapisal = None
            metin = self._uret(c)
        girdi = (len(c.sistem) + len(c.istem)) // 4
        cikti = max(60, len(metin) // 4)
        maliyet = girdi * 3 / 1_000_000 + cikti * 15 / 1_000_000
        return AjanSonucu(ok=True, metin=metin, yapisal=yapisal, maliyet=round(maliyet, 4),
                          girdi_token=girdi, cikti_token=cikti, tur_sayisi=4 if c.araclar else 1,
                          sure_sn=time.time() - t0)

    @staticmethod
    def _isaret(asama_id: str) -> str:
        return f".deneme-duzeltildi-{asama_id}"

    def _incele(self, c: AjanCagrisi) -> dict:
        cwd = Path(c.cwd)
        if cwd.name == "kod":
            duzeltildi = any(cwd.rglob(self._isaret(c.asama_id)))
        else:
            duzeltildi = "(düzeltildi)" in c.istem.split("## Referans belgeler", 1)[0]
        if c.asama_id in ("analiz", "be-gelistirme") and c.rol in ("urun-sahibi", "mimar") and not duzeltildi:
            return {"karar": "DUZELT",
                    "gerekce": "Deneme modu: döngüyü göstermek için bir düzeltme istiyorum.",
                    "bulgular": ["Geçersiz sulama aralığı (0 ya da negatif) için hata davranışı açıkça yazılmamış."]}
        return {"karar": "ONAY", "gerekce": "Deneme modu: kriterler karşılanıyor.", "bulgular": []}

    def _uret(self, c: AjanCagrisi) -> str:
        geri_bildirim_var = "## Düzeltme istekleri" in c.istem
        geri_bildirim = c.istem.split("## Düzeltme istekleri", 1)[1] if geri_bildirim_var else ""
        cwd = Path(c.cwd)

        def yaz(rel: str, metin: str) -> None:
            hedef = cwd / rel
            hedef.parent.mkdir(parents=True, exist_ok=True)
            hedef.write_text(metin, encoding="utf-8")

        if cwd.name == "kod":
            if c.rol == "test-otomasyon":
                yaz("testler/__init__.py", "")
                yaz("testler/be/__init__.py", "")
                yaz("testler/be/test_be.py", _DENEME_BE_TEST)
                yaz("test-be.sh", _DENEME_SH.format(taraf="be"))
                satir = "| test_be1_sonraki_sulama_tarihi | TS-BE-1 |\n| test_be2_gecersiz_aralik_reddedilir | TS-BE-2 |"
                if "test-fe.sh" in c.istem:
                    yaz("testler/fe/__init__.py", "")
                    yaz("testler/fe/test_fe.py", _DENEME_FE_TEST)
                    yaz("test-fe.sh", _DENEME_SH.format(taraf="fe"))
                    satir += "\n| test_fe1_bugun_listesi_var | TS-FE-1 |\n| test_fe2_hata_mesaji_alani_var | TS-FE-2 |"
                return ("Deneme modu: otomatik testleri yazdım (şu an kırmızı, uygulama henüz yok).\n\n"
                        "| Test | Senaryo |\n|---|---|\n" + satir)
            if c.rol == "ux-tasarimci":
                yaz("tasarim/akislar.md", "# Akışlar (deneme)\n\n1. Bitkilerim → 2. Bitki ekle\n\nDurumlar: boş liste, hata, kayıt başarılı.\n"
                    "\n## Arayüz sözleşmesi\n- bitki-adi, aralik, kaydet, hata, bugun-listesi\n")
                yaz("tasarim/prototip.html", _DENEME_PROTOTIP)
                return "Deneme modu: tasarim/akislar.md ve tıklanabilir tasarim/prototip.html hazır."
            if c.rol in ("be-yazilimci", "fe-yazilimci"):
                alan = "backend" if c.rol == "be-yazilimci" else "frontend"
                if os.environ.get("KOVAN_DENEME_IHLAL") and not geri_bildirim_var:
                    for hedef in cwd.glob("testler/*/test_*.py"):
                        hedef.write_text(hedef.read_text(encoding="utf-8") + "\n# testi gevşettim\n", encoding="utf-8")
                    yaz("notlar.txt", "yazma alanı dışı")
                ilk_tur = not geri_bildirim_var
                if alan == "backend":
                    yaz("backend/__init__.py", "")
                    yaz("backend/sulama.py", _DENEME_BE_HATALI if ilk_tur else _DENEME_BE_DOGRU)
                else:
                    hata_alani = "" if ilk_tur else '<p id="hata" role="alert"></p>'
                    yaz("frontend/index.html", _DENEME_FE.format(hata=hata_alani))
                if not ilk_tur and ": KIRMIZI" not in geri_bildirim:
                    yaz(f"{alan}/{self._isaret(c.asama_id)}", "1")
                return (f"Deneme modu: {alan}/ yazıldı"
                        + (" (ilk tur, bilerek hatalı)." if ilk_tur else ", düzeltme istekleri uygulandı."))

        fikir = ""
        m = re.search(r"### fikir\n(.*?)(?=\n### |\n## |\Z)", c.istem, re.DOTALL)
        if m:
            fikir = m.group(1).strip()
        satirlar = [f"# {c.asama_id} (deneme)", "", "> Bu belgeyi sahte motor üretti; gerçek bir ajan çalışmadı.",
                    "", "## Özet", kisalt(fikir, 300) or "-", "", "## Maddeler",
                    "- K1: Bir sonraki sulama tarihi doğru hesaplanır.", "- K2: Geçersiz sulama aralığı reddedilir."]
        if c.rol == "test-analisti":
            satirlar += ["", "## Test senaryoları", "| ID | Taraf | Senaryo | Beklenen |", "|---|---|---|---|",
                         "| TS-BE-1 | BE | Son sulama + 7 gün | doğru tarih |", "| TS-BE-2 | BE | Aralık 0 | ValueError |",
                         "| TS-FE-1 | FE | Bugün sulanacaklar listesi | görünür |", "| TS-FE-2 | FE | Boş bitki adı | hata mesajı |"]
        if geri_bildirim_var:
            satirlar += ["", "(düzeltildi) Düzeltme istekleri uygulandı."]
        return "\n".join(satirlar)
