"""SQLite deposu: fikirler ve adımlar (her ajan çağrısı, kontrol, karar bir adımdır)."""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import List, Optional

FIKIR_ALANLARI = {
    "baslik", "metin", "profil", "motor", "durum", "asama_idx", "tur", "faz", "ek_tur",
    "geri_bildirim", "bekleme", "butce_usd", "maliyet_usd", "girdi_token", "cikti_token",
    "olusturma", "guncelleme", "baslama", "bitis", "istisnalar",
}
ADIM_ALANLARI = {
    "durum", "bitis", "sure_sn", "maliyet_usd", "girdi_token", "cikti_token", "ozet", "dosya", "ajan_turu",
    "motor", "model",
}

SEMA = """
CREATE TABLE IF NOT EXISTS fikirler (
    id TEXT PRIMARY KEY,
    baslik TEXT, metin TEXT, profil TEXT, motor TEXT,
    durum TEXT, asama_idx INTEGER DEFAULT 0, tur INTEGER DEFAULT 1, faz TEXT DEFAULT 'uret',
    ek_tur INTEGER DEFAULT 0, geri_bildirim TEXT, bekleme TEXT,
    butce_usd REAL DEFAULT 5, maliyet_usd REAL DEFAULT 0,
    girdi_token INTEGER DEFAULT 0, cikti_token INTEGER DEFAULT 0,
    olusturma TEXT, guncelleme TEXT, baslama TEXT, bitis TEXT
);
CREATE TABLE IF NOT EXISTS adimlar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fikir_id TEXT, asama_id TEXT, asama_ad TEXT, tip TEXT,
    ajan TEXT, ajan_ad TEXT, ajan_turu INTEGER DEFAULT 0,
    tur INTEGER, deneme INTEGER, durum TEXT,
    basla TEXT, bitis TEXT, sure_sn REAL,
    maliyet_usd REAL DEFAULT 0, girdi_token INTEGER DEFAULT 0, cikti_token INTEGER DEFAULT 0,
    ozet TEXT, dosya TEXT
);
CREATE INDEX IF NOT EXISTS adim_fikir ON adimlar(fikir_id);
"""

# Sonradan eklenen kolonlar (eski veritabanları açılırken eklenir)
GOC = [("fikirler", "istisnalar", "TEXT"), ("adimlar", "motor", "TEXT"), ("adimlar", "model", "TEXT")]


def simdi() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class Depo:
    def __init__(self, yol: Path):
        yol.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(yol), check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.kilit = threading.RLock()
        with self.kilit:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.executescript(SEMA)
            for tablo, kolon, tip in GOC:
                mevcut = {r["name"] for r in self.db.execute(f"PRAGMA table_info({tablo})")}
                if kolon not in mevcut:
                    self.db.execute(f"ALTER TABLE {tablo} ADD COLUMN {kolon} {tip}")

    # ---------------- fikirler ----------------
    def yeni_id(self) -> str:
        with self.kilit:
            satirlar = self.db.execute("SELECT id FROM fikirler").fetchall()
            enbuyuk = 0
            for s in satirlar:
                try:
                    enbuyuk = max(enbuyuk, int(str(s["id"]).split("-")[-1]))
                except ValueError:
                    continue
            return f"F-{enbuyuk + 1:03d}"

    def fikir_ekle(self, **alanlar) -> None:
        alanlar.setdefault("olusturma", simdi())
        alanlar["guncelleme"] = alanlar["olusturma"]
        anahtarlar = ["id"] + [k for k in alanlar if k != "id" and k in FIKIR_ALANLARI]
        with self.kilit:
            self.db.execute(
                f"INSERT INTO fikirler ({','.join(anahtarlar)}) VALUES ({','.join('?' * len(anahtarlar))})",
                [alanlar[k] for k in anahtarlar],
            )

    def fikir(self, fid: str) -> Optional[dict]:
        with self.kilit:
            s = self.db.execute("SELECT * FROM fikirler WHERE id=?", (fid,)).fetchone()
        return dict(s) if s else None

    def fikirler(self) -> List[dict]:
        with self.kilit:
            return [dict(s) for s in self.db.execute("SELECT * FROM fikirler ORDER BY olusturma DESC, id DESC")]

    def fikir_guncelle(self, fid: str, **alanlar) -> None:
        alanlar = {k: v for k, v in alanlar.items() if k in FIKIR_ALANLARI}
        alanlar["guncelleme"] = simdi()
        with self.kilit:
            self.db.execute(
                f"UPDATE fikirler SET {', '.join(k + '=?' for k in alanlar)} WHERE id=?",
                list(alanlar.values()) + [fid],
            )

    def maliyet_ekle(self, fid: str, maliyet: float, girdi: int, cikti: int) -> None:
        with self.kilit:
            self.db.execute(
                "UPDATE fikirler SET maliyet_usd=maliyet_usd+?, girdi_token=girdi_token+?, "
                "cikti_token=cikti_token+? WHERE id=?",
                (maliyet or 0, girdi or 0, cikti or 0, fid),
            )

    def durumdakiler(self, *durumlar: str) -> List[dict]:
        with self.kilit:
            return [dict(s) for s in self.db.execute(
                f"SELECT * FROM fikirler WHERE durum IN ({','.join('?' * len(durumlar))})", durumlar)]

    # ---------------- adımlar ----------------
    def adim_ekle(self, fikir_id: str, asama_id: str, asama_ad: str, tip: str, ajan: str, ajan_ad: str,
                  tur: int, deneme: int, durum: str, ozet: str = "", dosya: str = "",
                  motor: Optional[str] = None, model: Optional[str] = None) -> int:
        with self.kilit:
            imlec = self.db.execute(
                "INSERT INTO adimlar (fikir_id, asama_id, asama_ad, tip, ajan, ajan_ad, tur, deneme, durum, basla, "
                "ozet, dosya, motor, model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (fikir_id, asama_id, asama_ad, tip, ajan, ajan_ad, tur, deneme, durum, simdi(), ozet, dosya,
                 motor, model),
            )
            return int(imlec.lastrowid)

    def adim_guncelle(self, adim_id: int, **alanlar) -> None:
        alanlar = {k: v for k, v in alanlar.items() if k in ADIM_ALANLARI}
        if not alanlar:
            return
        with self.kilit:
            self.db.execute(
                f"UPDATE adimlar SET {', '.join(k + '=?' for k in alanlar)} WHERE id=?",
                list(alanlar.values()) + [adim_id],
            )

    def adim(self, adim_id: int) -> Optional[dict]:
        with self.kilit:
            s = self.db.execute("SELECT * FROM adimlar WHERE id=?", (adim_id,)).fetchone()
        return dict(s) if s else None

    def adimlar(self, fid: str) -> List[dict]:
        with self.kilit:
            return [dict(s) for s in self.db.execute("SELECT * FROM adimlar WHERE fikir_id=? ORDER BY id", (fid,))]

    def calisan_adimlari_kapat(self) -> None:
        with self.kilit:
            self.db.execute("UPDATE adimlar SET durum='kesildi', bitis=? WHERE durum='calisiyor'", (simdi(),))
