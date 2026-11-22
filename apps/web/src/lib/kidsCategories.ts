// Kids taxonomy mirrors the category codes currently approved for the KIDS
// audience. Category imagery is stored in public/images/kids-categories.
import type { WomenCategory as KidsCategory } from "./womenCategories";

const imageFor = (label: string, slug: string) => {
  const filename = slug === "baby-bodysuits" ? "ملابس مواليد" : slug === "accessories" ? "إكسسوارات الشعر" : label;
  return `/images/kids-categories/${encodeURIComponent(filename)}.png`;
};

export const KIDS_CATEGORIES: KidsCategory[] = [
  ["shirts", "قمصان"], ["t-shirts", "تيشيرتات"], ["tops", "بلايز"],
  ["trousers", "بناطيل"], ["jeans", "جينز"], ["formal-trousers", "بناطيل رسمية"],
  ["shorts", "شورتات"], ["jackets", "جكيتات"], ["coats", "معاطف"],
  ["hoodies", "هوديز"], ["sweatshirts", "سويت شيرت"], ["knitwear", "كنزات وتريكو"],
  ["girls-dresses", "فساتين بنات"], ["skirts", "تنانير"], ["leggings", "ليغينغز"],
  ["formal-suits", "بدلات رسمية"], ["two-piece-sets", "أطقم من قطعتين"],
  ["multi-piece-sets", "أطقم متعددة القطع"], ["jumpsuits", "جمبسوت وأوفرولات"],
  ["sportswear", "ملابس رياضية"], ["swimwear", "ملابس سباحة"], ["sleepwear", "ملابس نوم"],
  ["loungewear", "ملابس منزلية"], ["underwear", "ملابس داخلية"],
  ["newborn", "ملابس مواليد"], ["dungarees", "سالوبيت"], ["baby-bodysuits", "بودي أطفال"],
  ["occasion-wear", "ملابس مناسبات وأعياد"], ["shoes", "أحذية"], ["bags", "حقائب"],
  ["jewellery", "مجوهرات"], ["watches", "ساعات"], ["eyewear", "نظارات"],
  ["belts", "أحزمة"], ["hats-caps", "قبعات وطواقي"], ["accessories", "إكسسوارات"],
  ["socks", "جوارب"], ["hair-accessories", "إكسسوارات الشعر"],
].map(([slug, label]) => ({ slug, label, image: imageFor(label, slug) }));
