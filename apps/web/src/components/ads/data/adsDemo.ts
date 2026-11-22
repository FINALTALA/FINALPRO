// DEMO DATA for the Advertising page - ported from the AI Studio design
// (via-advertising-hero/src/data). Every store, story, reel and featured ad
// here is a design placeholder, NOT a Via store or a real advertiser:
// everything is flagged `demo: true` and the UI marks it as demo.
//
// Kept from the design: names, captions, media, layout settings.
// Left out on purpose (they were invented, not Via data): product prices,
// like counts and pre-set liked/saved states. Fields for them stay in the
// types so real data can fill them later.
//
// Replace with live data once Via has stories / reels / ad placements.

import type { Bi } from "../adsCopy";

const ST = "/advertising/stories";
const RL = "/advertising/reels";
const FA = "/advertising/featured-ads";

export type AdsCategory = "Women" | "Men" | "Kids" | "Accessories" | "Shoes" | "Bags" | "Jewelry" | "Sports";

/** A store as the ads sections show it. `slug` = a real Via store (links
 *  and follow work); null = a demo placeholder. */
export type AdsStore = {
  id: string;
  slug: string | null;
  name: Bi;
  monogram: string;
  logo?: string | null;
  demo: boolean;
};

// ------------------------------------------------------------------ hero
export type HeroSlide = {
  id: "women" | "men" | "handbags";
  image: { src: string; srcSet: string; w: number; h: number };
  alt: Bi;
  objectPosition: string;
  title: Bi;
  subtitle: Bi;
  /** Text block placement on the image (physical: does not move with the language). */
  textBox: { left: string; top: string; maxWidth: string; center?: boolean };
  /** Phones (< 768 px): crop and text placement where they differ. */
  mobile?: { objectPosition?: string; textBox?: { left: string; top: string; maxWidth: string } };
  /** Text colour for the image under it: "dark" (default) or "light";
   *  light text gets a soft local shade so it reads on any part of the image. */
  tone?: "dark" | "light";
  toneMobile?: "dark" | "light";
  /** The store block's tone for the corner of the image it sits on. */
  storeTone?: "dark" | "light";
  storeToneMobile?: "dark" | "light";
  store: AdsStore & { subline: Bi; logoBg: "dark" | "darker" | "warm" };
};

const hero = (name: string) => ({
  src: `${FA}/${name}.webp`,
  srcSet: `${FA}/${name}-1000.webp 1000w, ${FA}/${name}.webp 1983w`,
  w: 1983,
  h: 793,
});

export const HERO_SLIDES: HeroSlide[] = [
  {
    id: "women",
    image: hero("campaign-women-auburn"),
    alt: { ar: "عارضة أزياء بشعر أحمر ترتدي ملابس كريمية في وضعيتين", en: "Red-haired model in cream clothing in two editorial poses" },
    objectPosition: "center 40%",
    title: { ar: "أساسيات كل يوم", en: "Everyday Essentials" },
    subtitle: { ar: "قطع بسيطة، بأسلوبك.", en: "Made for your everyday." },
    textBox: { left: "50%", top: "24%", maxWidth: "440px", center: true },
    store: {
      id: "store-maison-via", slug: null, demo: true, monogram: "MV",
      name: { ar: "ميزون فيا", en: "Maison Via" },
      subline: { ar: "شريك الحملة • تشكيلة الاستوديو", en: "Campaign Partner • Studio Collection" },
      logoBg: "dark",
    },
  },
  {
    id: "men",
    image: hero("campaign-men-denim"),
    alt: { ar: "عارض أزياء جالس يرتدي قميصاً أبيض وجينز أزرق على خلفية بيج", en: "Seated male model wearing a white T-shirt and blue jeans" },
    objectPosition: "center 45%",
    title: { ar: "أسلوبك، كل يوم", en: "Everyday Style" },
    subtitle: { ar: "أساسيات رجالية بتفاصيل مختلفة.", en: "The essentials, redefined." },
    textBox: { left: "8%", top: "32%", maxWidth: "440px" },
    store: {
      id: "store-via-form", slug: null, demo: true, monogram: "VF",
      name: { ar: "فيا فورم", en: "Via Form" },
      subline: { ar: "شريك الحملة • أساسيات الدنيم", en: "Campaign Partner • Denim & Essentials" },
      logoBg: "darker",
    },
  },
  {
    id: "handbags",
    image: hero("campaign-handbags-trio"),
    alt: { ar: "ثلاث حقائب يد جلدية باللون الأسود والرمادي والبيج", en: "Three leather handbags in black, taupe, and cream" },
    objectPosition: "100% 50%",
    title: { ar: "تفاصيل تكمّل إطلالتك", en: "The Bag Edit" },
    subtitle: { ar: "تشكيلة حقائب لكل مناسبة.", en: "A bag for every occasion." },
    textBox: { left: "67%", top: "22%", maxWidth: "430px" },
    mobile: { objectPosition: "38% 50%", textBox: { left: "0%", top: "23%", maxWidth: "100%" } },
    toneMobile: "light",
    storeTone: "light",
    store: {
      id: "store-via-cuir", slug: null, demo: true, monogram: "VC",
      name: { ar: "فيا كوير", en: "Via Cuir" },
      subline: { ar: "شريك الحملة • منتجات جلدية", en: "Campaign Partner • Leather Atelier" },
      logoBg: "warm",
    },
  },
];

// --------------------------------------------------------------- stores
// The design's placeholder stores (shared by stories, reels, ads, stores).
const S = (id: string, ar: string, en: string, monogram: string): AdsStore => ({ id, slug: null, demo: true, monogram, name: { ar, en } });
export const DEMO_STORES = {
  atelierNoir: S("store-latelier-noir", "لاتيلييه نوار", "L'Atelier Noir", "AN"),
  maisonBlanche: S("store-maison-blanche", "ميزون بلانش", "Maison Blanche", "MB"),
  aura: S("store-aura-jewelry", "أورا للمجوهرات", "Aura Fine Jewelry", "AJ"),
  studioDenim: S("store-studio-denim", "استوديو دينيم", "Studio Denim", "SD"),
  polene: S("store-polene-paris", "بولين باريس", "Polène Paris", "PL"),
  sotropa: S("store-sotropa-studio", "استوديو سوتروبا", "Sotropa Studio", "SP"),
  chaussures: S("store-atelier-chaussures", "أتيلييه شوسور", "Atelier Chaussures", "AC"),
  maisonHiver: S("store-maison-hiver", "ميزون إيفر", "Maison Hiver", "MH"),
  miniVia: S("store-mini-via", "ميني فيا للأطفال", "Mini Via Kids", "MV"),
  pdpaola: S("store-pdpaola", "بي دي باولا", "PDPAOLA Fine Jewelry", "PD"),
  uniqueAttraction: S("store-unique-attraction", "يونيك أتراكشن", "Unique Attraction", "UA"),
  modestRoots: S("store-modest-roots", "مودست روتس", "Modest Roots", "MR"),
} as const;

// -------------------------------------------------------------- stories
export type StoryItem = {
  id: string;
  type: "video" | "image";
  src: string;
  cover: string;
  durationSeconds?: number;
  caption: Bi;
};
export type StoryGroup = {
  store: AdsStore;
  cover: string;
  categories: AdsCategory[];
  /** Demo flag for the Following tab (no real follow behind a demo store). */
  followingDemo: boolean;
  sponsored: boolean;
  stories: StoryItem[];
};

const img = (id: string, src: string, ar: string, en: string): StoryItem => ({ id, type: "image", src, cover: src, durationSeconds: 3.5, caption: { ar, en } });
const vid = (id: string, src: string, cover: string, ar: string, en: string): StoryItem => ({ id, type: "video", src, cover, caption: { ar, en } });

export const STORY_GROUPS: StoryGroup[] = [
  {
    store: DEMO_STORES.atelierNoir, cover: `${ST}/8cc27283dbb2d5498d74fc28a23a6d8f.jpg`, categories: ["Women", "Accessories", "Bags"], followingDemo: true, sponsored: false,
    stories: [
      vid("story-an-1", `${ST}/video_eff7cfde1390.mp4`, `${ST}/8cc27283dbb2d5498d74fc28a23a6d8f.jpg`, "معاينة تشكيلة الغد الحصرية", "Sneak peek of the upcoming collection"),
      img("story-an-2", `${ST}/8cc27283dbb2d5498d74fc28a23a6d8f.jpg`, "حملة تشكيلة 2025 الجديدة", "New Collection 2025 editorial campaign"),
    ],
  },
  {
    store: DEMO_STORES.maisonBlanche, cover: `${ST}/ece872f2023ae75bc5dd9365a088081f.jpg`, categories: ["Women"], followingDemo: true, sponsored: false,
    stories: [
      vid("story-mb-1", `${ST}/video_038f6c5d2186.mp4`, `${ST}/ece872f2023ae75bc5dd9365a088081f.jpg`, "تفصيل معاصر وتنسيق يومي", "Modern tailoring & lookbook styling"),
      img("story-mb-2", `${ST}/ece872f2023ae75bc5dd9365a088081f.jpg`, "بنطال واسع بلمسة كلاسيكية راقية", "Wide trousers with retro silhouettes"),
    ],
  },
  {
    store: DEMO_STORES.aura, cover: `${ST}/65dff00712c5dc9973550a1a89c6ddb2.jpg`, categories: ["Women", "Accessories", "Jewelry"], followingDemo: true, sponsored: false,
    stories: [
      vid("story-aj-1", `${ST}/video_c6c83b03abf4.mp4`, `${ST}/65dff00712c5dc9973550a1a89c6ddb2.jpg`, "تنسيق المجوهرات اليومية والإكسسوارات", "Everyday jewelry styling & essentials"),
      img("story-aj-2", `${ST}/65dff00712c5dc9973550a1a89c6ddb2.jpg`, "أساور ذهبية وخواتم مصممة بعناية", "Handcrafted gold cuffs & stacking rings"),
    ],
  },
  {
    store: DEMO_STORES.studioDenim, cover: `${ST}/b1e00d07e4ab64ed0fc612cedbaf7e3d.jpg`, categories: ["Men", "Women"], followingDemo: false, sponsored: true,
    stories: [
      vid("story-sd-1", `${ST}/video_60f56299cea4.mp4`, `${ST}/b1e00d07e4ab64ed0fc612cedbaf7e3d.jpg`, "قصات مريحة وتدرجات دنيم كلاسيكية", "Classic washes & durable cuts"),
      img("story-sd-2", `${ST}/b1e00d07e4ab64ed0fc612cedbaf7e3d.jpg`, "قطع صيفية خفيفة لكل يوم", "Effortless warm weather essentials"),
    ],
  },
  {
    store: DEMO_STORES.polene, cover: `${ST}/download-1000.webp`, categories: ["Women", "Accessories", "Bags"], followingDemo: true, sponsored: false,
    stories: [
      img("story-pl-1", `${ST}/download.webp`, "حقيبة سايم بالجلد المحبب بلون الكونياك", "The Cyme tote bag in cognac textured leather"),
      img("story-pl-2", `${ST}/b3d31e5b10cc4cb97f12e85b035317a4.jpg`, "تشكيلة الألوان الترابية الطبيعية", "The natural earth tones leather edit"),
    ],
  },
  {
    store: DEMO_STORES.sotropa, cover: `${ST}/30d9896936e15d43707252d45be83b89.jpg`, categories: ["Women"], followingDemo: false, sponsored: false,
    stories: [
      img("story-sp-1", `${ST}/30d9896936e15d43707252d45be83b89.jpg`, "جاكيت جلدي عنابي بحزام مزدوج الأزرار", "Burgundy double-breasted belted leather jacket"),
      img("story-sp-2", `${ST}/1c11c0381860897f62558432ff2329af.jpg`, "معطف ترنش طويل بلون العنابي الراقي", "Longline wine-toned trench coat silhouette"),
    ],
  },
  {
    store: DEMO_STORES.chaussures, cover: `${ST}/97a7d1e4f920bf520a6f0a846b58f641.jpg`, categories: ["Women", "Accessories", "Shoes"], followingDemo: true, sponsored: false,
    stories: [
      img("story-ac-1", `${ST}/97a7d1e4f920bf520a6f0a846b58f641.jpg`, "حذاء كاحل جلدي أسود بمقدمة مربعة وكعب مريح", "Square-toe black leather block-heel boots"),
      img("story-ac-2", `${ST}/d52153d4c362aff45d6483a25024e079.jpg`, "دليل الأحذية الشتوية بتصاميم متعددة", "The full winter boots silhouette catalog"),
      img("story-ac-3", `${ST}/4743b7fba224b0927f5ae94f43ecf8be.jpg`, "بوت طويل بقفل ذهبي أنيق وتصميم عصري", "Foldover knee boot with gold turn-lock detail"),
    ],
  },
  {
    store: DEMO_STORES.maisonHiver, cover: `${ST}/cdb6f43652c9638ae6d899086e6f108a.jpg`, categories: ["Women", "Men", "Kids", "Sports"], followingDemo: false, sponsored: true,
    stories: [
      img("story-mh-1", `${ST}/cdb6f43652c9638ae6d899086e6f108a.jpg`, "مجموعة المعاطف الشتوية والسترات الجلدية", "Winter outerwear capsule: coats, trenches & shearling"),
      img("story-mh-2", `${ST}/2814edb62a6218d32bed28962fe520d8.jpg`, "تنسيق أزياء الشارع مع حقائب الجلد والأحذية", "Streetwear layering with boots & leather totes"),
    ],
  },
];

// ---------------------------------------------------------------- reels
export type ReelProduct = {
  id: string;
  name: Bi;
  image: string;
  store: AdsStore;
  price: number | null;        // null: no real price (demo)
  href: string | null;         // a real Via product page, when linked
};
export type Reel = {
  id: string;
  video: string;
  title: Bi;
  caption: Bi;
  store: AdsStore;
  followingDemo: boolean;
  sponsored: boolean;
  categories: AdsCategory[];
  likes: number | null;        // null: no real engagement data
  products: ReelProduct[];
};

const prod = (id: string, ar: string, en: string, image: string, store: AdsStore): ReelProduct => ({ id, name: { ar, en }, image, store, price: null, href: null });

export const REELS: Reel[] = [
  {
    id: "reel-pdpaola-jewelry", video: `${RL}/video_4f15ebb74d65.mp4`,
    title: { ar: "سلاسل وأساور ذهبية", en: "Chain & Clasp Essentials" },
    caption: { ar: "سلاسل وأساور منحوتة ومطلية بالذهب عيار 18 قيراطاً بتفاصيل يدوية.", en: "Signature interlocking gold links crafted in 18k gold vermeil." },
    store: DEMO_STORES.pdpaola, followingDemo: true, sponsored: true, categories: ["Women", "Accessories", "Jewelry"], likes: null,
    products: [
      prod("prod-pd-cuff", "سوار ذهبي عيار 18", "18k Gold Signature Cuff", `${ST}/65dff00712c5dc9973550a1a89c6ddb2.jpg`, DEMO_STORES.pdpaola),
      prod("prod-pd-necklace", "عقد سلاسل منحوت", "Sculptural Interlocking Necklace", `${ST}/65dff00712c5dc9973550a1a89c6ddb2.jpg`, DEMO_STORES.pdpaola),
    ],
  },
  {
    id: "reel-ua-cardigan", video: `${RL}/video_70c16d8980fc.mp4`,
    title: { ar: "أناقة صباحية هادئة", en: "Quiet Morning Elegance" },
    caption: { ar: "كارديجان رمادي ناعم مع بنطال كتان فضفاض بقصة مريحة وأنيقة.", en: "Soft grey buttoned knit cardigan styled with fluid wide-leg linen trousers." },
    store: DEMO_STORES.uniqueAttraction, followingDemo: true, sponsored: false, categories: ["Women"], likes: null,
    products: [
      prod("prod-ua-cardigan", "كارديجان مضلع محبوك", "Ribbed Knit Everyday Cardigan", `${ST}/cdb6f43652c9638ae6d899086e6f108a.jpg`, DEMO_STORES.uniqueAttraction),
      prod("prod-ua-pants", "بنطال واسع انسيابي", "Fluid Wide-Leg Studio Pants", `${ST}/ece872f2023ae75bc5dd9365a088081f.jpg`, DEMO_STORES.uniqueAttraction),
    ],
  },
  {
    id: "reel-studio-denim", video: `${RL}/video_81ba7ef694f6.mp4`,
    title: { ar: "جينز فضفاض مريح", en: "Oversized Baggy Denim" },
    caption: { ar: "دنيم قطني ثقيل بقصة واسعة وتدرجات لونية كلاسيكية مع تيشيرت أبيض واسع.", en: "Custom wash 14oz heavyweight denim cut in relaxed streetwear proportions." },
    store: DEMO_STORES.studioDenim, followingDemo: true, sponsored: false, categories: ["Men"], likes: null,
    products: [
      prod("prod-sd-baggy", "جينز باغي واسع ثقيل", "Heavyweight Skater Denim", `${ST}/b1e00d07e4ab64ed0fc612cedbaf7e3d.jpg`, DEMO_STORES.studioDenim),
    ],
  },
  {
    id: "reel-atelier-noir-menswear", video: `${RL}/video_88aa1f41dd58.mp4`,
    title: { ar: "أناقة رجالية عصرية", en: "Tailored Streetwear Edit" },
    caption: { ar: "طبقات متناسقة من الصوف والجاكيتات الرسمية مع قبعات كلاسيكية راقية.", en: "Exploring tactile textures: baseball wool caps, structured jackets, and pleated slacks." },
    store: DEMO_STORES.atelierNoir, followingDemo: true, sponsored: true, categories: ["Men", "Accessories"], likes: null,
    products: [
      prod("prod-an-bomber", "جاكيت ترنش بومبر قصير", "Short Structured Trench Bomber", `${ST}/cdb6f43652c9638ae6d899086e6f108a.jpg`, DEMO_STORES.atelierNoir),
      prod("prod-an-cap", "قبعة صوفية بحرف مطرز", "Heritage Wool Monogram Cap", `${ST}/cdb6f43652c9638ae6d899086e6f108a.jpg`, DEMO_STORES.atelierNoir),
    ],
  },
  {
    id: "reel-kids-stripes", video: `${RL}/video_27737a394f53.mp4`,
    title: { ar: "خطوط خريفية مرحة", en: "Playful Autumn Stripes" },
    caption: { ar: "كنزات مخططة من القطن العضوي وبناطيل مخملية للأطفال بقصات مريحة وحيوية.", en: "100% organic cotton oversized striped jerseys and corduroy wide pants for kids." },
    store: DEMO_STORES.miniVia, followingDemo: false, sponsored: false, categories: ["Kids"], likes: null,
    products: [
      prod("prod-mv-jersey", "كنزة أطفال مخططة من القطن العضوي", "Organic Cotton Striped Jersey", `${ST}/cdb6f43652c9638ae6d899086e6f108a.jpg`, DEMO_STORES.miniVia),
      prod("prod-mv-corduroy", "بنطال مخمل مريح للأطفال", "Relaxed Corduroy Slacks", `${ST}/cdb6f43652c9638ae6d899086e6f108a.jpg`, DEMO_STORES.miniVia),
    ],
  },
  {
    id: "reel-maison-blanche-linen", video: `${RL}/video_aa6563d65e9a.mp4`,
    title: { ar: "بدلة كتان ناعمة", en: "Crisp Linen Day to Night" },
    caption: { ar: "بليزر كتان بلون عاجي راقٍ مع بنطال متناسق للأمسيات الصيفية واليومية.", en: "Tailored ivory linen blazer and matching fluid trousers engineered for warm evenings." },
    store: DEMO_STORES.maisonBlanche, followingDemo: true, sponsored: false, categories: ["Women"], likes: null,
    products: [
      prod("prod-mb-blazer", "بليزر كتان عاجي مفصل", "Tailored Ivory Linen Blazer", `${ST}/cdb6f43652c9638ae6d899086e6f108a.jpg`, DEMO_STORES.maisonBlanche),
      prod("prod-mb-linen-pants", "بنطال كتان بخصر مرتفع", "Fluid High-Rise Linen Slacks", `${ST}/ece872f2023ae75bc5dd9365a088081f.jpg`, DEMO_STORES.maisonBlanche),
    ],
  },
  {
    id: "reel-modest-roots-monochrome", video: `${RL}/video_de24f07b3f14.mp4`,
    title: { ar: "طبقات محتشمة بألوان هادئة", en: "Monochrome Modest Layers" },
    caption: { ar: "أطقم مريحة بألوان ترابية محايدة مع كارديجان طويل منسدل بأسلوب محتشم عصري.", en: "Seamless neutral tones in premium modal sweat sets paired with floor-sweeping cardigans." },
    store: DEMO_STORES.modestRoots, followingDemo: false, sponsored: false, categories: ["Women"], likes: null,
    products: [
      prod("prod-mr-duster", "كارديجان طويل ناعم", "Modal Longline Duster Cardigan", `${ST}/1c11c0381860897f62558432ff2329af.jpg`, DEMO_STORES.modestRoots),
      prod("prod-mr-set", "طقم قطعتين بألوان ترابية محايدة", "Neutral Two-Piece Relaxed Set", `${ST}/30d9896936e15d43707252d45be83b89.jpg`, DEMO_STORES.modestRoots),
    ],
  },
];

// --------------------------------------------------------- featured ads
export type FeaturedAd = {
  id: string;
  category: "women" | "men" | "bags" | "kids";
  row: 1 | 2;
  span: 6 | 4; // of 10 columns
  image: { src: string; srcSet: string };
  alt: Bi;
  objectPosition: string;
  title: Bi;
  subtitle: Bi;
  titleColor: string;
  textBox: { left: string; top: string; maxWidth: string; center?: boolean };
  store: AdsStore;
  sponsored: boolean;
  href: string | null;
};
const fa = (name: string, half: number, full: number) => ({
  src: `${FA}/${name}.webp`,
  srcSet: `${FA}/${name}-1000.webp ${half}w, ${FA}/${name}.webp ${full}w`,
});

export const FEATURED_ADS: FeaturedAd[] = [
  {
    id: "ad-women-just-arrived", category: "women", row: 1, span: 6,
    image: fa("featured-women_wide", 900, 1983),
    alt: { en: "Women's modern fashion editorial campaign with cream garments", ar: "حملة أزياء نسائية معاصرة بألوان كريمية هادئة" },
    objectPosition: "center 35%",
    title: { en: "JUST ARRIVED", ar: "وصل حديثًا" }, subtitle: { en: "New pieces for the season", ar: "قطع جديدة للموسم" },
    titleColor: "#C83B2B",
    textBox: { left: "50%", top: "18%", maxWidth: "360px", center: true },
    store: DEMO_STORES.maisonBlanche, sponsored: true, href: null,
  },
  {
    id: "ad-men-the-essentials", category: "men", row: 1, span: 4,
    image: fa("featured-men_editorial", 700, 1983),
    alt: { en: "Menswear studio editorial featuring classic t-shirt and denim", ar: "إطلالة رجالية كلاسيكية في الاستوديو مع جينز وتيشيرت أبيض" },
    objectPosition: "center 45%",
    title: { en: "THE ESSENTIALS", ar: "أساسيات الموسم" }, subtitle: { en: "Made for everyday", ar: "إطلالات لكل يوم" },
    titleColor: "#1c1917",
    textBox: { left: "8%", top: "18%", maxWidth: "280px" },
    store: DEMO_STORES.studioDenim, sponsored: false, href: null,
  },
  {
    id: "ad-bags-the-bag-edit", category: "bags", row: 2, span: 4,
    image: fa("featured-handbags_still_life", 700, 1983),
    alt: { en: "Three luxury leather handbags arranged on a warm taupe backdrop", ar: "ثلاث حقائب يد جلدية فاخرة على خلفية محايدة دافئة" },
    objectPosition: "center 50%",
    title: { en: "THE BAG EDIT", ar: "مجموعة الحقائب" }, subtitle: { en: "Finishing touches", ar: "تفاصيل تكمّل إطلالتك" },
    titleColor: "#1c1917",
    textBox: { left: "50%", top: "6%", maxWidth: "420px", center: true },
    store: DEMO_STORES.atelierNoir, sponsored: true, href: null,
  },
  {
    id: "ad-kids-little-styles", category: "kids", row: 2, span: 6,
    image: fa("featured-kids_campaign", 720, 720),
    alt: { en: "Contemporary children's fashion campaign with striped tops", ar: "أزياء أطفال عصرية بكنزات مخططة وألوان خريفية مرحة" },
    objectPosition: "center 25%",
    title: { en: "LITTLE STYLES", ar: "للصغار بأسلوبهم" }, subtitle: { en: "A new kids’ collection", ar: "تشكيلة جديدة للأطفال" },
    titleColor: "#1c1917",
    textBox: { left: "8%", top: "18%", maxWidth: "340px" },
    store: DEMO_STORES.miniVia, sponsored: false, href: null,
  },
];

// ------------------------------------------------------ featured stores
export type FeaturedStore = {
  store: AdsStore;
  cover: string;
  coverAlt: Bi;
  objectPosition?: string;
  categories: AdsCategory[];
  categoryLabels: { ar: string[]; en: string[] };
  sponsored: boolean;
};

export const DEMO_FEATURED_STORES: FeaturedStore[] = [
  { store: DEMO_STORES.atelierNoir, cover: `${ST}/8cc27283dbb2d5498d74fc28a23a6d8f.jpg`, coverAlt: { en: "L'Atelier Noir 2026 Fall Editorial Collection", ar: "تشكيلة خريف لاتيلييه نوار الافتتاحية" }, objectPosition: "center 25%", categories: ["Women", "Accessories", "Bags"], categoryLabels: { en: ["Women", "Accessories", "Leather Goods"], ar: ["نساء", "إكسسوارات", "حقائب جلدية"] }, sponsored: true },
  { store: DEMO_STORES.maisonBlanche, cover: `${ST}/ece872f2023ae75bc5dd9365a088081f.jpg`, coverAlt: { en: "Maison Blanche Studio Tailoring Silhouette", ar: "تصاميم ميزون بلانش الرسمية الأنيقة" }, objectPosition: "center 30%", categories: ["Women"], categoryLabels: { en: ["Women", "Tailoring", "Linen"], ar: ["نساء", "أزياء رسمية", "كتان"] }, sponsored: false },
  { store: DEMO_STORES.aura, cover: `${ST}/65dff00712c5dc9973550a1a89c6ddb2.jpg`, coverAlt: { en: "Aura Fine Jewelry Gold Cuff and Stacking Rings", ar: "مجوهرات أورا الذهبية المنحوتة يدوياً" }, objectPosition: "center 45%", categories: ["Women", "Accessories", "Jewelry"], categoryLabels: { en: ["Accessories", "Jewelry", "Gold Vermeil"], ar: ["إكسسوارات", "مجوهرات", "ذهب عيار 18"] }, sponsored: false },
  { store: DEMO_STORES.studioDenim, cover: `${ST}/b1e00d07e4ab64ed0fc612cedbaf7e3d.jpg`, coverAlt: { en: "Studio Denim Relaxed Casual Cuts", ar: "قطع استوديو دينيم المريحة واليومية" }, objectPosition: "center 35%", categories: ["Men", "Women"], categoryLabels: { en: ["Men", "Women", "Casual Denim"], ar: ["رجال", "نساء", "دنيم كاجوال"] }, sponsored: true },
  { store: DEMO_STORES.polene, cover: `${ST}/download-1000.webp`, coverAlt: { en: "Cognac leather tote bag", ar: "حقيبة جلدية بلون الكونياك" }, objectPosition: "center 45%", categories: ["Women", "Accessories", "Bags"], categoryLabels: { en: ["Women", "Accessories", "Luxury Bags"], ar: ["نساء", "إكسسوارات", "حقائب فاخرة"] }, sponsored: true },
  { store: DEMO_STORES.chaussures, cover: `${ST}/97a7d1e4f920bf520a6f0a846b58f641.jpg`, coverAlt: { en: "Atelier Chaussures Black Leather Block-Heel Boots", ar: "أحذية جلدية شتوية من أتيلييه شوسور" }, objectPosition: "center 50%", categories: ["Women", "Accessories", "Shoes"], categoryLabels: { en: ["Women", "Shoes", "Boots"], ar: ["نساء", "أحذية", "أحذية شتوية"] }, sponsored: false },
  { store: DEMO_STORES.miniVia, cover: `${FA}/featured-kids_campaign-1000.webp`, coverAlt: { en: "Mini Via Kids Playful Organic Cotton Collection", ar: "تشكيلة ميني فيا للأطفال من القطن العضوي" }, objectPosition: "center 20%", categories: ["Kids"], categoryLabels: { en: ["Kids", "Organic Cotton", "Playwear"], ar: ["أطفال", "قطن عضوي", "ملابس يومية"] }, sponsored: false },
  { store: DEMO_STORES.sotropa, cover: `${ST}/30d9896936e15d43707252d45be83b89.jpg`, coverAlt: { en: "Sotropa Studio Burgundy Leather Trench Jacket", ar: "جاكيت جلدي عنابي من استوديو سوتروبا" }, objectPosition: "center 40%", categories: ["Women"], categoryLabels: { en: ["Women", "Outerwear", "Leather"], ar: ["نساء", "سترات", "معاطف جلدية"] }, sponsored: false },
  { store: DEMO_STORES.maisonHiver, cover: `${ST}/cdb6f43652c9638ae6d899086e6f108a.jpg`, coverAlt: { en: "Maison Hiver Winter Wool and Shearling Capsule", ar: "تشكيلة معاطف شتوية وصوفية من ميزون إيفر" }, objectPosition: "center 25%", categories: ["Women", "Men", "Kids", "Sports"], categoryLabels: { en: ["Women", "Men", "Winter Sports"], ar: ["نساء", "رجال", "رياضة شتوية"] }, sponsored: true },
];
