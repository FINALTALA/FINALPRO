// PD-4: size guides - shapes from the API, the cm/inch display choice
// (this browser only) and value formatting. Pure helpers, no DOM beyond
// the guarded localStorage access.

import { adminErrorMessage } from "./admin";
import { ApiError } from "./api";

export type SizeMeasureKey =
  | "CHEST"
  | "WAIST"
  | "HIP"
  | "LENGTH"
  | "SHOULDER"
  | "SLEEVE"
  | "INSEAM"
  | "FOOT_LENGTH"
  | "HEIGHT";
export type SizeUnit = "cm" | "in";

export interface SizeGuideValue {
  min: number;
  max: number | null;
}

export interface SizeGuideDto {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  /** Phase A+: OFFER = the product's own measurements table, entered by its store. */
  kind: "STANDARD" | "PRODUCT" | "OFFER";
  version_id: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "RETIRED";
  basis: "BODY" | "GARMENT";
  notes_ar: string | null;
  notes_en: string | null;
  published_at: string | null;
  unit: "cm";
  audiences: ("WOMEN" | "MEN" | "KIDS")[];
  measurements: { key: SizeMeasureKey; label_ar: string; label_en: string; is_range: boolean }[];
  rows: {
    size_code: string;
    size_label: string;
    size_group: "ADULT" | "KIDS_AGE";
    values: Partial<Record<SizeMeasureKey, SizeGuideValue>>;
  }[];
}

export interface SizeGuidePublicDto {
  guides: SizeGuideDto[];
  offer_sizes: string[];
  sizes_not_in_guide: string[];
}

export const MEASURE_KEYS: SizeMeasureKey[] = ["CHEST", "WAIST", "HIP", "LENGTH", "SHOULDER", "SLEEVE", "INSEAM", "FOOT_LENGTH", "HEIGHT"];
export const MEASURE_LABEL_AR: Record<SizeMeasureKey, string> = {
  CHEST: "الصدر",
  WAIST: "الخصر",
  HIP: "الورك",
  LENGTH: "الطول",
  SHOULDER: "الكتف",
  SLEEVE: "الكم",
  INSEAM: "طول الساق الداخلي",
  FOOT_LENGTH: "طول القدم",
  HEIGHT: "طول الطفل",
};

const UNIT_KEY = "finalpro_size_unit";

/** The display unit this browser last chose (cm by default). */
export function readSizeUnit(): SizeUnit {
  try {
    return localStorage.getItem(UNIT_KEY) === "in" ? "in" : "cm";
  } catch {
    return "cm";
  }
}

export function writeSizeUnit(unit: SizeUnit): void {
  try {
    localStorage.setItem(UNIT_KEY, unit);
  } catch {
    // Storage blocked: the choice still applies to this open window.
  }
}

/** cm -> the display unit, one decimal; inches are 2.54 cm. */
export function convert(cm: number, unit: SizeUnit): number {
  return unit === "cm" ? cm : Math.round((cm / 2.54) * 10) / 10;
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** "88–92", "88" or "-" when the guide has no value for this cell. */
export function formatMeasure(value: SizeGuideValue | undefined, unit: SizeUnit): string {
  if (!value) return "-";
  const min = num(convert(value.min, unit));
  return value.max === null ? min : `${min}–${num(convert(value.max, unit))}`;
}

const ERROR_AR: Record<string, string> = {
  SIZE_GUIDE_CODE_TAKEN: "هذا الرمز مستخدم لدليل آخر",
  PRODUCT_GUIDE_EXISTS: "لهذا المنتج المرجعي دليل خاص بالفعل",
  CANONICAL_PRODUCT_REQUIRED: "دليل المنتج يحتاج اختيار منتج مرجعي",
  CANONICAL_PRODUCT_NOT_FOUND: "المنتج المرجعي غير موجود",
  CANONICAL_PRODUCT_NOT_ALLOWED: "الدليل القياسي لا يرتبط بمنتج واحد",
  SIZE_GUIDE_VERSION_IMMUTABLE: "هذا الإصدار منشور أو متقاعد ولا يمكن تعديله - أنشئي إصداراً جديداً",
  SIZE_GUIDE_DRAFT_EXISTS: "توجد مسودة مفتوحة لهذا الدليل",
  NOTHING_PUBLISHED: "لا يوجد إصدار منشور لإيقافه",
  NOT_A_STANDARD_GUIDE: "الفئات تُربط بالأدلة القياسية فقط؛ دليل المنتج يطبَّق على منتجه",
  DUPLICATE_PAIR: "تكرر نفس التصنيف والفئة أكثر من مرة",
  UNKNOWN_CATEGORY_AUDIENCE: "هذا التصنيف لا ينتمي لهذه الفئة",
  SIZE_GROUP_NOT_ALLOWED: "مقاسات الدليل لا تناسب الفئة (مقاسات البالغين مقابل أعمار الأطفال)",
  DEFAULT_GUIDE_EXISTS: "يوجد دليل افتراضي آخر لهذا التصنيف والفئة",
  BASIS_NOT_ALLOWED: "الدليل القياسي يعتمد قياسات الجسم فقط",
  SIZE_GUIDE_EMPTY: "أضيفي قياساً واحداً ومقاساً واحداً على الأقل",
  DUPLICATE_MEASUREMENT: "تكرر عمود قياس",
  TOO_MANY_ROWS: "عدد المقاسات أكبر من المسموح",
  DUPLICATE_SIZE: "تكرر مقاس",
  UNKNOWN_SIZE: "مقاس غير معروف في التصنيف",
  VALUE_FOR_UNKNOWN_MEASUREMENT: "قيمة لعمود غير مضاف",
  INVALID_VALUE: "قيمة غير صالحة (رقم بخانة عشرية واحدة على الأكثر)",
  SIZE_VALUE_OUT_OF_RANGE: "قيمة خارج المدى المعقول لهذا القياس",
  NOT_A_RANGE: "هذا العمود قيمة واحدة وليس مدى",
  INVALID_RANGE: "نهاية المدى أصغر من بدايته",
  NOTE_TOO_LONG: "الملاحظات أطول من 1000 حرف",
  SIZE_GUIDE_INCOMPLETE: "لا يُنشر الدليل قبل تعبئة كل الخانات (وطرفي كل مدى)",
  SIZE_VALUES_NOT_MONOTONIC: "القيم يجب ألا تنقص من مقاس إلى المقاس الأكبر",
  DECISION_NOTE_REQUIRED: "اكتبي سبب الرفض",
  GUIDE_REQUIRED: "اختاري الدليل المعتمد لربطه بالطلب",
  SIZE_GUIDE_NOT_APPLICABLE: "الدليل غير منشور أو لا ينطبق على فئة العرض",
  SIZE_GUIDE_REQUEST_DECIDED: "تم البت في هذا الطلب مسبقاً",
};

/** An API error of the size-guide endpoints, in Arabic, with the sizes/columns it names. */
export function sizeGuideErrorAr(code: string, fallback: string, details: unknown[] = []): string {
  const base = ERROR_AR[code];
  if (!base) return fallback;
  const named = details.filter((d) => typeof d === "string" || typeof d === "number").map((d) => MEASURE_LABEL_AR[String(d) as SizeMeasureKey] ?? String(d));
  return named.length ? `${base}: ${named.join("، ")}` : base;
}

/** An admin size-guide call's failure, in Arabic. */
export function sizeGuideAdminError(err: unknown): string {
  return err instanceof ApiError ? sizeGuideErrorAr(err.code, adminErrorMessage(err), err.details) : adminErrorMessage(err);
}

export const AUDIENCE_LABEL_AR: Record<string, string> = { WOMEN: "نساء", MEN: "رجال", KIDS: "أطفال" };

export interface AdminSizeGuideSummary {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  kind: "STANDARD" | "PRODUCT";
  canonical_product: { id: string; name: string } | null;
  applicability: { category_code: string; audience: string; is_default: boolean }[];
  published_version: { id: string; version: number; published_at: string | null } | null;
  draft_version: { id: string; version: number } | null;
  versions: { id: string; version: number; status: "DRAFT" | "PUBLISHED" | "RETIRED"; published_at: string | null }[];
}

export type SizeGuideContent = Omit<SizeGuideDto, "audiences">;

export interface AdminSizeGuideDetail extends AdminSizeGuideSummary {
  draft: SizeGuideContent | null;
  published: SizeGuideContent | null;
}

/** PD-4: the size-guide version an order line was bought under (null when none applied). */
export interface SizeGuideSnapshot {
  guide_id: string;
  version_id: string;
  version: number;
  name_ar: string;
  name_en: string;
  published_at: string | null;
}

/**
 * A taxonomy size's label for the UI language. The stored labels of the
 * age sizes are Arabic ("4–5 سنوات"), so English reads them from the
 * code; letter/EU sizes are the same in both. Display only.
 */
export function sizeLabelFor(code: string, label: string, lang: "ar" | "en"): string {
  if (lang === "ar") return label;
  if (code === "ONE_SIZE") return "One Size";
  const age = /^AGE_(\d+)_(\d+)([MY])$/.exec(code);
  if (age) return `${age[1]}–${age[2]} ${age[3] === "M" ? "months" : "years"}`;
  return label;
}

/** The size-guide window and links in the app's two languages (the data itself is not translated). */
export const SIZE_GUIDE_TEXT = {
  ar: {
    title: "دليل المقاسات",
    /** Phase A+: the product's own table (garment, cm). */
    ownTitle: "جدول المقاسات (سم)",
    ownTitleInch: "جدول المقاسات (إنش)",
    open: "دليل المقاسات",
    openLong: "عرض دليل المقاسات",
    notMySize: "ليس مقاسك؟",
    close: "إغلاق دليل المقاسات",
    loading: "جارٍ تحميل الدليل…",
    loadError: "تعذّر تحميل دليل المقاسات",
    empty: "لا يتوفر دليل مقاسات لهذا المنتج حالياً.",
    audienceTabs: "الفئة",
    audience: { WOMEN: "نساء", MEN: "رجال", KIDS: "أطفال" } as Record<string, string>,
    unitGroup: "وحدة القياس",
    cm: "سم",
    inch: "إنش",
    fitNote: "قارني قياساتك بالجدول واختاري المقاس الأقرب. هذا الدليل لا يوصي بمقاس آلياً.",
    bodyBasis: "قياسات الجسم",
    garmentBasis: "قياسات القطعة نفسها",
    inCm: "بالسنتيمتر",
    inInch: "بالإنش (محوّلة من السنتيمتر)",
    selected: "المقاس المختار",
    table: "جدول المقاسات",
    size: "المقاس",
    inOffer: "متوفر في هذا العرض",
    legend: "مقاسات هذا العرض",
    notInGuide: "بعض مقاسات هذا العرض غير موجودة في الدليل",
    howToMeasure: "كيف تقيسين",
    updated: "آخر تحديث للدليل",
  },
  en: {
    title: "Size guide",
    ownTitle: "Size table (cm)",
    ownTitleInch: "Size table (in)",
    open: "Size guide",
    openLong: "View the size guide",
    notMySize: "Not your size?",
    close: "Close size guide",
    loading: "Loading the guide…",
    loadError: "Couldn't load the size guide",
    empty: "No size guide is available for this product right now.",
    audienceTabs: "Department",
    audience: { WOMEN: "Women", MEN: "Men", KIDS: "Kids" } as Record<string, string>,
    unitGroup: "Unit",
    cm: "cm",
    inch: "in",
    fitNote: "Compare your measurements with the table and pick the closest size. This guide doesn't recommend a size automatically.",
    bodyBasis: "Body measurements",
    garmentBasis: "Garment measurements",
    inCm: "in centimetres",
    inInch: "in inches (converted from cm)",
    selected: "Selected size",
    table: "Size table",
    size: "Size",
    inOffer: "Available in this listing",
    legend: "Sizes in this listing",
    notInGuide: "Some sizes of this listing aren't in the guide",
    howToMeasure: "How to measure",
    updated: "Guide last updated",
  },
};
