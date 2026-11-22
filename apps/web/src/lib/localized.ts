import type { Lang } from "./i18n";
import { sizeLabelFor } from "./sizeGuides";
import type { TaxonomyDto } from "./taxonomy";

// TB-25: which field of bilingual data a page shows. Arabic is always the
// original; English shows the English field when it is present and not
// blank, and falls back to the Arabic otherwise (never an empty space).
// Free text that exists in one language only (a store's name, title and
// bio, branch names, a customer's note) is shown as written - callers
// simply do not pass it through here.

/** The English value in English (when present and not blank), otherwise the Arabic. */
export function pickText(lang: Lang, en: string | null | undefined, ar: string | null | undefined): string {
  if (lang === "en" && typeof en === "string" && en.trim() !== "") return en;
  return ar ?? en ?? "";
}

type Named = { code: string; name_ar: string; name_en: string };

function nameIn(list: Named[] | undefined, code: string | null | undefined, lang: Lang): string | null {
  if (!code) return null;
  const item = list?.find((x) => x.code === code);
  return item ? pickText(lang, item.name_en, item.name_ar) : null;
}

/** A colour's name by taxonomy code; `fallback` (e.g. an order's own snapshot) when the code is unknown. */
export function colorName(
  taxonomy: TaxonomyDto | null | undefined,
  code: string | null | undefined,
  lang: Lang,
  fallback: string | null = null,
): string | null {
  return nameIn(taxonomy?.colors, code, lang) ?? fallback;
}

/** A taxonomy category's name by code. */
export function categoryName(
  taxonomy: TaxonomyDto | null | undefined,
  code: string | null | undefined,
  lang: Lang,
  fallback: string | null = null,
): string | null {
  return nameIn(taxonomy?.categories, code, lang) ?? fallback;
}

/** A season's name by code. */
export function seasonName(
  taxonomy: TaxonomyDto | null | undefined,
  code: string | null | undefined,
  lang: Lang,
  fallback: string | null = null,
): string | null {
  return nameIn(taxonomy?.seasons, code, lang) ?? fallback;
}

/** An audience's name (Women / Men / Kids) by code. */
export function audienceName(
  taxonomy: TaxonomyDto | null | undefined,
  code: string | null | undefined,
  lang: Lang,
  fallback: string | null = null,
): string | null {
  return nameIn(taxonomy?.audiences, code, lang) ?? fallback;
}

/** A size's label: the taxonomy label, with age sizes worded in English by code. */
export function sizeName(code: string | null | undefined, label: string | null | undefined, lang: Lang): string | null {
  if (!code) return label ?? null;
  return sizeLabelFor(code, label ?? code, lang);
}
