// Ajanların yazdığı markdown'ı güvenli biçimde gösterir: marked ile HTML'e, DOMPurify ile temizlenir.
// onAtif verilirse belgedeki kod atıfları (kaynak/<dosya>:<satır>, mevcut projede proje/<dosya>:<satır>) tıklanır: o satırlar açılır.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "react";

marked.use({ gfm: true, breaks: false });

DOMPurify.addHook("afterSanitizeAttributes", (dugum) => {
  if (dugum.tagName === "A") {
    dugum.setAttribute("target", "_blank");
    dugum.setAttribute("rel", "noopener noreferrer");
  }
});

/** Sunucudaki atıf denetimiyle aynı biçim (sunucu/src/kaynak.ts). */
const ATIF = /(?<![\w/])((?:kaynak|proje)\/[^\s`'"()[\]<>|,;]+?):(\d+)(?:-(\d+))?(?!\d)/g;

export type AtifTiklama = (yol: string, ilk: number, son: number) => void;

/** Metin düğümlerindeki atıfları düğmeye çevirir. Düğmeler DOM API'siyle kurulur; HTML enjekte edilmez. */
function atiflariBagla(kok: HTMLElement): void {
  const yuruyen = document.createTreeWalker(kok, NodeFilter.SHOW_TEXT);
  const dugumler: Text[] = [];
  for (let n = yuruyen.nextNode(); n; n = yuruyen.nextNode()) {
    if (n.parentElement?.closest("a, button")) continue;
    if (/(?:kaynak|proje)\//.test(n.nodeValue ?? "")) dugumler.push(n as Text);
  }
  for (const dugum of dugumler) {
    const metin = dugum.nodeValue ?? "";
    const parcalar = [...metin.matchAll(ATIF)];
    if (!parcalar.length) continue;
    const parca = document.createDocumentFragment();
    let i = 0;
    for (const m of parcalar) {
      parca.append(metin.slice(i, m.index));
      const d = document.createElement("button");
      d.type = "button";
      d.className = "atif";
      d.textContent = m[0];
      d.title = "Bu satırları aç";
      d.dataset.atif = m[1];
      d.dataset.ilk = m[2];
      d.dataset.son = m[3] ?? m[2];
      parca.append(d);
      i = m.index + m[0].length;
    }
    parca.append(metin.slice(i));
    dugum.replaceWith(parca);
  }
}

export function Markdown({ metin, sinif = "", onAtif }: { metin: string; sinif?: string; onAtif?: AtifTiklama }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(metin ?? "", { async: false }), { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input"] }),
    [metin],
  );
  const kok = useRef<HTMLDivElement>(null);
  const bagli = Boolean(onAtif);
  useEffect(() => { if (bagli && kok.current) atiflariBagla(kok.current); }, [html, bagli]);
  return (
    <div ref={kok} className={`belge ${sinif}`.trim()} dangerouslySetInnerHTML={{ __html: html }}
      onClick={onAtif ? (e) => {
        const d = (e.target as HTMLElement).closest<HTMLElement>("button.atif");
        if (d?.dataset.atif) onAtif(d.dataset.atif, Number(d.dataset.ilk), Number(d.dataset.son));
      } : undefined} />
  );
}
