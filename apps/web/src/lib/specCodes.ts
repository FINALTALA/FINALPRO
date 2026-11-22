// Phase A++ (item 4): the specifications kept as codes from closed lists
// (the API's CLOSED_SPEC_VALUES decides; this mirrors it for the screens):
// fit, stretch, occasion, care - all optional. `care` takes several codes,
// comma-separated. Older products may hold the Arabic «fit» words offered
// before the list; they are shown as they are.

export type SpecCode = { code: string; ar: string; en: string };
const c = (code: string, ar: string, en: string): SpecCode => ({ code, ar, en });

export const CODED_SPECS: Record<string, SpecCode[]> = {
  fit: [c("SLIM", "ضيّق", "Slim"), c("REGULAR", "عادي", "Regular"), c("LOOSE", "واسع", "Loose"), c("OVERSIZED", "أوفرسايز", "Oversized")],
  stretch: [c("NONE", "بلا مطاطية", "No stretch"), c("SLIGHT", "مطاطية قليلة", "Slight stretch"), c("HIGH", "مطاطية عالية", "High stretch")],
  occasion: [
    c("CASUAL", "يومي", "Everyday"),
    c("EVENING", "سهرة", "Evening"),
    c("WORK", "عمل", "Work"),
    c("SPORT", "رياضة", "Sport"),
    c("HOME", "منزلي", "Home"),
    c("FORMAL", "رسمي", "Formal"),
    c("EID", "مناسبات وأعياد", "Eid and occasions"),
  ],
  care: [
    c("HAND_WASH", "غسيل يدوي", "Hand wash"),
    c("MACHINE_WASH", "غسيل آلي", "Machine wash"),
    c("DRY_CLEAN", "تنظيف جاف", "Dry clean"),
    c("NO_BLEACH", "بدون مبيّض", "No bleach"),
    c("NO_TUMBLE_DRY", "بدون مجفف", "No tumble dry"),
    c("IRON_LOW", "كي بحرارة منخفضة", "Iron on low"),
  ],
};
export const MULTI_SPECS: ReadonlySet<string> = new Set(["care"]);

export const isCodedSpec = (key: string) => key in CODED_SPECS;

/** The codes of a stored value (care: several). */
export function specCodesOf(key: string, value: string | undefined): string[] {
  if (!value) return [];
  return MULTI_SPECS.has(key) ? value.split(",").map((x) => x.trim()).filter(Boolean) : [value.trim()];
}

/** A stored value in words, in the page's language (an older free-text value is shown as it is). */
export function specValueText(key: string, value: string, lang: string): string {
  const list = CODED_SPECS[key];
  if (!list) return value;
  const sep = lang === "en" ? ", " : "، ";
  return specCodesOf(key, value)
    .map((code) => {
      const o = list.find((x) => x.code === code);
      return o ? (lang === "en" ? o.en : o.ar) : code;
    })
    .join(sep);
}
