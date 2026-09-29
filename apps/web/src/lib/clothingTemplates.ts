// Sprint 17 (PDR-036): the same ten fixed clothing/accessory category
// templates and their four non-brand structural fields as the backend's
// own offers/catalog/clothing-category-templates.ts - kept in sync by
// hand (no shared package between apps/api and apps/web in this repo).
// A category outside these ten has no template at all - the form falls
// back to the free-text specs fields.
export type ClothingCategoryTemplate =
  | "DRESSES"
  | "TOPS_SHIRTS"
  | "BOTTOMS"
  | "COATS_JACKETS"
  | "SETS_PYJAMAS"
  | "KIDS_CLOTHING"
  | "SHOES"
  | "BAGS"
  | "JEWELLERY_WATCHES"
  | "OTHER_ACCESSORIES";

export const CLOTHING_CATEGORY_TEMPLATE_LABELS: Record<ClothingCategoryTemplate, string> = {
  DRESSES: "فساتين",
  TOPS_SHIRTS: "قمصان وتيشيرتات",
  BOTTOMS: "بناطيل وتنانير",
  COATS_JACKETS: "معاطف وجاكيتات",
  SETS_PYJAMAS: "أطقم وبيجامات",
  KIDS_CLOTHING: "ملابس أطفال",
  SHOES: "أحذية",
  BAGS: "حقائب",
  JEWELLERY_WATCHES: "مجوهرات وساعات",
  OTHER_ACCESSORIES: "إكسسوارات أخرى",
};

export const CLOTHING_CATEGORY_TEMPLATE_FIELDS: Record<ClothingCategoryTemplate, readonly string[]> = {
  DRESSES: ["material", "pattern", "length", "sleeve_type"],
  TOPS_SHIRTS: ["material", "pattern", "fit", "sleeve_type"],
  BOTTOMS: ["material", "pattern", "cut", "length_or_waist"],
  COATS_JACKETS: ["material", "pattern", "closure_type", "length"],
  SETS_PYJAMAS: ["material", "pattern", "piece_count", "cut"],
  KIDS_CLOTHING: ["age_range", "material", "pattern", "detail"],
  SHOES: ["upper_material", "closure_type", "sole_type", "size_system"],
  BAGS: ["material", "bag_type", "dimensions", "closure_type"],
  JEWELLERY_WATCHES: ["material", "sub_type", "stone_or_finish", "dimensions"],
  OTHER_ACCESSORIES: ["material", "sub_type", "pattern", "dimensions_or_size"],
};

const FIELD_LABELS: Record<string, string> = {
  material: "الخامة",
  pattern: "النقشة",
  length: "الطول",
  sleeve_type: "نوع الكم",
  fit: "القصّة",
  cut: "القصّة",
  length_or_waist: "الطول أو الخصر",
  closure_type: "نوع الإغلاق",
  piece_count: "عدد القطع",
  age_range: "الفئة العمرية",
  detail: "تفاصيل إضافية",
  upper_material: "خامة الجزء العلوي",
  sole_type: "نوع النعل",
  size_system: "نظام المقاسات",
  bag_type: "نوع الحقيبة",
  dimensions: "الأبعاد",
  sub_type: "النوع الفرعي",
  stone_or_finish: "الحجر أو التشطيب",
  dimensions_or_size: "الأبعاد أو المقاس",
};

export function templateFieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

export const ALL_CLOTHING_TEMPLATES = Object.keys(
  CLOTHING_CATEGORY_TEMPLATE_LABELS,
) as ClothingCategoryTemplate[];
