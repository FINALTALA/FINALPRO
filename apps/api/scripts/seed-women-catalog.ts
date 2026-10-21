/**
 * Women's catalog demo seed - LOCAL DEVELOPMENT DATABASE ONLY.
 *
 * Adds ~90 women's fashion products (dresses, tops, knitwear, outerwear,
 * bottoms, modest wear, shoes, bags, jewellery, watches, accessories)
 * offered by the two existing demo stores, so the women's listing has a
 * realistic catalogue for infinite scroll, filters, sorting and
 * multi-store comparison.
 *
 * - Refuses to run against anything but a local database
 *   (requireLocalDatabase, shared with the other demo seeds).
 * - Idempotent: every row gets a deterministic id derived from a stable
 *   key ("via-women-catalog-v1:<key>") and is written with
 *   upsert({ update: {} }), so re-runs add nothing and never overwrite.
 * - Additive only: never updates or deletes existing products, offers,
 *   stores, reviews, favourites or orders. Creates no reviews, ratings,
 *   purchases or favourites.
 * - Everything it creates is identifiable: brands use normalizedName
 *   "via-demo-*", categories use nameEn "Via Demo Women - *", platform
 *   barcodes "PPB-WDEMO-*", seller SKUs "WDEMO-*".
 *
 * Images: Pexels photos (Pexels License, free for commercial use),
 * stored locally in apps/web/public/demo-assets/women-catalog/ and
 * referenced as /demo-assets/women-catalog/wd-<pexelsId>.jpg.
 *
 * Run from apps/api:  npx ts-node scripts/seed-women-catalog.ts
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { requireLocalDatabase } from './local-db-guard';
import { VENDOR_ONE, VENDOR_TWO } from './seed-demo.constants';

const NAMESPACE = 'via-women-catalog-v1';

/** Deterministic UUID-shaped id, same scheme as seed-scenarios.ts. */
function stableId(key: string): string {
  const h = createHash('sha256').update(`${NAMESPACE}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const CLOTHING_SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const SHOE_SIZES = ['37', '38', '39', '40', '41'];

type Kind = 'clothing' | 'shoes' | 'onesize';

// Category per product type. The Arabic names are what the storefront's
// category terms match against, so each is a single unambiguous type.
const CATEGORIES: Record<string, { ar: string; en: string; kind: Kind }> = {
  dresses: { ar: 'فساتين', en: 'Dresses', kind: 'clothing' },
  tops: { ar: 'بلايز', en: 'Blouses', kind: 'clothing' },
  shirts: { ar: 'قمصان', en: 'Shirts', kind: 'clothing' },
  tshirts: { ar: 'تيشيرتات', en: 'T-Shirts', kind: 'clothing' },
  knitwear: { ar: 'كنزات', en: 'Knitwear', kind: 'clothing' },
  cardigans: { ar: 'كارديغان', en: 'Cardigans', kind: 'clothing' },
  hoodies: { ar: 'هوديز', en: 'Hoodies', kind: 'clothing' },
  sweatshirts: { ar: 'سويت شيرت', en: 'Sweatshirts', kind: 'clothing' },
  jackets: { ar: 'جاكيتات', en: 'Jackets', kind: 'clothing' },
  coats: { ar: 'معاطف', en: 'Coats', kind: 'clothing' },
  blazers: { ar: 'بليزرات', en: 'Blazers', kind: 'clothing' },
  suits: { ar: 'بدلات', en: 'Suits', kind: 'clothing' },
  jeans: { ar: 'جينز', en: 'Jeans', kind: 'clothing' },
  trousers: { ar: 'بناطيل', en: 'Trousers', kind: 'clothing' },
  skirts: { ar: 'تنانير', en: 'Skirts', kind: 'clothing' },
  jumpsuits: { ar: 'أوفرولات', en: 'Jumpsuits', kind: 'clothing' },
  sets: { ar: 'أطقم', en: 'Sets', kind: 'clothing' },
  abayas: { ar: 'عبايات', en: 'Abayas', kind: 'clothing' },
  kaftans: { ar: 'قفاطين', en: 'Kaftans', kind: 'clothing' },
  hijabs: { ar: 'حجابات', en: 'Hijabs', kind: 'onesize' },
  shoes: { ar: 'أحذية', en: 'Shoes', kind: 'shoes' },
  bags: { ar: 'حقائب', en: 'Handbags', kind: 'onesize' },
  jewelry: { ar: 'مجوهرات', en: 'Jewellery', kind: 'onesize' },
  watches: { ar: 'ساعات', en: 'Watches', kind: 'onesize' },
  eyewear: { ar: 'نظارات', en: 'Eyewear', kind: 'onesize' },
  hats: { ar: 'قبعات', en: 'Hats', kind: 'onesize' },
  socks: { ar: 'جوارب', en: 'Socks', kind: 'onesize' },
};

const BRANDS: Record<string, string> = {
  lina: 'Lina Atelier',
  noor: 'Noor Modest',
  qasr: 'Qasr Knitwear',
  sahara: 'Sahara Leather',
  yasmin: 'Yasmin Jewels',
  urban: 'Urban Thread',
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

/** Store split: every third product is sold by both stores (comparison). */
function storesFor(index: number): (1 | 2)[] {
  if (index % 3 === 0) return [1, 2];
  return index % 3 === 1 ? [1] : [2];
}

function sizesFor(kind: Kind, index: number): (string | null)[] {
  if (kind === 'onesize') return [null];
  const sizes = kind === 'shoes' ? SHOE_SIZES : CLOTHING_SIZES;
  // 3 to 5 consecutive sizes, varied per product.
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  requireLocalDatabase(url);
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

    const stats = {
      productsCreated: 0,
      productsExisting: 0,
      offers: 0,
      offerVariants: 0,
    };

    await prisma.$transaction(
      async (tx) => {
        // Both demo stores must list the women's segment (vendor_applicable_categories).
        for (const n of [1, 2] as const) {
          await tx.vendorApplicableCategory.upsert({
            where: {
              vendorId_category: { vendorId: vendors[n].id, category: 'WOMEN' },
            },
            create: { vendorId: vendors[n].id, category: 'WOMEN' },
            update: {},
          });
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

        const categoryIds: Record<string, string> = {};
        for (const [key, cat] of Object.entries(CATEGORIES)) {
          const id = stableId(`category:${key}`);
          await tx.category.upsert({
            where: { id },
            create: {
              id,
              nameAr: cat.ar,
              nameEn: `Via Demo Women - ${cat.en}`,
            },
            update: {},
          });
          categoryIds[key] = id;
        }

        for (const [index, p] of PRODUCTS.entries()) {
          const productId = stableId(`product:${p.img}`);
          const exists = await tx.canonicalProduct.findUnique({
            where: { id: productId },
            select: { id: true },
          });
          if (exists) {
            stats.productsExisting++;
            continue;
          }
          const category = CATEGORIES[p.cat];
          await tx.canonicalProduct.create({
            data: {
              id: productId,
              brandId: brandIds[p.brand],
              categoryId: categoryIds[p.cat],
              modelName: `${p.en} (WDEMO-${p.img})`,
              status: 'PUBLISHED',
              canonicalNameAr: p.ar,
              canonicalNameEn: p.en,
              // Staggered so "newest" ordering is stable and meaningful.
              createdAt: new Date(now.getTime() - index * 3_600_000),
            },
          });

          const variants = p.colors.flatMap((color, ci) =>
            sizesFor(category.kind, index).map((size, si) => ({
              key: `${p.img}-${ci}-${si}`,
              attrs: size ? { color, size } : { color },
            })),
          );
          for (const v of variants) {
            await tx.canonicalProductVariant.create({
              data: {
                id: stableId(`variant:${v.key}`),
                canonicalProductId: productId,
                structuralAttributes: v.attrs,
                platformProductBarcode: `PPB-WDEMO-${v.key}`,
              },
            });
          }

          for (const store of storesFor(index)) {
            const vendor = vendors[store];
            const offerId = stableId(`offer:${p.img}:${store}`);
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
              },
            });
            stats.offers++;

            const base = storePrice(p.price, store, index);
            // Discounts, using only the schema's own pricing fields:
            // a manual sale price on every 5th product (first store),
            // a scheduled % discount on every 7th (second store).
            const sale =
              index % 5 === 0 && store === storesFor(index)[0]
                ? Math.round(base * 0.8)
                : null;
            const scheduled =
              index % 7 === 3 &&
              store === storesFor(index)[storesFor(index).length - 1] &&
              sale === null;

            for (const [vi, v] of variants.entries()) {
              const offerVariantId = stableId(
                `offer-variant:${v.key}:${store}`,
              );
              await tx.offerVariant.create({
                data: {
                  id: offerVariantId,
                  vendorId: vendor.id,
                  vendorOfferId: offerId,
                  canonicalVariantId: stableId(`variant:${v.key}`),
                  matchProposalStatus: 'CONFIRMED',
                  sellerSku: `WDEMO-${v.key}`,
                  storeInventoryBarcode: `WDEMO-INV-${v.key}-S${store}`,
                  colour: v.attrs.color,
                  size: 'size' in v.attrs ? v.attrs.size : null,
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
                  id: stableId(`media:${v.key}:${store}`),
                  vendorId: vendor.id,
                  offerVariantId,
                  url: `/demo-assets/women-catalog/wd-${p.img}.jpg`,
                  kind: 'PRIMARY',
                  altTextAr: p.ar,
                  altTextEn: p.en,
                },
              });
              await tx.branchStock.create({
                data: {
                  id: stableId(`stock:${v.key}:${store}`),
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
      },
      { timeout: 120_000 },
    );

    console.log('Women catalog demo seed complete:');
    console.log(
      `  products created: ${stats.productsCreated} (already present: ${stats.productsExisting}, total defined: ${PRODUCTS.length})`,
    );
    console.log(
      `  offers created: ${stats.offers}, offer variants created: ${stats.offerVariants}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
