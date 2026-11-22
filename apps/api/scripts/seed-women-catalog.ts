/**
 * Women / men / kids catalog demo seed - LOCAL DEVELOPMENT DATABASE ONLY.
 *
 * Adds ~90 women's, 20 men's and 20 kids' fashion products offered by the
 * two existing demo stores, so the /women, /men and /kids listings have a
 * realistic catalogue for infinite scroll, filters, sorting and
 * multi-store comparison.
 *
 * Every offer is created CLASSIFIED with the fixed product taxonomy
 * (Sprint 27): one audience, a taxonomy category, a season (or none for
 * accessories), and its variants as colour/size combinations
 * (isCombination, colorCode/sizeCode, the taxonomy's own labels) at one
 * unified price per store offer, with branch stock - exactly what the
 * owner's combinations endpoint produces, so the taxonomy filters of
 * /discovery/all find them.
 *
 * - Refuses to run against anything but a local database
 *   (requireLocalDatabase, shared with the other demo seeds).
 * - Idempotent: every row gets a deterministic id derived from a stable
 *   key and is created once; re-runs add nothing and never overwrite.
 * - Additive only: never deletes anything, and never updates rows it did
 *   not create. Creates no reviews, ratings, purchases or favourites.
 * - Needs the product-taxonomy migrations applied
 *   (20261021120000_sprint27_product_taxonomy, then
 *   20261023090000_product_taxonomy_spring_gray).
 * - Everything it creates is identifiable: brands use normalizedName
 *   "via-demo-*", categories use nameEn "Via Demo * - *", platform
 *   barcodes "PPB-VCAT-*", seller SKUs "VCAT-*".
 *
 * Earlier runs of this seed (the "via-women-catalog-v1" products, SKUs
 * "WDEMO-*") created UNCLASSIFIED offers. Those cannot be converted in
 * place (a variant's isCombination flag is immutable), so the classified
 * catalogue is created next to them under new ids; pass --retire-v1 to
 * set exactly those old demo offers to INACTIVE (hidden from customers,
 * nothing deleted) so the listings do not show both.
 *
 * Images: women - Pexels photos (Pexels License), stored in
 * apps/web/public/demo-assets/women-catalog/; men and kids - the
 * listings' own category images (public/images/men-categories,
 * public/images/kids-categories), reused as product photos.
 *
 * Run from apps/api:  npx ts-node scripts/seed-women-catalog.ts [--retire-v1]
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  ProductAudience,
  ProductSeason,
} from '../generated/prisma/client';
import { requireLocalDatabase } from './local-db-guard';
import { VENDOR_ONE, VENDOR_TWO } from './seed-demo.constants';

// Brand/category rows keep the first version's ids (they were never
// unclassified data); products and everything under them use v2.
const NAMESPACE = 'via-women-catalog-v1';
const CATALOG_NAMESPACE = 'via-catalog-v2';

/** Deterministic UUID-shaped id, same scheme as seed-scenarios.ts. */
function idFor(namespace: string, key: string): string {
  const h = createHash('sha256').update(`${namespace}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const stableId = (key: string) => idFor(NAMESPACE, key);
const catalogId = (key: string) => idFor(CATALOG_NAMESPACE, key);

type Kind = 'clothing' | 'shoes' | 'onesize' | 'baby';

// Taxonomy size codes (labels come from taxonomy_sizes).
const SIZE_CODES: Record<'adult' | 'kids', Record<Kind, string[]>> = {
  adult: {
    clothing: ['XS', 'S', 'M', 'L', 'XL'],
    shoes: ['EU_36', 'EU_38', 'EU_40', 'EU_42', 'EU_44'],
    baby: [],
    onesize: [],
  },
  kids: {
    clothing: ['AGE_2_3Y', 'AGE_4_5Y', 'AGE_6_7Y', 'AGE_8_9Y', 'AGE_10_11Y'],
    baby: ['AGE_0_3M', 'AGE_3_6M', 'AGE_6_9M', 'AGE_9_12M'],
    shoes: [],
    onesize: [],
  },
};

// Category per product type (women's list). `code` is the taxonomy
// category, `season` the offer's season (null = not seasonal).
const CATEGORIES: Record<
  string,
  {
    ar: string;
    en: string;
    kind: Kind;
    code: string;
    season: ProductSeason | null;
  }
> = {
  dresses: {
    ar: 'فساتين',
    en: 'Dresses',
    kind: 'clothing',
    code: 'DRESSES_WOMEN',
    season: 'SUMMER',
  },
  tops: {
    ar: 'بلايز',
    en: 'Blouses',
    kind: 'clothing',
    code: 'TOPS',
    season: 'SPRING',
  },
  shirts: {
    ar: 'قمصان',
    en: 'Shirts',
    kind: 'clothing',
    code: 'SHIRTS',
    season: 'SPRING',
  },
  tshirts: {
    ar: 'تيشيرتات',
    en: 'T-Shirts',
    kind: 'clothing',
    code: 'TSHIRTS',
    season: 'SUMMER',
  },
  knitwear: {
    ar: 'كنزات',
    en: 'Knitwear',
    kind: 'clothing',
    code: 'KNITWEAR',
    season: 'WINTER',
  },
  cardigans: {
    ar: 'كارديغان',
    en: 'Cardigans',
    kind: 'clothing',
    code: 'CARDIGANS',
    season: 'FALL',
  },
  hoodies: {
    ar: 'هوديز',
    en: 'Hoodies',
    kind: 'clothing',
    code: 'HOODIES',
    season: 'WINTER',
  },
  sweatshirts: {
    ar: 'سويت شيرت',
    en: 'Sweatshirts',
    kind: 'clothing',
    code: 'SWEATSHIRTS',
    season: 'FALL',
  },
  jackets: {
    ar: 'جاكيتات',
    en: 'Jackets',
    kind: 'clothing',
    code: 'JACKETS',
    season: 'FALL',
  },
  coats: {
    ar: 'معاطف',
    en: 'Coats',
    kind: 'clothing',
    code: 'COATS',
    season: 'WINTER',
  },
  blazers: {
    ar: 'بليزرات',
    en: 'Blazers',
    kind: 'clothing',
    code: 'BLAZERS',
    season: 'FALL',
  },
  suits: {
    ar: 'بدلات',
    en: 'Suits',
    kind: 'clothing',
    code: 'FORMAL_SUITS',
    season: null,
  },
  jeans: {
    ar: 'جينز',
    en: 'Jeans',
    kind: 'clothing',
    code: 'JEANS',
    season: null,
  },
  trousers: {
    ar: 'بناطيل',
    en: 'Trousers',
    kind: 'clothing',
    code: 'TROUSERS',
    season: 'SPRING',
  },
  skirts: {
    ar: 'تنانير',
    en: 'Skirts',
    kind: 'clothing',
    code: 'SKIRTS',
    season: 'SPRING',
  },
  jumpsuits: {
    ar: 'أوفرولات',
    en: 'Jumpsuits',
    kind: 'clothing',
    code: 'JUMPSUITS',
    season: 'SUMMER',
  },
  sets: {
    ar: 'أطقم',
    en: 'Sets',
    kind: 'clothing',
    code: 'TWO_PIECE_SETS',
    season: 'SPRING',
  },
  abayas: {
    ar: 'عبايات',
    en: 'Abayas',
    kind: 'clothing',
    code: 'ABAYAS',
    season: null,
  },
  kaftans: {
    ar: 'قفاطين',
    en: 'Kaftans',
    kind: 'clothing',
    code: 'JALABIYAS_KAFTANS',
    season: 'SUMMER',
  },
  hijabs: {
    ar: 'حجابات',
    en: 'Hijabs',
    kind: 'onesize',
    code: 'HIJABS_SHAWLS',
    season: null,
  },
  shoes: {
    ar: 'أحذية',
    en: 'Shoes',
    kind: 'shoes',
    code: 'SHOES',
    season: null,
  },
  bags: {
    ar: 'حقائب',
    en: 'Handbags',
    kind: 'onesize',
    code: 'BAGS',
    season: null,
  },
  jewelry: {
    ar: 'مجوهرات',
    en: 'Jewellery',
    kind: 'onesize',
    code: 'JEWELLERY',
    season: null,
  },
  watches: {
    ar: 'ساعات',
    en: 'Watches',
    kind: 'onesize',
    code: 'WATCHES',
    season: null,
  },
  eyewear: {
    ar: 'نظارات',
    en: 'Eyewear',
    kind: 'onesize',
    code: 'EYEWEAR',
    season: 'SUMMER',
  },
  hats: {
    ar: 'قبعات',
    en: 'Hats',
    kind: 'onesize',
    code: 'HATS_CAPS',
    season: 'WINTER',
  },
  socks: {
    ar: 'جوارب',
    en: 'Socks',
    kind: 'onesize',
    code: 'SOCKS',
    season: null,
  },
};

/** The women's list names colours in Arabic; the taxonomy code for each
 * (gold/silver have no exact taxonomy colour - nearest one). */
const COLOR_CODE: Record<string, string> = {
  أسود: 'BLACK',
  بيج: 'BEIGE',
  أبيض: 'WHITE',
  أزرق: 'BLUE',
  رمادي: 'GRAY',
  ذهبي: 'YELLOW',
  بني: 'BROWN',
  أخضر: 'GREEN',
  وردي: 'PINK',
  كحلي: 'NAVY',
  برتقالي: 'ORANGE',
  أحمر: 'RED',
  كريمي: 'CREAM',
  خمري: 'BURGUNDY',
  ليلكي: 'LILAC',
  فضي: 'GRAY',
  زيتي: 'OLIVE',
  أصفر: 'YELLOW',
};

const BRANDS: Record<string, string> = {
  lina: 'Lina Atelier',
  noor: 'Noor Modest',
  qasr: 'Qasr Knitwear',
  sahara: 'Sahara Leather',
  yasmin: 'Yasmin Jewels',
  urban: 'Urban Thread',
  rawi: 'Rawi Menswear',
  zaytoon: 'Zaytoon Kids',
};

interface DemoProduct {
  /** Pexels photo id - also the product's stable key. */
  img: string;
  cat: keyof typeof CATEGORIES;
  brand: keyof typeof BRANDS;
  ar: string;
  en: string;
  /** First colour is the one in the photo. */
  colors: string[];
  price: number;
}

/** A men's or kids' product (taxonomy codes directly). */
interface AudienceProduct {
  key: string;
  code: string;
  /** Category label used for the demo `categories` row. */
  catAr: string;
  kind: Kind;
  season: ProductSeason | null;
  brand: keyof typeof BRANDS;
  ar: string;
  en: string;
  colors: string[];
  price: number;
  image: string;
}

const MEN_IMG = (file: string) => `/images/men-categories/${file}`;
const KIDS_IMG = (label: string) =>
  `/images/kids-categories/${encodeURIComponent(label)}.png`;

// Men's products - one or two per main category.
const MEN_PRODUCTS: AudienceProduct[] = [
  {
    key: 'm-shirt-oxford',
    code: 'SHIRTS',
    catAr: 'قمصان',
    kind: 'clothing',
    season: 'SPRING',
    brand: 'rawi',
    ar: 'قميص أكسفورد رجالي',
    en: "Men's Oxford Shirt",
    colors: ['WHITE', 'BLUE'],
    price: 149,
    image: MEN_IMG('shirts-new.jpg'),
  },
  {
    key: 'm-shirt-linen',
    code: 'SHIRTS',
    catAr: 'قمصان',
    kind: 'clothing',
    season: 'SUMMER',
    brand: 'rawi',
    ar: 'قميص كتان رجالي',
    en: "Men's Linen Shirt",
    colors: ['BEIGE', 'OLIVE'],
    price: 169,
    image: MEN_IMG('shirts-new.jpg'),
  },
  {
    key: 'm-tshirt-basic',
    code: 'TSHIRTS',
    catAr: 'تيشيرتات',
    kind: 'clothing',
    season: 'SUMMER',
    brand: 'urban',
    ar: 'تيشيرت قطني أساسي',
    en: 'Basic Cotton T-Shirt',
    colors: ['BLACK', 'WHITE', 'GRAY'],
    price: 59,
    image: MEN_IMG('t-shirts.jpg'),
  },
  {
    key: 'm-polo',
    code: 'BLOUSES_MEN',
    catAr: 'بلايز',
    kind: 'clothing',
    season: 'SUMMER',
    brand: 'rawi',
    ar: 'بلوزة بولو رجالية',
    en: "Men's Polo Top",
    colors: ['NAVY', 'WHITE'],
    price: 99,
    image: MEN_IMG('blouses-men.jpg'),
  },
  {
    key: 'm-chino',
    code: 'TROUSERS',
    catAr: 'بناطيل',
    kind: 'clothing',
    season: 'SPRING',
    brand: 'rawi',
    ar: 'بنطال تشينو',
    en: 'Chino Trousers',
    colors: ['BEIGE', 'NAVY'],
    price: 159,
    image: MEN_IMG('trousers.jpg'),
  },
  {
    key: 'm-jeans-slim',
    code: 'JEANS',
    catAr: 'جينز',
    kind: 'clothing',
    season: null,
    brand: 'urban',
    ar: 'جينز ضيق رجالي',
    en: "Men's Slim Jeans",
    colors: ['DENIM', 'BLACK'],
    price: 189,
    image: MEN_IMG('jeans.jpg'),
  },
  {
    key: 'm-formal-trousers',
    code: 'FORMAL_TROUSERS',
    catAr: 'بناطيل رسمية',
    kind: 'clothing',
    season: 'FALL',
    brand: 'rawi',
    ar: 'بنطال رسمي',
    en: 'Formal Trousers',
    colors: ['BLACK', 'GRAY'],
    price: 179,
    image: MEN_IMG('formal-trousers-new.webp'),
  },
  {
    key: 'm-shorts',
    code: 'SHORTS',
    catAr: 'شورتات',
    kind: 'clothing',
    season: 'SUMMER',
    brand: 'urban',
    ar: 'شورت قطني',
    en: 'Cotton Shorts',
    colors: ['OLIVE', 'BEIGE'],
    price: 79,
    image: MEN_IMG('shorts-new.webp'),
  },
  {
    key: 'm-jacket-bomber',
    code: 'JACKETS',
    catAr: 'جكيتات',
    kind: 'clothing',
    season: 'FALL',
    brand: 'urban',
    ar: 'جاكيت بومبر',
    en: 'Bomber Jacket',
    colors: ['OLIVE', 'BLACK'],
    price: 279,
    image: MEN_IMG('jackets.jpg'),
  },
  {
    key: 'm-coat-wool',
    code: 'COATS',
    catAr: 'معاطف',
    kind: 'clothing',
    season: 'WINTER',
    brand: 'rawi',
    ar: 'معطف صوف',
    en: 'Wool Coat',
    colors: ['CAMEL', 'NAVY'],
    price: 459,
    image: MEN_IMG('coats.jpg'),
  },
  {
    key: 'm-blazer',
    code: 'BLAZERS',
    catAr: 'بليزرات',
    kind: 'clothing',
    season: 'FALL',
    brand: 'rawi',
    ar: 'بليزر رجالي',
    en: "Men's Blazer",
    colors: ['NAVY', 'GRAY'],
    price: 349,
    image: MEN_IMG('blazers.jpg'),
  },
  {
    key: 'm-hoodie',
    code: 'HOODIES',
    catAr: 'هوديز',
    kind: 'clothing',
    season: 'WINTER',
    brand: 'urban',
    ar: 'هودي رجالي',
    en: "Men's Hoodie",
    colors: ['GRAY', 'BLACK'],
    price: 139,
    image: MEN_IMG('hoodies.jpg'),
  },
  {
    key: 'm-knit',
    code: 'KNITWEAR',
    catAr: 'كنزات وتريكو',
    kind: 'clothing',
    season: 'WINTER',
    brand: 'qasr',
    ar: 'كنزة تريكو رجالية',
    en: "Men's Knit Sweater",
    colors: ['BURGUNDY', 'CREAM'],
    price: 189,
    image: MEN_IMG('knitwear-new.jpg'),
  },
  {
    key: 'm-suit',
    code: 'FORMAL_SUITS',
    catAr: 'بدلات رسمية',
    kind: 'clothing',
    season: null,
    brand: 'rawi',
    ar: 'بدلة رسمية',
    en: 'Formal Suit',
    colors: ['NAVY', 'BLACK'],
    price: 899,
    image: MEN_IMG('formal-suits.jpg'),
  },
  {
    key: 'm-sport-set',
    code: 'SPORTSWEAR',
    catAr: 'ملابس رياضية',
    kind: 'clothing',
    season: null,
    brand: 'urban',
    ar: 'طقم رياضي رجالي',
    en: "Men's Training Set",
    colors: ['BLACK', 'NAVY'],
    price: 199,
    image: MEN_IMG('sportswear-new.webp'),
  },
  {
    key: 'm-sneakers',
    code: 'SHOES',
    catAr: 'أحذية',
    kind: 'shoes',
    season: null,
    brand: 'sahara',
    ar: 'حذاء رياضي رجالي',
    en: "Men's Sneakers",
    colors: ['WHITE', 'BLACK'],
    price: 259,
    image: MEN_IMG('shoes-new.jpg'),
  },
  {
    key: 'm-wallet',
    code: 'WALLETS',
    catAr: 'محافظ',
    kind: 'onesize',
    season: null,
    brand: 'sahara',
    ar: 'محفظة جلد',
    en: 'Leather Wallet',
    colors: ['BROWN', 'BLACK'],
    price: 89,
    image: MEN_IMG('wallets.jpg'),
  },
  {
    key: 'm-watch',
    code: 'WATCHES',
    catAr: 'ساعات',
    kind: 'onesize',
    season: null,
    brand: 'yasmin',
    ar: 'ساعة يد رجالية',
    en: "Men's Watch",
    colors: ['BLACK', 'BROWN'],
    price: 399,
    image: MEN_IMG('watches-new.jpg'),
  },
  {
    key: 'm-belt',
    code: 'BELTS',
    catAr: 'أحزمة',
    kind: 'onesize',
    season: null,
    brand: 'sahara',
    ar: 'حزام جلد',
    en: 'Leather Belt',
    colors: ['BROWN', 'BLACK'],
    price: 79,
    image: MEN_IMG('belts.jpg'),
  },
  {
    key: 'm-cap',
    code: 'HATS_CAPS',
    catAr: 'قبعات وطواقي',
    kind: 'onesize',
    season: 'SUMMER',
    brand: 'urban',
    ar: 'قبعة كاب',
    en: 'Baseball Cap',
    colors: ['NAVY', 'BEIGE'],
    price: 49,
    image: MEN_IMG('hats-caps-new.webp'),
  },
];

// Kids' products - age sizes (or baby ages) on clothing.
const KIDS_PRODUCTS: AudienceProduct[] = [
  {
    key: 'k-girls-dress',
    code: 'GIRLS_DRESSES',
    catAr: 'فساتين بنات',
    kind: 'clothing',
    season: 'SUMMER',
    brand: 'zaytoon',
    ar: 'فستان بنات مطبع',
    en: "Girls' Printed Dress",
    colors: ['PINK', 'YELLOW'],
    price: 119,
    image: KIDS_IMG('فساتين بنات'),
  },
  {
    key: 'k-girls-dress-party',
    code: 'GIRLS_DRESSES',
    catAr: 'فساتين بنات',
    kind: 'clothing',
    season: null,
    brand: 'zaytoon',
    ar: 'فستان سهرة للبنات',
    en: "Girls' Party Dress",
    colors: ['LILAC', 'WHITE'],
    price: 169,
    image: KIDS_IMG('فساتين بنات'),
  },
  {
    key: 'k-tshirt',
    code: 'TSHIRTS',
    catAr: 'تيشيرتات',
    kind: 'clothing',
    season: 'SUMMER',
    brand: 'zaytoon',
    ar: 'تيشيرت أطفال',
    en: 'Kids T-Shirt',
    colors: ['WHITE', 'BLUE', 'RED'],
    price: 39,
    image: KIDS_IMG('تيشيرتات'),
  },
  {
    key: 'k-shirt',
    code: 'SHIRTS',
    catAr: 'قمصان',
    kind: 'clothing',
    season: 'SPRING',
    brand: 'zaytoon',
    ar: 'قميص أولاد',
    en: "Boys' Shirt",
    colors: ['BLUE', 'WHITE'],
    price: 69,
    image: KIDS_IMG('قمصان'),
  },
  {
    key: 'k-jeans',
    code: 'JEANS',
    catAr: 'جينز',
    kind: 'clothing',
    season: null,
    brand: 'urban',
    ar: 'جينز أطفال',
    en: 'Kids Jeans',
    colors: ['DENIM'],
    price: 89,
    image: KIDS_IMG('جينز'),
  },
  {
    key: 'k-trousers',
    code: 'TROUSERS',
    catAr: 'بناطيل',
    kind: 'clothing',
    season: 'FALL',
    brand: 'zaytoon',
    ar: 'بنطال قطني للأطفال',
    en: 'Kids Cotton Trousers',
    colors: ['BEIGE', 'NAVY'],
    price: 59,
    image: KIDS_IMG('بناطيل'),
  },
  {
    key: 'k-shorts',
    code: 'SHORTS',
    catAr: 'شورتات',
    kind: 'clothing',
    season: 'SUMMER',
    brand: 'zaytoon',
    ar: 'شورت أطفال',
    en: 'Kids Shorts',
    colors: ['GREEN', 'NAVY'],
    price: 45,
    image: KIDS_IMG('شورتات'),
  },
  {
    key: 'k-hoodie',
    code: 'HOODIES',
    catAr: 'هوديز',
    kind: 'clothing',
    season: 'WINTER',
    brand: 'urban',
    ar: 'هودي أطفال',
    en: 'Kids Hoodie',
    colors: ['GRAY', 'PINK'],
    price: 99,
    image: KIDS_IMG('هوديز'),
  },
  {
    key: 'k-jacket',
    code: 'JACKETS',
    catAr: 'جكيتات',
    kind: 'clothing',
    season: 'FALL',
    brand: 'zaytoon',
    ar: 'جاكيت أطفال',
    en: 'Kids Jacket',
    colors: ['RED', 'NAVY'],
    price: 149,
    image: KIDS_IMG('جكيتات'),
  },
  {
    key: 'k-coat',
    code: 'COATS',
    catAr: 'معاطف',
    kind: 'clothing',
    season: 'WINTER',
    brand: 'zaytoon',
    ar: 'معطف شتوي للأطفال',
    en: 'Kids Winter Coat',
    colors: ['NAVY', 'BURGUNDY'],
    price: 199,
    image: KIDS_IMG('معاطف'),
  },
  {
    key: 'k-knit',
    code: 'KNITWEAR',
    catAr: 'كنزات وتريكو',
    kind: 'clothing',
    season: 'WINTER',
    brand: 'qasr',
    ar: 'كنزة صوف للأطفال',
    en: 'Kids Wool Sweater',
    colors: ['CREAM', 'GREEN'],
    price: 89,
    image: KIDS_IMG('كنزات وتريكو'),
  },
  {
    key: 'k-leggings',
    code: 'LEGGINGS',
    catAr: 'ليغينغز',
    kind: 'clothing',
    season: 'SPRING',
    brand: 'zaytoon',
    ar: 'ليغينغز بنات',
    en: "Girls' Leggings",
    colors: ['BLACK', 'PINK'],
    price: 35,
    image: KIDS_IMG('ليغينغز'),
  },
  {
    key: 'k-skirt',
    code: 'SKIRTS',
    catAr: 'تنانير',
    kind: 'clothing',
    season: 'SPRING',
    brand: 'zaytoon',
    ar: 'تنورة بنات',
    en: "Girls' Skirt",
    colors: ['PINK', 'DENIM'],
    price: 55,
    image: KIDS_IMG('تنانير'),
  },
  {
    key: 'k-sport',
    code: 'SPORTSWEAR',
    catAr: 'ملابس رياضية',
    kind: 'clothing',
    season: null,
    brand: 'urban',
    ar: 'طقم رياضي أطفال',
    en: 'Kids Tracksuit',
    colors: ['BLUE', 'GRAY'],
    price: 109,
    image: KIDS_IMG('ملابس رياضية'),
  },
  {
    key: 'k-pajamas',
    code: 'SLEEPWEAR',
    catAr: 'ملابس نوم',
    kind: 'clothing',
    season: null,
    brand: 'zaytoon',
    ar: 'بيجامة أطفال',
    en: 'Kids Pajamas',
    colors: ['BLUE', 'PINK'],
    price: 69,
    image: KIDS_IMG('ملابس نوم'),
  },
  {
    key: 'k-occasion',
    code: 'OCCASION_WEAR',
    catAr: 'ملابس مناسبات وأعياد',
    kind: 'clothing',
    season: null,
    brand: 'zaytoon',
    ar: 'طقم العيد للأطفال',
    en: 'Kids Eid Outfit',
    colors: ['WHITE', 'BEIGE'],
    price: 159,
    image: KIDS_IMG('ملابس مناسبات وأعياد'),
  },
  {
    key: 'k-newborn',
    code: 'NEWBORN',
    catAr: 'ملابس مواليد',
    kind: 'baby',
    season: null,
    brand: 'zaytoon',
    ar: 'طقم مواليد قطني',
    en: 'Newborn Cotton Set',
    colors: ['WHITE', 'YELLOW'],
    price: 79,
    image: KIDS_IMG('ملابس مواليد'),
  },
  {
    key: 'k-bodysuit',
    code: 'BABY_BODYSUITS',
    catAr: 'بودي أطفال',
    kind: 'baby',
    season: 'SUMMER',
    brand: 'zaytoon',
    ar: 'بودي أطفال قطني',
    en: 'Baby Cotton Bodysuit',
    colors: ['WHITE', 'PINK', 'BLUE'],
    price: 39,
    image: KIDS_IMG('ملابس مواليد'),
  },
  {
    key: 'k-dungarees',
    code: 'DUNGAREES',
    catAr: 'سالوبيت',
    kind: 'clothing',
    season: 'SPRING',
    brand: 'zaytoon',
    ar: 'سالوبيت جينز للأطفال',
    en: 'Kids Denim Dungarees',
    colors: ['DENIM'],
    price: 99,
    image: KIDS_IMG('سالوبيت'),
  },
  {
    key: 'k-hair',
    code: 'HAIR_ACCESSORIES',
    catAr: 'إكسسوارات الشعر',
    kind: 'onesize',
    season: null,
    brand: 'yasmin',
    ar: 'طوق شعر للبنات',
    en: "Girls' Hair Band",
    colors: ['PINK', 'RED'],
    price: 25,
    image: KIDS_IMG('إكسسوارات الشعر'),
  },
];

// Names describe what each photo actually shows.
const PRODUCTS: DemoProduct[] = [
  {
    img: '14452579',
    cat: 'dresses',
    brand: 'lina',
    ar: 'فستان ماكسي مطبوع',
    en: 'Printed Maxi Dress',
    colors: ['أزرق'],
    price: 289,
  },
  {
    img: '169047',
    cat: 'dresses',
    brand: 'lina',
    ar: 'فستان ميدي مطرز',
    en: 'Embroidered Midi Dress',
    colors: ['أحمر', 'أسود'],
    price: 239,
  },
  {
    img: '14801125',
    cat: 'dresses',
    brand: 'lina',
    ar: 'فستان سهرة لامع',
    en: 'Sequin Evening Dress',
    colors: ['ذهبي'],
    price: 420,
  },
  {
    img: '6976789',
    cat: 'dresses',
    brand: 'urban',
    ar: 'فستان ماكسي ناعم',
    en: 'Soft Long Slip Dress',
    colors: ['بيج', 'أسود'],
    price: 199,
  },
  {
    img: '9541934',
    cat: 'dresses',
    brand: 'lina',
    ar: 'فستان طويل بألوان دافئة',
    en: 'Warm-Tone Long Gown',
    colors: ['برتقالي'],
    price: 349,
  },
  {
    img: '11414026',
    cat: 'dresses',
    brand: 'urban',
    ar: 'فستان حمل بأكتاف مكشوفة',
    en: 'Off-Shoulder Maternity Dress',
    colors: ['أخضر'],
    price: 189,
  },
  {
    img: '17610357',
    cat: 'dresses',
    brand: 'noor',
    ar: 'فستان محتشم بأكمام طويلة',
    en: 'Long-Sleeve Modest Dress',
    colors: ['أبيض', 'بيج'],
    price: 229,
  },
  {
    img: '8995781',
    cat: 'dresses',
    brand: 'noor',
    ar: 'فستان طويل محتشم',
    en: 'Modest Maxi Dress',
    colors: ['وردي', 'بيج'],
    price: 219,
  },
  {
    img: '8911826',
    cat: 'dresses',
    brand: 'noor',
    ar: 'فستان محتشم أنيق',
    en: 'Elegant Modest Dress',
    colors: ['أزرق', 'كحلي'],
    price: 249,
  },
  {
    img: '7249224',
    cat: 'dresses',
    brand: 'noor',
    ar: 'فستان محتشم مطرز',
    en: 'Embroidered Modest Dress',
    colors: ['أخضر'],
    price: 279,
  },
  {
    img: '26970922',
    cat: 'kaftans',
    brand: 'noor',
    ar: 'جلابية مطرزة مع شال',
    en: 'Embroidered Jalabiya with Shawl',
    colors: ['أخضر', 'بيج'],
    price: 319,
  },
  {
    img: '19294350',
    cat: 'kaftans',
    brand: 'noor',
    ar: 'قفطان مخملي مطرز',
    en: 'Embroidered Velvet Kaftan',
    colors: ['خمري'],
    price: 590,
  },
  {
    img: '7351208',
    cat: 'sets',
    brand: 'lina',
    ar: 'طقم بليزر وتنورة',
    en: 'Blazer and Skirt Co-ord',
    colors: ['ليلكي'],
    price: 329,
  },
  {
    img: '1006991',
    cat: 'shirts',
    brand: 'urban',
    ar: 'قميص أبيض كلاسيكي',
    en: 'Classic White Shirt',
    colors: ['أبيض'],
    price: 119,
  },
  {
    img: '2584331',
    cat: 'tops',
    brand: 'lina',
    ar: 'بلوزة بأكمام واسعة',
    en: 'Wide-Sleeve Blouse',
    colors: ['أخضر', 'أبيض'],
    price: 139,
  },
  {
    img: '5393759',
    cat: 'shirts',
    brand: 'lina',
    ar: 'قميص ساتان ناعم',
    en: 'Soft Satin Shirt',
    colors: ['أبيض', 'بيج'],
    price: 149,
  },
  {
    img: '8289255',
    cat: 'shirts',
    brand: 'urban',
    ar: 'قميص بياقة متباينة',
    en: 'Contrast Collar Shirt',
    colors: ['أسود', 'أبيض'],
    price: 129,
  },
  {
    img: '3312789',
    cat: 'tshirts',
    brand: 'urban',
    ar: 'تيشيرت قطني مطبوع',
    en: 'Printed Cotton T-Shirt',
    colors: ['أبيض'],
    price: 69,
  },
  {
    img: '10503456',
    cat: 'tshirts',
    brand: 'urban',
    ar: 'تيشيرت قطني أساسي',
    en: 'Basic Cotton T-Shirt',
    colors: ['أبيض', 'أسود', 'رمادي'],
    price: 49,
  },
  {
    img: '8346226',
    cat: 'tshirts',
    brand: 'urban',
    ar: 'تيشيرت قطني بألوان ترابية',
    en: 'Earth-Tone Cotton T-Shirt',
    colors: ['بني', 'بيج', 'أبيض'],
    price: 59,
  },
  {
    img: '4440576',
    cat: 'tshirts',
    brand: 'urban',
    ar: 'تيشيرت بأكمام طويلة',
    en: 'Long-Sleeve Cotton T-Shirt',
    colors: ['رمادي', 'أخضر'],
    price: 65,
  },
  {
    img: '2887756',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة تريكو مخرّمة',
    en: 'Open-Knit Jumper',
    colors: ['بيج'],
    price: 159,
  },
  {
    img: '20025511',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة صوف برقبة عالية',
    en: 'Wool Roll-Neck Jumper',
    colors: ['كريمي'],
    price: 189,
  },
  {
    img: '3765547',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة رمادية برقبة عالية',
    en: 'Grey Turtleneck Jumper',
    colors: ['رمادي'],
    price: 149,
  },
  {
    img: '7926382',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة بيضاء برقبة عالية',
    en: 'White Turtleneck Jumper',
    colors: ['أبيض'],
    price: 149,
  },
  {
    img: '3941172',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة مضلعة برقبة عالية',
    en: 'Ribbed Turtleneck Jumper',
    colors: ['أسود', 'بني'],
    price: 139,
  },
  {
    img: '7274470',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة حمراء برقبة عالية',
    en: 'Red Turtleneck Jumper',
    colors: ['أحمر'],
    price: 149,
  },
  {
    img: '18518659',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة محبوكة برتقالية',
    en: 'Orange Knit Jumper',
    colors: ['برتقالي'],
    price: 129,
  },
  {
    img: '2997544',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة بنية برقبة عالية',
    en: 'Brown Roll-Neck Jumper',
    colors: ['بني'],
    price: 159,
  },
  {
    img: '9894727',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة تريكو سميكة',
    en: 'Chunky Knit Jumper',
    colors: ['كريمي'],
    price: 199,
  },
  {
    img: '3872328',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة ناعمة رمادية فاتحة',
    en: 'Soft Light-Grey Jumper',
    colors: ['رمادي'],
    price: 135,
  },
  {
    img: '13573553',
    cat: 'knitwear',
    brand: 'qasr',
    ar: 'كنزة منقوشة برقبة عالية',
    en: 'Patterned Turtleneck Jumper',
    colors: ['أسود'],
    price: 169,
  },
  {
    img: '18851697',
    cat: 'cardigans',
    brand: 'qasr',
    ar: 'كارديغان تريكو سميك',
    en: 'Chunky Knit Cardigan',
    colors: ['بيج'],
    price: 219,
  },
  {
    img: '8305201',
    cat: 'jackets',
    brand: 'urban',
    ar: 'جاكيت فرو ناعم',
    en: 'Soft Faux-Fur Jacket',
    colors: ['أبيض'],
    price: 259,
  },
  {
    img: '2395842',
    cat: 'hoodies',
    brand: 'urban',
    ar: 'هودي قطني مريح',
    en: 'Cotton Hoodie',
    colors: ['أزرق', 'رمادي'],
    price: 129,
  },
  {
    img: '6995863',
    cat: 'hoodies',
    brand: 'urban',
    ar: 'هودي رمادي بسحاب',
    en: 'Grey Zip Hoodie',
    colors: ['رمادي'],
    price: 139,
  },
  {
    img: '5081395',
    cat: 'sweatshirts',
    brand: 'urban',
    ar: 'سويت شيرت أبيض',
    en: 'White Sweatshirt',
    colors: ['أبيض'],
    price: 109,
  },
  {
    img: '3765149',
    cat: 'sweatshirts',
    brand: 'urban',
    ar: 'سويت شيرت داكن',
    en: 'Dark Sweatshirt',
    colors: ['أسود'],
    price: 109,
  },
  {
    img: '2887455',
    cat: 'jackets',
    brand: 'sahara',
    ar: 'جاكيت جلد كلاسيكي',
    en: 'Classic Leather Jacket',
    colors: ['أسود'],
    price: 449,
  },
  {
    img: '17474393',
    cat: 'jackets',
    brand: 'urban',
    ar: 'جاكيت منفوخ شتوي',
    en: 'Winter Puffer Jacket',
    colors: ['أسود'],
    price: 329,
  },
  {
    img: '15311965',
    cat: 'jackets',
    brand: 'lina',
    ar: 'جاكيت مربعات',
    en: 'Check Jacket',
    colors: ['أصفر'],
    price: 279,
  },
  {
    img: '32271695',
    cat: 'coats',
    brand: 'lina',
    ar: 'معطف ترنش بيج',
    en: 'Beige Trench',
    colors: ['بيج'],
    price: 389,
  },
  {
    img: '10057707',
    cat: 'coats',
    brand: 'lina',
    ar: 'معطف ترنش كلاسيكي',
    en: 'Classic Trench',
    colors: ['بني'],
    price: 419,
  },
  {
    img: '8217911',
    cat: 'coats',
    brand: 'noor',
    ar: 'معطف طويل محتشم',
    en: 'Long Modest Overcoat',
    colors: ['زيتي'],
    price: 459,
  },
  {
    img: '28174872',
    cat: 'jackets',
    brand: 'urban',
    ar: 'جاكيت جينز',
    en: 'Denim Jacket',
    colors: ['أزرق'],
    price: 219,
  },
  {
    img: '9874909',
    cat: 'jackets',
    brand: 'urban',
    ar: 'جاكيت جينز أوفرسايز',
    en: 'Oversized Denim Jacket',
    colors: ['أزرق'],
    price: 239,
  },
  {
    img: '2319130',
    cat: 'jeans',
    brand: 'urban',
    ar: 'جينز ممزق',
    en: 'Distressed Jeans',
    colors: ['أزرق'],
    price: 179,
  },
  {
    img: '15991060',
    cat: 'blazers',
    brand: 'lina',
    ar: 'بليزر بنقشة زهرية',
    en: 'Floral Print Blazer',
    colors: ['أسود'],
    price: 299,
  },
  {
    img: '13751241',
    cat: 'blazers',
    brand: 'lina',
    ar: 'بليزر رسمي',
    en: 'Tailored Blazer',
    colors: ['أسود'],
    price: 329,
  },
  {
    img: '4355156',
    cat: 'blazers',
    brand: 'lina',
    ar: 'بليزر بقصة واسعة',
    en: 'Relaxed-Fit Blazer',
    colors: ['أسود', 'رمادي'],
    price: 309,
  },
  {
    img: '17397914',
    cat: 'suits',
    brand: 'lina',
    ar: 'بدلة رسمية كلاسيكية',
    en: 'Classic Trouser Suit',
    colors: ['أسود'],
    price: 549,
  },
  {
    img: '13991575',
    cat: 'suits',
    brand: 'lina',
    ar: 'بدلة رسمية وردية',
    en: 'Pink Trouser Suit',
    colors: ['وردي'],
    price: 489,
  },
  {
    img: '27786098',
    cat: 'jeans',
    brand: 'urban',
    ar: 'جينز واسع',
    en: 'Wide-Leg Jeans',
    colors: ['أزرق'],
    price: 199,
  },
  {
    img: '10082926',
    cat: 'jeans',
    brand: 'urban',
    ar: 'جينز بخصر عالٍ',
    en: 'High-Rise Jeans',
    colors: ['أزرق'],
    price: 189,
  },
  {
    img: '24702738',
    cat: 'jeans',
    brand: 'urban',
    ar: 'جينز مستقيم',
    en: 'Straight-Leg Jeans',
    colors: ['أزرق'],
    price: 169,
  },
  {
    img: '9082613',
    cat: 'trousers',
    brand: 'lina',
    ar: 'بنطلون بأزرار ذهبية',
    en: 'Gold-Button Trousers',
    colors: ['أبيض'],
    price: 169,
  },
  {
    img: '27081008',
    cat: 'trousers',
    brand: 'lina',
    ar: 'بنطلون مقلم',
    en: 'Pinstripe Trousers',
    colors: ['أسود'],
    price: 179,
  },
  {
    img: '7705335',
    cat: 'trousers',
    brand: 'urban',
    ar: 'بنطلون مخطط واسع',
    en: 'Striped Wide Trousers',
    colors: ['بيج'],
    price: 139,
  },
  {
    img: '15969866',
    cat: 'skirts',
    brand: 'lina',
    ar: 'تنورة كاروهات',
    en: 'Check Mini Skirt',
    colors: ['أحمر'],
    price: 129,
  },
  {
    img: '932417',
    cat: 'skirts',
    brand: 'lina',
    ar: 'تنورة كاروهات ملوّنة',
    en: 'Multicolour Check Skirt',
    colors: ['كحلي'],
    price: 149,
  },
  {
    img: '9178855',
    cat: 'skirts',
    brand: 'urban',
    ar: 'تنورة بليسيه',
    en: 'Pleated Skirt',
    colors: ['بني'],
    price: 139,
  },
  {
    img: '19163488',
    cat: 'skirts',
    brand: 'urban',
    ar: 'تنورة ميدي',
    en: 'Midi Skirt',
    colors: ['أسود'],
    price: 119,
  },
  {
    img: '2124954',
    cat: 'jumpsuits',
    brand: 'urban',
    ar: 'أوفرول جينز',
    en: 'Denim Dungarees',
    colors: ['أزرق'],
    price: 199,
  },
  {
    img: '3897427',
    cat: 'jumpsuits',
    brand: 'urban',
    ar: 'جمبسوت قطني',
    en: 'Cotton Jumpsuit',
    colors: ['بيج'],
    price: 189,
  },
  {
    img: '2911204',
    cat: 'abayas',
    brand: 'noor',
    ar: 'عباية سوداء كلاسيكية',
    en: 'Classic Black Abaya',
    colors: ['أسود'],
    price: 289,
  },
  {
    img: '36211841',
    cat: 'dresses',
    brand: 'noor',
    ar: 'فستان محتشم خمري',
    en: 'Burgundy Modest Dress',
    colors: ['خمري'],
    price: 259,
  },
  {
    img: '13205610',
    cat: 'hijabs',
    brand: 'noor',
    ar: 'حجاب شيفون',
    en: 'Chiffon Hijab',
    colors: ['أسود', 'بيج', 'كحلي'],
    price: 39,
  },
  {
    img: '34739531',
    cat: 'hijabs',
    brand: 'noor',
    ar: 'حجاب جيرسيه طويل',
    en: 'Long Jersey Hijab',
    colors: ['أسود', 'رمادي'],
    price: 45,
  },
  {
    img: '16353877',
    cat: 'hijabs',
    brand: 'noor',
    ar: 'إيشارب حرير مطبوع',
    en: 'Printed Silk Scarf',
    colors: ['وردي'],
    price: 79,
  },
  {
    img: '14922784',
    cat: 'shoes',
    brand: 'sahara',
    ar: 'حذاء بكعب عالٍ',
    en: 'High-Heel Pumps',
    colors: ['أسود'],
    price: 299,
  },
  {
    img: '27035619',
    cat: 'shoes',
    brand: 'sahara',
    ar: 'حذاء لوفر جلد',
    en: 'Leather Loafers',
    colors: ['بيج', 'أسود'],
    price: 229,
  },
  {
    img: '10657969',
    cat: 'shoes',
    brand: 'urban',
    ar: 'حذاء سنيكرز أبيض',
    en: 'White Sneakers',
    colors: ['أبيض'],
    price: 249,
  },
  {
    img: '9327156',
    cat: 'shoes',
    brand: 'sahara',
    ar: 'حذاء لوفر بإبزيم',
    en: 'Buckle Loafers',
    colors: ['أسود'],
    price: 259,
  },
  {
    img: '14805000',
    cat: 'bags',
    brand: 'urban',
    ar: 'حقيبة توت مطبوعة',
    en: 'Printed Tote',
    colors: ['أزرق'],
    price: 129,
  },
  {
    img: '15320823',
    cat: 'bags',
    brand: 'sahara',
    ar: 'حقيبة يد صغيرة',
    en: 'Mini Top-Handle Purse',
    colors: ['بني'],
    price: 219,
  },
  {
    img: '5745781',
    cat: 'bags',
    brand: 'sahara',
    ar: 'حقيبة يد أنيقة',
    en: 'Structured Purse',
    colors: ['أبيض'],
    price: 279,
  },
  {
    img: '9327162',
    cat: 'bags',
    brand: 'sahara',
    ar: 'حقيبة كتف جلد',
    en: 'Leather Shoulder Purse',
    colors: ['بني', 'أسود'],
    price: 349,
  },
  {
    img: '10120266',
    cat: 'jewelry',
    brand: 'yasmin',
    ar: 'أقراط ذهبية',
    en: 'Gold Earrings',
    colors: ['ذهبي'],
    price: 149,
  },
  {
    img: '13530465',
    cat: 'jewelry',
    brand: 'yasmin',
    ar: 'قلادة ذهبية ناعمة',
    en: 'Fine Gold Necklace',
    colors: ['ذهبي'],
    price: 189,
  },
  {
    img: '7615245',
    cat: 'jewelry',
    brand: 'yasmin',
    ar: 'سلسلة ذهبية عريضة',
    en: 'Chunky Gold Chain',
    colors: ['ذهبي'],
    price: 239,
  },
  {
    img: '9649265',
    cat: 'jewelry',
    brand: 'yasmin',
    ar: 'قلادة لؤلؤ',
    en: 'Pearl Necklace',
    colors: ['ذهبي'],
    price: 199,
  },
  {
    img: '32382386',
    cat: 'jewelry',
    brand: 'yasmin',
    ar: 'طقم خواتم بأحجار ملوّنة',
    en: 'Gemstone Rings Set',
    colors: ['ذهبي'],
    price: 259,
  },
  {
    img: '12320903',
    cat: 'jewelry',
    brand: 'yasmin',
    ar: 'سوار ذهبي ناعم',
    en: 'Fine Gold Bracelet',
    colors: ['ذهبي'],
    price: 169,
  },
  {
    img: '14668285',
    cat: 'watches',
    brand: 'yasmin',
    ar: 'ساعة يد كلاسيكية',
    en: 'Classic Wristwatch',
    colors: ['أسود'],
    price: 349,
  },
  {
    img: '19810841',
    cat: 'watches',
    brand: 'yasmin',
    ar: 'ساعة معدنية',
    en: 'Steel Wristwatch',
    colors: ['فضي'],
    price: 489,
  },
  {
    img: '19269891',
    cat: 'eyewear',
    brand: 'urban',
    ar: 'نظارة شمسية دائرية',
    en: 'Round Sunglasses',
    colors: ['أسود'],
    price: 129,
  },
  {
    img: '3008144',
    cat: 'eyewear',
    brand: 'urban',
    ar: 'نظارة شمسية ملوّنة العدسات',
    en: 'Tinted Sunglasses',
    colors: ['وردي'],
    price: 119,
  },
  {
    img: '8893712',
    cat: 'hats',
    brand: 'urban',
    ar: 'قبعة بيريه',
    en: 'Beret',
    colors: ['بيج'],
    price: 59,
  },
  {
    img: '5737913',
    cat: 'socks',
    brand: 'urban',
    ar: 'جوارب قطنية ملوّنة',
    en: 'Colourful Cotton Socks',
    colors: ['أخضر', 'برتقالي'],
    price: 25,
  },
];

const now = new Date();
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Store split: every third product is sold by both stores (comparison). */
function storesFor(index: number): (1 | 2)[] {
  if (index % 3 === 0) return [1, 2];
  return index % 3 === 1 ? [1] : [2];
}

/** 3 to 5 consecutive size codes, varied per product; [null] = no size. */
function sizesFor(
  audience: ProductAudience,
  kind: Kind,
  index: number,
): (string | null)[] {
  const sizes = SIZE_CODES[audience === 'KIDS' ? 'kids' : 'adult'][kind];
  if (sizes.length === 0) return [null];
  const start = index % 2;
  const end = sizes.length - (index % 3 === 0 ? 1 : 0);
  return sizes.slice(start, Math.max(start + 3, end));
}

function stockFor(index: number, variantIndex: number, store: number): number {
  if ((index + variantIndex + store) % 17 === 0) return 0; // sold out
  if ((index + variantIndex) % 11 === 0) return 2; // low stock
  return ((index * 7 + variantIndex * 3 + store * 5) % 28) + 4;
}

/** Store two prices a little differently, so comparison is meaningful. */
function storePrice(base: number, store: 1 | 2, index: number): number {
  if (store === 1) return base;
  const delta = [10, -10, 15, -5, 20][index % 5];
  return Math.max(15, base + delta);
}

/** One product to create, whatever list it came from. */
interface SeedProduct {
  key: string;
  audience: ProductAudience;
  code: string;
  /** The demo `categories` row (canonical products need one). */
  categoryId: string;
  categoryAr: string;
  categoryEn: string;
  season: ProductSeason | null;
  brand: keyof typeof BRANDS;
  ar: string;
  en: string;
  colorCodes: string[];
  sizeCodes: (string | null)[];
  price: number;
  image: string;
  /** Position within its own list - decides which store(s) sell it. */
  listIndex: number;
}

function catalog(): SeedProduct[] {
  const women = PRODUCTS.map((p, index): SeedProduct => {
    const category = CATEGORIES[p.cat];
    const colorCodes = [
      ...new Set(
        p.colors.map((c) => {
          const code = COLOR_CODE[c];
          if (!code) throw new Error(`No taxonomy colour for "${c}"`);
          return code;
        }),
      ),
    ];
    return {
      key: `w-${p.img}`,
      audience: 'WOMEN',
      code: category.code,
      categoryId: stableId(`category:${p.cat}`),
      categoryAr: category.ar,
      categoryEn: `Via Demo Women - ${category.en}`,
      season: category.season,
      brand: p.brand,
      ar: p.ar,
      en: p.en,
      colorCodes,
      sizeCodes: sizesFor('WOMEN', category.kind, index),
      price: p.price,
      image: `/demo-assets/women-catalog/wd-${p.img}.jpg`,
      listIndex: index,
    };
  });
  const other = (audience: ProductAudience, list: AudienceProduct[]) =>
    list.map((p, index): SeedProduct => ({
      key: p.key,
      audience,
      code: p.code,
      categoryId: catalogId(`category:${audience}:${p.code}`),
      categoryAr: p.catAr,
      categoryEn: `Via Demo ${audience === 'MEN' ? 'Men' : 'Kids'} - ${p.code}`,
      season: p.season,
      brand: p.brand,
      ar: p.ar,
      en: p.en,
      colorCodes: p.colors,
      sizeCodes: sizesFor(audience, p.kind, index),
      price: p.price,
      image: p.image,
      listIndex: index,
    }));
  // Interleaved, so "newest" mixes the three audiences realistically.
  const men = other('MEN', MEN_PRODUCTS);
  const kids = other('KIDS', KIDS_PRODUCTS);
  const all: SeedProduct[] = [];
  for (let i = 0; i < Math.max(women.length, men.length, kids.length); i++) {
    if (women[i]) all.push(women[i]);
    if (men[i]) all.push(men[i]);
    if (kids[i]) all.push(kids[i]);
  }
  return all;
}

/** The first version's unclassified demo offers (for --retire-v1). */
function v1OfferIds(): string[] {
  return PRODUCTS.flatMap((p, index) =>
    storesFor(index).map((store) => stableId(`offer:${p.img}:${store}`)),
  );
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  requireLocalDatabase(url);
  const retireV1 = process.argv.includes('--retire-v1');
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });

  try {
    const [vendorOne, vendorTwo] = await Promise.all(
      [VENDOR_ONE.slug, VENDOR_TWO.slug].map((slug) =>
        prisma.vendor.findUnique({ where: { slug } }),
      ),
    );
    if (!vendorOne || !vendorTwo) {
      throw new Error(
        'Demo stores not found - run scripts/seed-demo.ts first (this seed only reuses them).',
      );
    }
    const vendors = { 1: vendorOne, 2: vendorTwo } as const;
    const branches = {} as Record<1 | 2, string>;
    for (const n of [1, 2] as const) {
      const branch = await prisma.storeBranch.findFirst({
        where: { vendorId: vendors[n].id, archivedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (!branch) throw new Error(`No active branch for ${vendors[n].slug}`);
      branches[n] = branch.id;
    }

    // The taxonomy's own labels (and a check every code exists).
    const [colors, sizes, categoryLinks] = await Promise.all([
      prisma.taxonomyColor.findMany(),
      prisma.taxonomySize.findMany(),
      prisma.taxonomyCategoryAudience.findMany(),
    ]);
    if (!colors.some((c) => c.code === 'GRAY')) {
      throw new Error(
        'Taxonomy colour GRAY missing - apply migration 20261023090000_product_taxonomy_spring_gray first.',
      );
    }
    const colorLabel = new Map(colors.map((c) => [c.code, c.nameAr]));
    const sizeLabel = new Map(sizes.map((s) => [s.code, s.label]));
    const linked = new Set(
      categoryLinks.map((l) => `${l.categoryCode}:${l.audience}`),
    );
    const products = catalog();
    for (const p of products) {
      if (!linked.has(`${p.code}:${p.audience}`)) {
        throw new Error(
          `${p.key}: category ${p.code} is not a ${p.audience} category`,
        );
      }
      for (const c of p.colorCodes) {
        if (!colorLabel.has(c))
          throw new Error(`${p.key}: unknown colour ${c}`);
      }
      for (const s of p.sizeCodes) {
        if (s !== null && !sizeLabel.has(s)) {
          throw new Error(`${p.key}: unknown size ${s}`);
        }
      }
    }

    const stats = {
      productsCreated: 0,
      productsExisting: 0,
      offers: 0,
      offerVariants: 0,
      retired: 0,
    };

    await prisma.$transaction(
      async (tx) => {
        // Both demo stores list all three segments
        // (vendor_applicable_categories - the store-level `segment`).
        for (const n of [1, 2] as const) {
          for (const category of ['WOMEN', 'MEN', 'KIDS'] as const) {
            await tx.vendorApplicableCategory.upsert({
              where: {
                vendorId_category: { vendorId: vendors[n].id, category },
              },
              create: { vendorId: vendors[n].id, category },
              update: {},
            });
          }
        }

        const brandIds: Record<string, string> = {};
        for (const [key, name] of Object.entries(BRANDS)) {
          const brand = await tx.brand.upsert({
            where: { normalizedName: `via-demo-${key}` },
            create: {
              id: stableId(`brand:${key}`),
              name,
              normalizedName: `via-demo-${key}`,
            },
            update: {},
          });
          brandIds[key] = brand.id;
        }

        for (const p of products) {
          await tx.category.upsert({
            where: { id: p.categoryId },
            create: {
              id: p.categoryId,
              nameAr: p.categoryAr,
              nameEn: p.categoryEn,
            },
            update: {},
          });
        }

        for (const [index, p] of products.entries()) {
          const productId = catalogId(`product:${p.key}`);
          const exists = await tx.canonicalProduct.findUnique({
            where: { id: productId },
            select: { id: true },
          });
          if (exists) {
            stats.productsExisting++;
            continue;
          }
          // Staggered so "newest" ordering is stable and meaningful.
          const addedAt = new Date(now.getTime() - index * HOUR);
          await tx.canonicalProduct.create({
            data: {
              id: productId,
              brandId: brandIds[p.brand],
              categoryId: p.categoryId,
              modelName: `${p.en} (VCAT-${p.key})`,
              status: 'PUBLISHED',
              canonicalNameAr: p.ar,
              canonicalNameEn: p.en,
              createdAt: addedAt,
            },
          });

          const variants = p.colorCodes.flatMap((colorCode, ci) =>
            p.sizeCodes.map((sizeCode, si) => ({
              key: `${p.key}-${ci}-${si}`,
              colorCode,
              sizeCode,
              colour: colorLabel.get(colorCode)!,
              size: sizeCode ? sizeLabel.get(sizeCode)! : null,
            })),
          );
          for (const v of variants) {
            await tx.canonicalProductVariant.create({
              data: {
                id: catalogId(`variant:${v.key}`),
                canonicalProductId: productId,
                structuralAttributes: v.size
                  ? { color: v.colour, size: v.size }
                  : { color: v.colour },
                platformProductBarcode: `PPB-VCAT-${v.key}`,
              },
            });
          }

          const stores = storesFor(p.listIndex);
          for (const store of stores) {
            const vendor = vendors[store];
            const offerId = catalogId(`offer:${p.key}:${store}`);
            // Classified from birth: the classification exists before
            // any variant, which is then a combination (the DB triggers
            // refuse anything else on a classified offer).
            await tx.vendorOffer.create({
              data: {
                id: offerId,
                vendorId: vendor.id,
                canonicalProductId: productId,
                brandId: brandIds[p.brand],
                titleAr: p.ar,
                titleEn: p.en,
                status: 'ACTIVE',
                firstPublishedAt: now,
                createdAt: new Date(addedAt.getTime() + store * 60_000),
                season: p.season,
                taxonomyVersion: 1,
                requiresTaxonomy: true,
              },
            });
            await tx.vendorOfferAudience.create({
              data: {
                vendorId: vendor.id,
                vendorOfferId: offerId,
                audience: p.audience,
              },
            });
            await tx.vendorOfferCategory.create({
              data: {
                vendorId: vendor.id,
                vendorOfferId: offerId,
                categoryCode: p.code,
              },
            });
            stats.offers++;

            // One price per store offer (the unified-price rule).
            // A manual sale price on every 5th product (first store), a
            // scheduled % discount on every 7th (last store).
            const base = storePrice(p.price, store, index);
            const sale =
              index % 5 === 0 && store === stores[0]
                ? Math.round(base * 0.8)
                : null;
            const scheduled =
              index % 7 === 3 &&
              store === stores[stores.length - 1] &&
              sale === null;

            for (const [vi, v] of variants.entries()) {
              const offerVariantId = catalogId(
                `offer-variant:${v.key}:${store}`,
              );
              await tx.offerVariant.create({
                data: {
                  id: offerVariantId,
                  vendorId: vendor.id,
                  vendorOfferId: offerId,
                  canonicalVariantId: catalogId(`variant:${v.key}`),
                  matchProposalStatus: 'CONFIRMED',
                  sellerSku: `VCAT-${v.key}`,
                  storeInventoryBarcode: `VCAT-INV-${v.key}-S${store}`,
                  isCombination: true,
                  colorCode: v.colorCode,
                  sizeCode: v.sizeCode,
                  colour: v.colour,
                  size: v.size,
                  basePrice: base,
                  salePrice: sale,
                  discountPercent: scheduled ? 25 : null,
                  discountStartAt: scheduled
                    ? new Date(now.getTime() - 2 * DAY)
                    : null,
                  discountEndAt: scheduled
                    ? new Date(now.getTime() + 90 * DAY)
                    : null,
                },
              });
              await tx.offerVariantMedia.create({
                data: {
                  id: catalogId(`media:${v.key}:${store}`),
                  vendorId: vendor.id,
                  offerVariantId,
                  url: p.image,
                  kind: 'PRIMARY',
                  altTextAr: p.ar,
                  altTextEn: p.en,
                },
              });
              await tx.branchStock.create({
                data: {
                  id: catalogId(`stock:${v.key}:${store}`),
                  vendorId: vendor.id,
                  branchId: branches[store],
                  offerVariantId,
                  quantity: stockFor(index, vi, store),
                },
              });
              stats.offerVariants++;
            }
          }
          stats.productsCreated++;
        }

        if (retireV1) {
          const retired = await tx.vendorOffer.updateMany({
            where: {
              id: { in: v1OfferIds() },
              taxonomyVersion: null,
              status: 'ACTIVE',
            },
            data: { status: 'INACTIVE' },
          });
          stats.retired = retired.count;
        }
      },
      { timeout: 180_000 },
    );

    console.log('Women / men / kids catalog demo seed complete:');
    console.log(
      `  products created: ${stats.productsCreated} (already present: ${stats.productsExisting}, total defined: ${products.length})`,
    );
    console.log(
      `  offers created: ${stats.offers}, offer variants (combinations) created: ${stats.offerVariants}`,
    );
    if (retireV1) {
      console.log(
        `  old unclassified v1 demo offers set to INACTIVE: ${stats.retired}`,
      );
    } else {
      const v1Active = await prisma.vendorOffer.count({
        where: {
          id: { in: v1OfferIds() },
          taxonomyVersion: null,
          status: 'ACTIVE',
        },
      });
      if (v1Active > 0) {
        console.log(
          `  note: ${v1Active} old unclassified v1 demo offers are still ACTIVE - re-run with --retire-v1 to hide them.`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
