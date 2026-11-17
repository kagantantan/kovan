// Küçük React kancaları: yoklama (polling) ve adres çubuğundaki # yolu.
import { useCallback, useEffect, useRef, useState } from "react";

/** getir()'i belirtilen aralıkla çağırır; istekler üst üste binmez. aralik null ise durur. */
export function useYokla<T>(getir: () => Promise<T>, aralikMs: number | null, anahtar: string) {
  const [veri, setVeri] = useState<T | null>(null);
  const [hata, setHata] = useState<string | null>(null);
  const getirRef = useRef(getir);
  getirRef.current = getir;
  const surum = useRef(0);

  const yenile = useCallback(async () => {
    const benim = ++surum.current;
    try {
      const v = await getirRef.current();
      if (benim === surum.current) { setVeri(v); setHata(null); }
    } catch (e) {
      if (benim === surum.current) setHata((e as Error).message);
    }
  }, []);

  const oncekiAnahtar = useRef(anahtar);

  useEffect(() => {
    if (oncekiAnahtar.current !== anahtar) {   // başka bir şeye bakılıyor: eski veriyi gösterme
      oncekiAnahtar.current = anahtar;
      setVeri(null);
      setHata(null);
    }
    let bitti = false;
    let zamanlayici: ReturnType<typeof setTimeout> | undefined;
    const dongu = async () => {
      await yenile();
      if (!bitti && aralikMs !== null) {
        // Sekme arka plandayken daha seyrek sor (başlık rozeti ve bildirim için yine de sorar)
        const bekle = document.hidden ? Math.max(aralikMs, 10_000) : aralikMs;
        zamanlayici = setTimeout(dongu, bekle);
      }
    };
    void dongu();
    return () => { bitti = true; surum.current++; if (zamanlayici) clearTimeout(zamanlayici); };
    // anahtar değişince (ör. başka fikir seçilince) baştan başla
  }, [anahtar, aralikMs, yenile]);

  return { veri, hata, yenile };
}

export type Rota =
  | { sayfa: "fikirler"; id: string | null }
  | { sayfa: "yeni" }
  | { sayfa: "ajanlar"; id: string | null }
  | { sayfa: "akislar" };

export function rotaCoz(hash: string): Rota {
  const parcalar = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  switch (parcalar[0]) {
    case "yeni": return { sayfa: "yeni" };
    case "ajanlar": return { sayfa: "ajanlar", id: parcalar[1] ?? null };
    case "akislar": return { sayfa: "akislar" };
    case "fikirler": return { sayfa: "fikirler", id: parcalar[1] ?? null };
    default: return { sayfa: "fikirler", id: /^F-\d+$/.test(parcalar[0] ?? "") ? parcalar[0] : null };
  }
}

export function useRota(): Rota {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const dinle = () => setHash(window.location.hash);
    window.addEventListener("hashchange", dinle);
    return () => window.removeEventListener("hashchange", dinle);
  }, []);
  return rotaCoz(hash);
}

export const git = (yol: string) => { window.location.hash = yol; };
