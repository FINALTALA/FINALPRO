/**
 * The product import (2026-11-18): the words of the XLSX file. The file
 * speaks the owner's language - sheet and column names, list values - and
 * the server reads them back to codes. Arabic and English are both
 * accepted whatever language the template was downloaded in.
 *
 * The specification and measurement words mirror the web app's own tables
 * (apps/web/src/lib/specCodes.ts, offerWizardText.ts) - a test compares
 * them so the two never drift.
 */

export type Words = { ar: string; en: string };

export const SHEETS = {
  products: { ar: 'المنتجات', en: 'Products' },
  versions: { ar: 'الألوان والمقاسات', en: 'Colours and sizes' },
  images: { ar: 'الصور', en: 'Images' },
  measurements: { ar: 'جدول القياسات', en: 'Size table' },
  instructions: { ar: 'التعليمات', en: 'Instructions' },
  lists: { ar: 'القوائم', en: 'Lists' },
} as const satisfies Record<string, Words>;

/** «المنتجات»: one row per product. */
export const PRODUCT_COLUMNS = {
  ref: { ar: 'رقم المنتج في الملف', en: 'Product no. in this file' },
  title_ar: { ar: 'الاسم بالعربية', en: 'Arabic name' },
  title_en: { ar: 'الاسم بالإنجليزية', en: 'English name' },
  audience: { ar: 'الجمهور', en: 'Audience' },
  category: { ar: 'الفئة', en: 'Category' },
  brand: { ar: 'العلامة التجارية', en: 'Brand' },
  description_ar: { ar: 'الوصف بالعربية', en: 'Arabic description' },
  description_en: { ar: 'الوصف بالإنجليزية', en: 'English description' },
  price: { ar: 'السعر', en: 'Price' },
  sale_price: { ar: 'السعر بعد الخصم', en: 'Sale price' },
  discount_percent: { ar: 'نسبة الخصم %', en: 'Discount %' },
  discount_start: { ar: 'بداية الخصم', en: 'Discount start' },
  discount_end: { ar: 'نهاية الخصم', en: 'Discount end' },
  size_system: { ar: 'نظام المقاسات', en: 'Size system' },
  model_height: { ar: 'طول العارضة (سم)', en: "Model's height (cm)" },
  model_size: { ar: 'مقاس العارضة', en: "Model's size" },
  collections: { ar: 'المجموعات', en: 'Collections' },
  // fabric composition (2026-11-19): one cell per part, «95% قطن، 5% إيلاستين»
  composition_shell: { ar: 'تركيب الخامة الخارجية', en: 'Shell composition' },
  composition_lining: { ar: 'تركيب البطانة', en: 'Lining composition' },
  composition_filling: { ar: 'تركيب الحشوة', en: 'Filling composition' },
  composition_trim: { ar: 'تركيب الأطراف والتطريز', en: 'Trim composition' },
  country_of_origin: { ar: 'بلد المنشأ', en: 'Country of origin' },
  // the store barcode (2026-11-20): ONE code for the whole product (every colour and size)
  barcode: { ar: 'الباركود', en: 'Barcode' },
} as const satisfies Record<string, Words>;

/** Which part each composition column fills. */
export const COMPOSITION_COLUMNS = {
  composition_shell: 'SHELL',
  composition_lining: 'LINING',
  composition_filling: 'FILLING',
  composition_trim: 'TRIM',
} as const;

/**
 * The fibres' words (the wizard's «wz.fiber.*» - a test compares them), and
 * other ways people write them. «أخرى: <الاسم>» / «Other: <name>» names a
 * fibre not in the list.
 */
export const FIBER_WORDS: Record<string, Words & { also?: string[] }> = {
  COTTON: { ar: 'قطن', en: 'Cotton' },
  POLYESTER: { ar: 'بوليستر', en: 'Polyester' },
  ELASTANE: {
    ar: 'إيلاستين',
    en: 'Elastane',
    also: ['سباندكس', 'ليكرا', 'Spandex', 'Lycra'],
  },
  VISCOSE: { ar: 'فسكوز', en: 'Viscose', also: ['رايون', 'Rayon'] },
  LYOCELL: { ar: 'ليوسيل', en: 'Lyocell', also: ['تنسل', 'Tencel'] },
  MODAL: { ar: 'مودال', en: 'Modal' },
  LINEN: { ar: 'كتان', en: 'Linen' },
  WOOL: { ar: 'صوف', en: 'Wool' },
  SILK: { ar: 'حرير', en: 'Silk' },
  POLYAMIDE: { ar: 'بولي أميد', en: 'Polyamide', also: ['نايلون', 'Nylon'] },
  ACRYLIC: { ar: 'أكريليك', en: 'Acrylic' },
  CASHMERE: { ar: 'كشمير', en: 'Cashmere' },
  LEATHER: { ar: 'جلد طبيعي', en: 'Leather', also: ['جلد'] },
  FAUX_LEATHER: { ar: 'جلد صناعي', en: 'Faux leather' },
};
export const OTHER_FIBER: Words = { ar: 'أخرى', en: 'Other' };

/** «الألوان والمقاسات»: one row per colour x size (the branch quantity columns follow). */
export const VERSION_COLUMNS = {
  ref: PRODUCT_COLUMNS.ref,
  color_name_ar: { ar: 'اسم اللون بالعربية', en: 'Colour name (Arabic)' },
  color_name_en: { ar: 'اسم اللون بالإنجليزية', en: 'Colour name (English)' },
  color_family: { ar: 'عائلة اللون', en: 'Colour family' },
  color_hex: { ar: 'لون العينة (HEX)', en: 'Swatch colour (HEX)' },
  color_order: { ar: 'ترتيب اللون', en: 'Colour order' },
  size: { ar: 'المقاس', en: 'Size' },
} as const satisfies Record<string, Words>;

/**
 * «الصور» (2026-11-18, images in bulk): one row per image - the product, the
 * colour (empty for a shared image), the file's name inside the ZIP, its
 * kind and its order. Exactly one main image per colour.
 */
export const IMAGE_COLUMNS = {
  ref: PRODUCT_COLUMNS.ref,
  color_name_ar: VERSION_COLUMNS.color_name_ar,
  file: { ar: 'اسم ملف الصورة', en: 'Image file name' },
  kind: { ar: 'نوع الصورة', en: 'Image type' },
  order: { ar: 'الترتيب', en: 'Order' },
} as const satisfies Record<string, Words>;

export const IMAGE_KIND_WORDS = {
  MAIN: { ar: 'رئيسية', en: 'Main' },
  EXTRA: { ar: 'إضافية', en: 'Extra' },
  SHARED: { ar: 'مشتركة', en: 'Shared' },
} as const satisfies Record<string, Words>;
export type ImageKind = keyof typeof IMAGE_KIND_WORDS;

/** A branch's quantity column: «الكمية: <branch>». */
export const QTY_PREFIX: Words = { ar: 'الكمية: ', en: 'Quantity: ' };
/** A specification column: «مواصفة: <name>». */
export const SPEC_PREFIX: Words = { ar: 'مواصفة: ', en: 'Spec: ' };

export const NO_BRAND: Words = {
  ar: 'بدون علامة تجارية',
  en: 'No brand',
};

export const SIZE_SYSTEM_WORDS: Record<string, Words> = {
  LETTER: { ar: 'حروف', en: 'Letters' },
  EU: { ar: 'أوروبي', en: 'European' },
  KIDS_AGE: { ar: 'عمر الأطفال', en: "Children's age" },
  ONE_SIZE: { ar: 'مقاس واحد', en: 'One size' },
};

/** The specification fields' names (the wizard's «wz.spec.*»). */
export const SPEC_FIELD_WORDS: Record<string, Words> = {
  material: { ar: 'الخامة', en: 'Material' },
  upper_material: { ar: 'خامة الجزء العلوي', en: 'Upper material' },
  pattern: { ar: 'النقشة', en: 'Pattern' },
  length: { ar: 'الطول', en: 'Length' },
  sleeve_type: { ar: 'نوع الكم', en: 'Sleeves' },
  fit: { ar: 'المقاس على الجسم', en: 'Fit on the body' },
  stretch: { ar: 'مطاطية القماش', en: 'Fabric stretch' },
  occasion: { ar: 'المناسبة', en: 'Occasion' },
  care: { ar: 'طريقة العناية', en: 'Care' },
  cut: { ar: 'القصّة', en: 'Cut' },
  length_or_waist: { ar: 'الطول أو الخصر', en: 'Length or waist' },
  closure_type: { ar: 'نوع الإغلاق', en: 'Closure' },
  piece_count: { ar: 'عدد القطع', en: 'Pieces' },
  age_range: { ar: 'الفئة العمرية', en: 'Age range' },
  detail: { ar: 'تفاصيل إضافية', en: 'Extra details' },
  sole_type: { ar: 'نوع النعل', en: 'Sole' },
  size_system: { ar: 'نظام المقاسات', en: 'Size system' },
  bag_type: { ar: 'نوع الحقيبة', en: 'Bag type' },
  dimensions: { ar: 'الأبعاد', en: 'Dimensions' },
  sub_type: { ar: 'النوع', en: 'Type' },
  stone_or_finish: { ar: 'الحجر أو اللمسة', en: 'Stone or finish' },
  dimensions_or_size: { ar: 'الأبعاد أو المقاس', en: 'Dimensions or size' },
};

/** The closed lists' values (the web's CODED_SPECS). */
export const SPEC_VALUE_WORDS: Record<string, Record<string, Words>> = {
  fit: {
    SLIM: { ar: 'ضيّق', en: 'Slim' },
    REGULAR: { ar: 'عادي', en: 'Regular' },
    LOOSE: { ar: 'واسع', en: 'Loose' },
    OVERSIZED: { ar: 'أوفرسايز', en: 'Oversized' },
  },
  stretch: {
    NONE: { ar: 'بلا مطاطية', en: 'No stretch' },
    SLIGHT: { ar: 'مطاطية قليلة', en: 'Slight stretch' },
    HIGH: { ar: 'مطاطية عالية', en: 'High stretch' },
  },
  occasion: {
    CASUAL: { ar: 'يومي', en: 'Everyday' },
    EVENING: { ar: 'سهرة', en: 'Evening' },
    WORK: { ar: 'عمل', en: 'Work' },
    SPORT: { ar: 'رياضة', en: 'Sport' },
    HOME: { ar: 'منزلي', en: 'Home' },
    FORMAL: { ar: 'رسمي', en: 'Formal' },
    EID: { ar: 'مناسبات وأعياد', en: 'Eid and occasions' },
  },
  care: {
    HAND_WASH: { ar: 'غسيل يدوي', en: 'Hand wash' },
    MACHINE_WASH: { ar: 'غسيل آلي', en: 'Machine wash' },
    DRY_CLEAN: { ar: 'تنظيف جاف', en: 'Dry clean' },
    NO_BLEACH: { ar: 'بدون مبيّض', en: 'No bleach' },
    NO_TUMBLE_DRY: { ar: 'بدون مجفف', en: 'No tumble dry' },
    IRON_LOW: { ar: 'كي بحرارة منخفضة', en: 'Iron on low' },
  },
};

/** The size table's measurements (the wizard's «wz.key.*»). */
export const MEASURE_WORDS: Record<string, Words> = {
  CHEST: { ar: 'الصدر', en: 'Chest' },
  WAIST: { ar: 'الخصر', en: 'Waist' },
  HIP: { ar: 'الورك', en: 'Hip' },
  LENGTH: { ar: 'الطول', en: 'Length' },
  SHOULDER: { ar: 'الكتف', en: 'Shoulder' },
  SLEEVE: { ar: 'الكم', en: 'Sleeve' },
  INSEAM: { ar: 'طول الساق الداخلي', en: 'Inseam' },
  FOOT_LENGTH: { ar: 'طول القدم', en: 'Foot length' },
  HEIGHT: { ar: 'طول الطفل', en: "Child's height" },
};

/**
 * Words compared the way people type them: trimmed, inner spaces collapsed,
 * Arabic letter forms unified (أ/إ/آ -> ا, ة -> ه, ى -> ي), marks removed,
 * Latin case-insensitive.
 */
export function plain(value: string): string {
  return value
    .replace(/[ً-ٰٟـ​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Which key a header names (Arabic or English, typed loosely), or null. */
export function headerKey<K extends string>(
  header: string,
  columns: Record<K, Words>,
): K | null {
  const h = plain(header);
  for (const [key, w] of Object.entries(columns) as [K, Words][]) {
    if (plain(w.ar) === h || plain(w.en) === h || plain(key) === h) return key;
  }
  return null;
}

export function inLang(w: Words, lang: 'ar' | 'en'): string {
  return lang === 'en' ? w.en : w.ar;
}
