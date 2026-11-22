import type { WomenCategory } from "./womenCategories";

const replacementImages: Record<string, string> = {
  swimwear: "swimwear-new.jpeg",
  underwear: "underwear-new.jpg",
  shoes: "shoes-new.jpg",
  sportswear: "sportswear-new.webp",
  eyewear: "eyewear-new.webp",
  socks: "socks-new.webp",
  watches: "watches-new.jpg",
  "two-piece-sets": "two-piece-sets-new.webp",
  sleepwear: "sleep.png",
  "hats-caps": "hats-caps-new.webp",
  "formal-trousers": "formal-trousers-new.webp",
  shorts: "shorts-new.webp",
  jewellery: "jewellery-new.webp",
  shirts: "shirts-new.jpg",
  knitwear: "knitwear-new.jpg",
};

const image = (name: string) => `/images/men-categories/${replacementImages[name] ?? `${name}.jpg`}`;

// Mirrors the MEN audience in the Sprint 27 taxonomy. Dedicated men's
// photography can replace these local presentation thumbnails independently.
export const MEN_CATEGORIES: WomenCategory[] = [
  { slug: "shirts", label: "قمصان", image: image("shirts") },
  { slug: "t-shirts", label: "تيشيرتات", image: image("t-shirts") },
  { slug: "blouses-men", label: "بلايز", image: image("blouses-men") },
  { slug: "trousers", label: "بناطيل", image: image("trousers") },
  { slug: "jeans", label: "جينز", image: image("jeans") },
  { slug: "formal-trousers", label: "بناطيل رسمية", image: image("formal-trousers") },
  { slug: "shorts", label: "شورتات", image: image("shorts") },
  { slug: "jackets", label: "جكيتات", image: image("jackets") },
  { slug: "coats", label: "معاطف", image: image("coats") },
  { slug: "blazers", label: "بليزرات", image: image("blazers") },
  { slug: "hoodies", label: "هوديز", image: image("hoodies") },
  { slug: "sweatshirts", label: "سويت شيرت", image: image("sweatshirts") },
  { slug: "knitwear", label: "كنزات وتريكو", image: image("knitwear") },
  { slug: "formal-suits", label: "بدلات رسمية", image: image("formal-suits") },
  { slug: "two-piece-sets", label: "أطقم من قطعتين", image: image("two-piece-sets") },
  { slug: "sportswear", label: "ملابس رياضية", image: image("sportswear") },
  { slug: "swimwear", label: "ملابس سباحة", image: image("swimwear") },
  { slug: "sleepwear", label: "ملابس نوم", image: image("sleepwear") },
  { slug: "loungewear", label: "ملابس منزلية", image: image("loungewear") },
  { slug: "underwear", label: "ملابس داخلية", image: image("underwear") },
  { slug: "shoes", label: "أحذية", image: image("shoes") },
  { slug: "bags", label: "حقائب", image: image("bags") },
  { slug: "wallets", label: "محافظ", image: image("wallets") },
  { slug: "jewellery", label: "مجوهرات", image: image("jewellery") },
  { slug: "watches", label: "ساعات", image: image("watches") },
  { slug: "eyewear", label: "نظارات", image: image("eyewear") },
  { slug: "belts", label: "أحزمة", image: image("belts") },
  { slug: "hats-caps", label: "قبعات وطواقي", image: image("hats-caps") },
  { slug: "accessories", label: "إكسسوارات", image: image("accessories") },
  { slug: "socks", label: "جوارب", image: image("socks") },
];
