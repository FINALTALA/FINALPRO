import { registerTranslations, translate, type Lang } from "./i18n";

// Fabric composition and country of origin (2026-11-19): the parts, the
// fibres (the import's words are the same - a test compares them), how a
// part reads («95% قطن، 5% إيلاستين») and a country's name in the page's
// language (ISO 3166-1 alpha-2 codes, named by the browser).

export const COMPOSITION_PARTS = ["SHELL", "LINING", "FILLING", "TRIM"] as const;
export type CompositionPart = (typeof COMPOSITION_PARTS)[number];
export const COMPOSITION_FIBERS = [
  "COTTON",
  "POLYESTER",
  "ELASTANE",
  "VISCOSE",
  "LYOCELL",
  "MODAL",
  "LINEN",
  "WOOL",
  "SILK",
  "POLYAMIDE",
  "ACRYLIC",
  "CASHMERE",
  "LEATHER",
  "FAUX_LEATHER",
  "OTHER",
] as const;
export type CompositionFiber = (typeof COMPOSITION_FIBERS)[number];
export const MAX_FIBERS_PER_PART = 6;

export interface CompositionFiberRow {
  fiber: CompositionFiber;
  other_ar?: string;
  other_en?: string;
  /** whole number 1-100; null while not typed yet */
  percent: number | null;
}
export interface CompositionPartRow {
  part: CompositionPart;
  fibers: CompositionFiberRow[];
}
export interface Composition {
  parts: CompositionPartRow[];
}

/** The countries most clothing here comes from - first in the list. */
export const COMMON_COUNTRIES = ["TR", "CN", "PS", "JO", "EG", "BD", "IN", "VN", "IT", "PK"];

registerTranslations({
  ar: {
    "wz.part.SHELL": "الخامة الخارجية",
    "wz.part.LINING": "البطانة",
    "wz.part.FILLING": "الحشوة",
    "wz.part.TRIM": "الأطراف والتطريز",
    "wz.fiber.COTTON": "قطن",
    "wz.fiber.POLYESTER": "بوليستر",
    "wz.fiber.ELASTANE": "إيلاستين",
    "wz.fiber.VISCOSE": "فسكوز",
    "wz.fiber.LYOCELL": "ليوسيل",
    "wz.fiber.MODAL": "مودال",
    "wz.fiber.LINEN": "كتان",
    "wz.fiber.WOOL": "صوف",
    "wz.fiber.SILK": "حرير",
    "wz.fiber.POLYAMIDE": "بولي أميد",
    "wz.fiber.ACRYLIC": "أكريليك",
    "wz.fiber.CASHMERE": "كشمير",
    "wz.fiber.LEATHER": "جلد طبيعي",
    "wz.fiber.FAUX_LEATHER": "جلد صناعي",
    "wz.fiber.OTHER": "أخرى",
    "comp.title": "مكوّنات القماش وبلد المنشأ",
    "comp.lead": "ما صُنعت منه القطعة فعلاً، لكل جزء منها. «الخامة» في المواصفات تبقى كما هي.",
    "comp.add_part": "أضيفي جزءاً",
    "comp.add_fiber": "+ ليف آخر",
    "comp.remove_part": "إزالة {part}",
    "comp.remove_fiber": "إزالة {fiber} من {part}",
    "comp.fiber": "الليف",
    "comp.percent": "النسبة %",
    "comp.choose_fiber": "اختاري الليف",
    "comp.other_ar": "اسم الليف بالعربية",
    "comp.other_en": "بالإنجليزية (اختياري)",
    "comp.single": "100% من ليف واحد",
    "comp.total": "المجموع {n}%",
    "comp.total_missing": "المجموع {n}% — ينقص {left}%",
    "comp.total_over": "المجموع {n}% — يزيد {over}%",
    "comp.total_ok": "✓ المجموع 100%",
    "comp.country": "بلد المنشأ",
    "comp.country_none": "غير محدد",
    "comp.country_common": "الأكثر استعمالاً",
    "comp.country_all": "كل الدول",
    "comp.max_fibers": "حتى {n} ألياف للجزء الواحد.",
    "comp.origin_line": "بلد المنشأ",
    "comp.view_title": "التركيب وبلد المنشأ",
    "wz.p.COMPOSITION_SUM": "مجموع نسب «{part}» يجب أن يكون 100% بالضبط.",
    "wz.p.COMPOSITION_PERCENT": "أدخلي نسبة كل ليف في «{part}».",
    "wz.p.COMPOSITION_OTHER": "اكتبي اسم الليف «أخرى» بالعربية في «{part}».",
    "wz.hint.COMPOSITION_SUGGESTED": "إضافة مكوّنات القماش تساعد المتسوقة على الاختيار (اختياري).",
    "wz.hint.ORIGIN_SUGGESTED": "يمكنك إضافة بلد المنشأ (اختياري).",
    "wz.edit.group.composition": "التركيب وبلد المنشأ",
    "wz.summary.composition": "التركيب وبلد المنشأ",
  },
  en: {
    "wz.part.SHELL": "Shell",
    "wz.part.LINING": "Lining",
    "wz.part.FILLING": "Filling",
    "wz.part.TRIM": "Trim",
    "wz.fiber.COTTON": "Cotton",
    "wz.fiber.POLYESTER": "Polyester",
    "wz.fiber.ELASTANE": "Elastane",
    "wz.fiber.VISCOSE": "Viscose",
    "wz.fiber.LYOCELL": "Lyocell",
    "wz.fiber.MODAL": "Modal",
    "wz.fiber.LINEN": "Linen",
    "wz.fiber.WOOL": "Wool",
    "wz.fiber.SILK": "Silk",
    "wz.fiber.POLYAMIDE": "Polyamide",
    "wz.fiber.ACRYLIC": "Acrylic",
    "wz.fiber.CASHMERE": "Cashmere",
    "wz.fiber.LEATHER": "Leather",
    "wz.fiber.FAUX_LEATHER": "Faux leather",
    "wz.fiber.OTHER": "Other",
    "comp.title": "Fabric composition and country of origin",
    "comp.lead": "What the garment is really made of, part by part. «Material» in the specifications stays as it is.",
    "comp.add_part": "Add a part",
    "comp.add_fiber": "+ Another fibre",
    "comp.remove_part": "Remove {part}",
    "comp.remove_fiber": "Remove {fiber} from {part}",
    "comp.fiber": "Fibre",
    "comp.percent": "Percent %",
    "comp.choose_fiber": "Choose the fibre",
    "comp.other_ar": "Fibre name in Arabic",
    "comp.other_en": "In English (optional)",
    "comp.single": "100% of one fibre",
    "comp.total": "Total {n}%",
    "comp.total_missing": "Total {n}% — {left}% missing",
    "comp.total_over": "Total {n}% — {over}% too much",
    "comp.total_ok": "✓ Total 100%",
    "comp.country": "Country of origin",
    "comp.country_none": "Not given",
    "comp.country_common": "Most used",
    "comp.country_all": "All countries",
    "comp.max_fibers": "Up to {n} fibres per part.",
    "comp.origin_line": "Country of origin",
    "comp.view_title": "Composition and country of origin",
    "wz.p.COMPOSITION_SUM": "The percents of «{part}» must total exactly 100%.",
    "wz.p.COMPOSITION_PERCENT": "Enter the percent of each fibre in «{part}».",
    "wz.p.COMPOSITION_OTHER": "Write the Arabic name of the «Other» fibre in «{part}».",
    "wz.hint.COMPOSITION_SUGGESTED": "Adding the fabric composition helps shoppers choose (optional).",
    "wz.hint.ORIGIN_SUGGESTED": "You can add the country of origin (optional).",
    "wz.edit.group.composition": "Composition and origin",
    "wz.summary.composition": "Composition and origin",
  },
});

/** A fibre's name in the page's language (an «other» one by its own name, Arabic when no English). */
export function fiberName(f: CompositionFiberRow, lang: Lang): string {
  if (f.fiber === "OTHER") return (lang === "en" ? f.other_en || f.other_ar : f.other_ar) || translate(lang, "wz.fiber.OTHER");
  return translate(lang, `wz.fiber.${f.fiber}`);
}

/** A part as a label reads: «95% قطن، 5% إيلاستين» / «95% Cotton, 5% Elastane». */
export function partText(p: CompositionPartRow, lang: Lang): string {
  return p.fibers.map((f) => `${f.percent ?? "?"}% ${fiberName(f, lang)}`).join(lang === "en" ? ", " : "، ");
}

/** A country's name in the page's language (the code itself if the browser cannot name it). */
export function countryName(code: string | null | undefined, lang: Lang): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Every region the browser names (ISO 3166-1 alpha-2), in the page's language, sorted - for the country list. */
export function allCountries(lang: Lang): { code: string; name: string }[] {
  const out: { code: string; name: string }[] = [];
  let names: Intl.DisplayNames;
  try {
    names = new Intl.DisplayNames([lang], { type: "region" });
  } catch {
    return out;
  }
  for (let a = 65; a <= 90; a += 1)
    for (let b = 65; b <= 90; b += 1) {
      const code = String.fromCharCode(a, b);
      const name = names.of(code);
      if (name && name !== code) out.push({ code, name });
    }
  return out.sort((x, y) => x.name.localeCompare(y.name, lang));
}

/** A part's total (fibres without a percent count as 0). */
export const partTotal = (p: CompositionPartRow) => p.fibers.reduce((n, f) => n + (f.percent ?? 0), 0);
