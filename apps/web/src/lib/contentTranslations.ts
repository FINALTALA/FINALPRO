// VIA phase 6 - reviewed English translations for editorial copy that the
// current design shows in Arabic only (Trending). Each entry is translated
// faithfully from the exact Arabic it was written for - no added claims.
// The Content Studio editor offers them as a draft change ("fill missing
// English"): an entry fills a field only while its English is still empty
// AND its Arabic is still exactly `ar`, so an administrator's own edits are
// never overwritten. Nothing is saved or published until the admin does it.

type Bi = { ar: string; en: string };
export interface SuggestedTranslation {
  section: string; // section key
  item: string | null; // item id
  field: string;
  alt?: boolean; // the media field's alt text instead of the field's text
  ar: string; // the Arabic source the English was translated from
  en: string;
}

const look = (item: string, nameAr: string, nameEn: string, altAr: string, altEn: string): SuggestedTranslation[] => [
  { section: "trend.look", item, field: "title", ar: nameAr, en: nameEn },
  { section: "trend.look", item, field: "image", alt: true, ar: altAr, en: altEn },
];
const gallery = (item: string, ar: string, en: string): SuggestedTranslation => ({
  section: "trend.collections",
  item,
  field: "image",
  alt: true,
  ar,
  en,
});

export const SUGGESTED_TRANSLATIONS: Record<string, SuggestedTranslation[]> = {
  TRENDING: [
    { section: "trend.hero", item: null, field: "headline", ar: "الشتا\nعلى طريقتك", en: "Winter\nyour way" },
    { section: "trend.hero", item: null, field: "subline", ar: "الطقم الخمري، بطريقتك.", en: "The burgundy set, your way." },
    ...look("jeans", "جينز أبيض واسع بخصر عالٍ", "Wide white high-waisted jeans", "جينز أبيض بقَصّة واسعة وخصر عالٍ", "White jeans with a wide-leg cut and a high waist"),
    ...look("tote", "حقيبة جلد مضفور", "Woven leather bag", "حقيبة كتف من الجلد المضفور بلون بنّي داكن", "Dark brown woven leather shoulder bag"),
    ...look("heels", "حذاء سلينغ باك بكعب مدبّب", "Slingback shoes with a pointed heel", "حذاء عنّابي من الجلد اللامع بمقدّمة مدبّبة وحزام خلفي", "Burgundy patent leather shoe with a pointed toe and a back strap"),
    ...look("jacket", "جاكيت جلد واسع بحزام", "Oversized belted leather jacket", "جاكيت جلد عنّابي داكن واسع بياقة عريضة وحزام", "Oversized dark burgundy leather jacket with a wide collar and a belt"),
    ...look("hoops", "حلق دائري ذهبي عريض", "Wide gold hoop earrings", "زوج أقراط دائرية ذهبية عريضة", "A pair of wide gold hoop earrings"),
    ...look("tee", "تيشيرت قطني أبيض", "White cotton T-shirt", "تيشيرت قطني أبيض برقبة دائرية", "White cotton crew-neck T-shirt"),
    gallery("sand-linen", "عارضة بقميص كتّان بلون الرمل وبنطال واسع بلون العاج", "Model in a sand-coloured linen shirt and ivory wide-leg trousers"),
    gallery("quiet-tailoring", "رجل بقميص بولو محبوك بلون العاج وبنطال أسود ونظارة شمسية", "Man in an ivory knit polo shirt, black trousers and sunglasses"),
    gallery("mini-neutrals", "طفل بكنزة محبوكة بضفائر بلون الكريم وبنطال كتّان", "Child in a cream cable-knit sweater and linen trousers"),
    gallery("liquid-gold", "خواتم وسلاسل ذهبية على سطح عاكس داكن", "Gold rings and chains on a dark reflective surface"),
    gallery("cocoa-cream", "ثلاث حقائب جلد ناعمة بالعنّابي والبني والكريمي مكدّسة فوق بعضها", "Three soft leather bags in burgundy, brown and cream, stacked on one another"),
    gallery("off-duty-cream", "حذاء رياضي من الشامواه بلون الكريم بنعل عسلي", "Cream suede sneakers with a honey-coloured sole"),
  ],
};

interface DocLike {
  sections: { key: string; fields: Record<string, unknown>; items: { id: string; fields: Record<string, unknown> }[] }[];
}

/** The text (or alt) value a suggestion targets, if it exists in the draft. */
function target(doc: DocLike, s: SuggestedTranslation): Bi | null {
  const sec = doc.sections.find((x) => x.key === s.section);
  if (!sec) return null;
  const fields = s.item === null ? sec.fields : sec.items.find((i) => i.id === s.item)?.fields;
  const v = fields?.[s.field] as (Bi & { alt?: Bi }) | null | undefined;
  if (!v || typeof v !== "object") return null;
  if (s.alt) return (v as { alt?: Bi }).alt ?? null;
  return "ar" in v ? v : null;
}

/** Suggestions that would fill an empty English value whose Arabic is unchanged. */
export function applicableSuggestions(page: string, doc: DocLike): SuggestedTranslation[] {
  return (SUGGESTED_TRANSLATIONS[page] ?? []).filter((s) => {
    const v = target(doc, s);
    return !!v && !v.en.trim() && v.ar.trim() === s.ar.trim();
  });
}

/** Fills those English values in place (the caller marks the draft as changed). */
export function applySuggestions(page: string, doc: DocLike): number {
  const list = applicableSuggestions(page, doc);
  for (const s of list) target(doc, s)!.en = s.en;
  return list.length;
}
