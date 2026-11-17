// Ajanların yazdığı markdown'ı güvenli biçimde gösterir: marked ile HTML'e, DOMPurify ile temizlenir.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

marked.use({ gfm: true, breaks: false });

DOMPurify.addHook("afterSanitizeAttributes", (dugum) => {
  if (dugum.tagName === "A") {
    dugum.setAttribute("target", "_blank");
    dugum.setAttribute("rel", "noopener noreferrer");
  }
});

export function Markdown({ metin, sinif = "" }: { metin: string; sinif?: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(metin ?? "", { async: false }), { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input"] }),
    [metin],
  );
  return <div className={`belge ${sinif}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}
