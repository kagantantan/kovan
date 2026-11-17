"""python3 -m kovan  -> sunucuyu başlatır (http://127.0.0.1:8765)."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(prog="kovan", description="Kovan ajan takımı sunucusu")
    ap.add_argument("--port", type=int, help="port (varsayılan: kovan.yaml'daki port)")
    ap.add_argument("--deneme", action="store_true", help="yeni fikirlerde varsayılan motor: deneme")
    args = ap.parse_args()
    if args.port:
        os.environ["KOVAN_PORT"] = str(args.port)
    if args.deneme:
        os.environ["KOVAN_MOTOR"] = "deneme"

    import uvicorn

    from .server import uygulama_kur

    kok = Path(__file__).resolve().parent.parent
    try:
        app = uygulama_kur(kok)
    except ValueError as e:
        print(f"\nKovan başlatılamadı: {e}\n", file=sys.stderr)
        sys.exit(1)

    cfg = app.state.cfg
    port = int(cfg["port"])
    print("")
    print("  Kovan çalışıyor  ->  http://127.0.0.1:%d" % port)
    for ad, m in app.state.motorlar.items():
        if ad == "deneme":
            continue
        etiket = f"{ad} ({m.model})" if getattr(m, "yerel", False) else ad
        if m.saglik():
            print(f"  {etiket}: hazır  {m.surum if ad == 'claude' else 'Ollama ' + str(m.ollama_surum)}")
        else:
            print(f"  {etiket}: HAZIR DEĞİL -> {m.hata}")
    print("  (Deneme modu her durumda çalışır.)")
    print("  Durdurmak için bu pencerede Ctrl+C")
    print("")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
