// The women's page category grid - presentation only (slug, label,
// image). Which products belong to a category is decided by the API
// (apps/api/src/discovery/women-categories.ts, matched on the server so
// it works across paginated results); the slugs here must match it.
// Images are licensed demo photography (Pexels License, see
// public/images/women-categories/CREDITS.md).
export interface WomenCategory {
  slug: string;
  label: string;
  image: string;
}

const img = (slug: string) => `/images/women-categories/${slug}.jpg`;

export const WOMEN_CATEGORIES: WomenCategory[] = [
  { slug: "dresses", label: "فساتين", image: img("dresses") },
  { slug: "tops", label: "بلايز وتوبات", image: img("summer-tops") },
  { slug: "t-shirts", label: "تيشيرتات", image: img("t-shirts") },
  { slug: "shirts", label: "قمصان", image: img("shirts") },
  { slug: "trousers", label: "بناطيل", image: img("trousers") },
  { slug: "jeans", label: "جينز", image: img("jeans") },
  { slug: "skirts", label: "تنانير", image: img("skirts") },
  { slug: "shorts", label: "شورتات", image: img("shorts") },
  { slug: "jackets", label: "جكيتات", image: img("jackets") },
  { slug: "coats", label: "معاطف", image: img("coats") },
  { slug: "blazers", label: "بليزرات", image: img("blazers") },
  { slug: "cardigans", label: "كارديغان", image: img("cardigans") },
  { slug: "hoodies", label: "هوديز", image: img("hoodies") },
  { slug: "sweatshirts", label: "سويت شيرت", image: img("sweatshirts") },
  { slug: "knitwear", label: "كنزات وتريكو", image: img("winter-tops") },
  { slug: "two-piece-sets", label: "أطقم من قطعتين", image: img("two-piece-sets") },
  { slug: "jumpsuits", label: "جمبسوت وأوفرولات", image: img("overalls") },
  { slug: "suits", label: "بدلات رسمية", image: img("suits") },
  { slug: "activewear", label: "ملابس رياضية", image: img("activewear") },
  { slug: "swimwear", label: "ملابس سباحة", image: img("beachwear") },
  { slug: "sleepwear", label: "ملابس نوم", image: img("pajamas") },
  { slug: "loungewear", label: "ملابس منزلية", image: img("loungewear") },
  { slug: "underwear", label: "ملابس داخلية", image: img("underwear") },
  { slug: "lingerie", label: "لانجري", image: img("lingerie") },
  { slug: "maternity", label: "ملابس حمل", image: img("maternity") },
  { slug: "modest-wear", label: "ملابس محجبات", image: img("hijab") },
  { slug: "abayas", label: "عبايات", image: img("abayas") },
  { slug: "kaftans", label: "جلابيات وقفاطين", image: img("kaftans") },
  { slug: "hijabs-shawls", label: "حجابات وشالات", image: img("scarves") },
  { slug: "shoes", label: "أحذية", image: img("shoes") },
  { slug: "bags", label: "حقائب", image: img("bags") },
  { slug: "jewelry", label: "مجوهرات", image: img("jewelry") },
  { slug: "watches", label: "ساعات", image: img("watches") },
  { slug: "sunglasses", label: "نظارات", image: img("sunglasses") },
  { slug: "belts", label: "أحزمة", image: img("belts") },
  { slug: "hats", label: "قبعات وطواقي", image: img("hats") },
  { slug: "accessories", label: "إكسسوارات", image: img("accessories-flatlay") },
  { slug: "socks", label: "جوارب", image: img("socks") },
];
