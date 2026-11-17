"""FastAPI sunucusu: tarayıcı arayüzü + JSON API. Yalnızca 127.0.0.1'de dinler."""
from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from . import SURUM, cards, config, pipelines
from .engine import ClaudeMotoru, DenemeMotoru, OllamaMotoru
from .orchestrator import Orkestrator
from .store import Depo

# Ajanların ürettiği HTML (prototip, frontend) Kovan'ın kendi kökeninden yalıtılır:
# betikleri çalışır ama Kovan API'sine Kovan adına istek atamaz.
ONIZLEME_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals"


def uygulama_kur(kok: Path) -> FastAPI:
    cfg = config.yukle(kok)
    kartlar = cards.yukle(kok / "ajanlar")
    akislar = pipelines.yukle(kok / "akislar", kartlar)
    calisma = Path(cfg["calisma_dizini"]).expanduser() if cfg.get("calisma_dizini") else kok / "calisma"
    calisma.mkdir(parents=True, exist_ok=True)

    motorlar = {
        "claude": ClaudeMotoru(str(cfg["claude_yolu"]), bool(cfg["api_anahtarini_yoksay"])),
        "deneme": DenemeMotoru(float(cfg["deneme_gecikme_sn"])),
    }
    for ad, m in cfg["motorlar"].items():
        motorlar[ad] = OllamaMotoru(ad, str(m["adres"]), str(m["model"]), str(cfg["claude_yolu"]))
    depo = Depo(calisma / "kovan.db")
    ork = Orkestrator(calisma, cfg, depo, kartlar, akislar, motorlar)

    app = FastAPI(title="Kovan", version=SURUM, docs_url=None, redoc_url=None)
    app.state.cfg = cfg
    app.state.ork = ork
    app.state.motorlar = motorlar
    ui = kok / "ui" / "index.html"
    port = int(cfg["port"])
    izinli_kokenler = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}

    @app.middleware("http")
    async def koken_denetimi(request: Request, call_next):
        # Tarayıcında açık başka bir sitenin localhost'a istek atıp fikir başlatmasını/onay vermesini engeller.
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            koken = request.headers.get("origin")
            if koken is not None and koken not in izinli_kokenler:
                return JSONResponse(status_code=403, content={"detail": f"İzin verilmeyen köken: {koken}"})
        return await call_next(request)

    def bulunamadi(fid: str):
        return HTTPException(404, f"Fikir bulunamadı: {fid}")

    @app.get("/", response_class=HTMLResponse)
    def ana_sayfa():
        return HTMLResponse(ui.read_text(encoding="utf-8"), headers={"Cache-Control": "no-store"})

    @app.get("/api/durum")
    def durum():
        return {
            "surum": SURUM,
            "varsayilan_motor": cfg["motor"],
            "calisma": str(calisma),
            "paralel_fikir": cfg["paralel_fikir"],
            "paralel_inceleme": cfg["paralel_inceleme"],
            "motorlar": {ad: m.durum_ozeti() for ad, m in motorlar.items()},
        }

    @app.get("/api/ajanlar")
    def ajanlar():
        sonuc = []
        for k in kartlar.values():
            o = k.ozet()
            m = motorlar.get(k.motor)
            o["motor_modeli"] = m.model_sec(k) if m else k.model
            o["motor_yerel"] = bool(getattr(m, "yerel", False))
            o["uretir"] = [f"{a.ad} ({ak.ad})" for ak in akislar.values() for a in ak.asamalar if a.ajan == k.id]
            o["onaylar"] = [f"{a.ad} ({ak.ad})" for ak in akislar.values() for a in ak.asamalar
                            if any(v.inceleyen == k.id for v in a.dogrulama)]
            sonuc.append(o)
        return sonuc

    @app.get("/api/akislar")
    def akis_listesi():
        return [a.ozet(kartlar) for a in akislar.values()]

    @app.get("/api/fikirler")
    def fikirler():
        return ork.fikir_listesi()

    @app.post("/api/fikirler")
    def fikir_olustur(govde: dict = Body(...)):
        try:
            fid = ork.yeni_fikir(str(govde.get("baslik") or ""), str(govde.get("metin") or ""),
                                 str(govde.get("profil") or ""), str(govde.get("motor") or cfg["motor"]))
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"id": fid}

    @app.get("/api/fikirler/{fid}")
    def fikir(fid: str):
        try:
            return ork.fikir_detayi(fid)
        except KeyError:
            raise bulunamadi(fid)

    @app.get("/api/fikirler/{fid}/dosya")
    def dosya(fid: str, yol: str):
        if not depo.fikir(fid):
            raise bulunamadi(fid)
        try:
            return ork.dosya_oku(fid, yol)
        except PermissionError as e:
            raise HTTPException(403, str(e))
        except FileNotFoundError:
            raise HTTPException(404, f"Dosya yok: {yol}")

    @app.get("/onizle/{fid}/{yol:path}")
    def onizle(fid: str, yol: str):
        """Ajanların ürettiği kod/ altındaki dosyaları tarayıcıda açar (prototip, statik frontend)."""
        if not depo.fikir(fid):
            raise bulunamadi(fid)
        if not (yol == "kod" or yol.startswith("kod/")):
            raise HTTPException(403, "Yalnızca kod/ altı önizlenebilir.")
        try:
            p = ork.dosya_yolu(fid, yol)
        except PermissionError as e:
            raise HTTPException(403, str(e))
        except FileNotFoundError:
            raise HTTPException(404, f"Dosya yok: {yol}")
        tur = mimetypes.guess_type(p.name)[0] or "text/plain"
        if tur.startswith("text/") and "charset" not in tur:
            tur += "; charset=utf-8"
        return FileResponse(p, media_type=tur, headers={"Content-Security-Policy": ONIZLEME_CSP,
                                                        "Cache-Control": "no-store"})

    @app.post("/api/fikirler/{fid}/karar")
    def karar(fid: str, govde: dict = Body(...)):
        try:
            ork.karar_ver(fid, str(govde.get("secim") or ""), str(govde.get("not") or ""),
                          str(govde.get("hedef") or "") or None)
        except KeyError:
            raise bulunamadi(fid)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"ok": True}

    @app.post("/api/fikirler/{fid}/durdur")
    def durdur(fid: str):
        try:
            ork.durdur(fid)
        except KeyError:
            raise bulunamadi(fid)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"ok": True}

    @app.post("/api/fikirler/{fid}/devam")
    def devam(fid: str):
        try:
            ork.devam_ettir(fid)
        except KeyError:
            raise bulunamadi(fid)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"ok": True}

    @app.exception_handler(Exception)
    def beklenmeyen(_, exc: Exception):
        return JSONResponse(status_code=500, content={"detail": f"Beklenmeyen hata: {exc}"})

    return app
