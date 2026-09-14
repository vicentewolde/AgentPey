/**
 * The two languages RealOps speaks.
 *
 * Every page carries both, English and Spanish, and the visitor's switch picks
 * which one shows (a cookie shared by the pilot's three domains, read before
 * paint). The server never guesses a language from a header, so the same URL
 * renders the same bytes for everyone and a cached page cannot come back in
 * the wrong language.
 */

export interface Bilingual {
  readonly en: string;
  readonly es: string;
}

export function bilingual(en: string, es: string): Bilingual {
  return { en, es };
}

export function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Plain text in both languages, escaped. Only the active language is displayed. */
export function tr(text: Bilingual): string {
  return trHtml(escape(text.en), escape(text.es));
}

/**
 * Markup in both languages. The caller vouches for it: anything variable
 * inside must already have gone through {@link escape}.
 */
export function trHtml(en: string, es: string): string {
  return `<span data-tr="en">${en}</span><span data-tr="es">${es}</span>`;
}
