/**
 * The women's listing category taxonomy - the single source of truth for
 * which products belong to which category (the storefront keeps only the
 * slug, label and image for each). Products carry a free-form canonical
 * category plus Arabic/English names, so a category is matched by terms
 * against those - never by a stored category id.
 */
export interface WomenCategoryRule {
  slug: string;
  terms: string[];
  exclude?: string[];
}

export const WOMEN_CATEGORY_RULES: WomenCategoryRule[] = [
  { slug: 'dresses', terms: ['فستان', 'فساتين', 'dress'] },
  {
    slug: 'tops',
    terms: ['توب', 'بلوزه', 'بلايز', 'كروب', 'top', 'blouse', 'tank', 'crop'],
  },
  {
    slug: 't-shirts',
    terms: ['تيشيرت', 'تي شيرت', 't-shirt', 'tshirt', 'tee$'],
  },
  {
    slug: 'shirts',
    terms: ['قميص', 'قمصان', 'shirt'],
    exclude: ['تيشيرت', 'تي شيرت', 'قميص نوم', 't-shirt', 'tshirt'],
  },
  {
    slug: 'trousers',
    terms: ['بنطال', 'بنطلون', 'بناطيل', 'pants', 'trousers'],
  },
  { slug: 'jeans', terms: ['جينز', 'دينم', 'jeans', 'denim'] },
  { slug: 'skirts', terms: ['تنوره', 'تنانير', 'جيبه', 'skirt'] },
  { slug: 'shorts', terms: ['شورت', 'shorts$'] },
  { slug: 'jackets', terms: ['جاكيت', 'جاكت', 'جكيت', 'jacket'] },
  { slug: 'coats', terms: ['معطف', 'معاطف', 'ترنش', 'coat$', 'trench'] },
  { slug: 'blazers', terms: ['بليزر', 'blazer'] },
  {
    slug: 'cardigans',
    terms: ['كارديغان', 'كارديجان', 'كارديقان', 'cardigan'],
  },
  { slug: 'hoodies', terms: ['هودي', 'hoodie'] },
  { slug: 'sweatshirts', terms: ['سويت شيرت', 'سويتشيرت', 'sweatshirt'] },
  {
    slug: 'knitwear',
    terms: [
      'كنزه',
      'كنزات',
      'سويتر',
      'بلوفر',
      'تريكو',
      'sweater',
      'knit',
      'pullover',
      'jumper',
    ],
  },
  {
    slug: 'two-piece-sets',
    terms: ['طقم', 'اطقم', 'قطعتين', 'co-ord', 'set$'],
    exclude: ['بيجام', 'pajama', 'pyjama'],
  },
  {
    slug: 'jumpsuits',
    terms: [
      'جمبسوت',
      'اوفرول',
      'اوفرهول',
      'سالوبيت',
      'jumpsuit',
      'overall',
      'dungaree',
      'romper',
    ],
  },
  {
    slug: 'suits',
    terms: ['بدله', 'بدلات', 'suit$'],
    exclude: ['رياضي', 'سباحه', 'tracksuit', 'swimsuit', 'jumpsuit'],
  },
  {
    slug: 'activewear',
    terms: [
      'رياضي',
      'ليغنز',
      'ليجنز',
      'sport',
      'active',
      'legging',
      'tracksuit',
      'gym$',
      'yoga',
    ],
  },
  {
    slug: 'swimwear',
    terms: [
      'مايوه',
      'سباحه',
      'بوركيني',
      'swim',
      'bikini',
      'burkini',
      'beachwear',
    ],
  },
  {
    slug: 'sleepwear',
    terms: [
      'بيجاما',
      'بيجامه',
      'بيجامات',
      'قميص نوم',
      'ملابس نوم',
      'pajama',
      'pyjama',
      'sleepwear',
      'nightgown',
      'nightdress',
    ],
  },
  { slug: 'loungewear', terms: ['منزلي', 'لاونج', 'lounge', 'homewear'] },
  {
    slug: 'underwear',
    terms: [
      'داخلي',
      'صدريه',
      'ستيان',
      'كلسون',
      'underwear',
      'bra$',
      'brief',
      'panties',
      'panty',
    ],
  },
  { slug: 'lingerie', terms: ['لانجري', 'لانجيري', 'لنجري', 'lingerie'] },
  {
    slug: 'maternity',
    terms: ['حوامل', 'ملابس حمل', 'فستان حمل', 'maternity', 'pregnan'],
  },
  { slug: 'modest-wear', terms: ['محجبات', 'محتشم', 'modest'] },
  { slug: 'abayas', terms: ['عبايه', 'عباءه', 'عبايات', 'abaya'] },
  {
    slug: 'kaftans',
    terms: [
      'جلابيه',
      'جلابيات',
      'قفطان',
      'قفاطين',
      'كفتان',
      'kaftan',
      'caftan',
      'jalabiya',
    ],
  },
  {
    slug: 'hijabs-shawls',
    terms: ['حجاب', 'طرحه', 'شال', 'hijab', 'shawl', 'scarf', 'scarves'],
  },
  {
    slug: 'shoes',
    terms: [
      'حذاء',
      'احذيه',
      'كعب',
      'صندل',
      'جزمه',
      'بوط',
      'shoe',
      'heels',
      'sandal',
      'sneaker',
      'boots',
    ],
  },
  {
    slug: 'bags',
    terms: ['حقيبه', 'حقائب', 'شنطه', 'شنط', 'bag', 'handbag', 'clutch'],
  },
  {
    slug: 'jewelry',
    terms: [
      'مجوهرات',
      'قلاده',
      'سلسال',
      'اقراط',
      'حلق',
      'خاتم',
      'سوار',
      'اسواره',
      'jewel',
      'necklace',
      'earring',
      'bracelet',
      'ring$',
    ],
  },
  { slug: 'watches', terms: ['ساعه', 'ساعات', 'watch'] },
  {
    slug: 'sunglasses',
    terms: ['نظاره', 'نظارات', 'sunglass', 'eyewear', 'glasses'],
  },
  { slug: 'belts', terms: ['حزام', 'احزمه', 'belt'] },
  {
    slug: 'hats',
    terms: [
      'قبعه',
      'قبعات',
      'طاقيه',
      'طواقي',
      'برنيطه',
      'hat$',
      'cap$',
      'beret',
      'beanie',
    ],
  },
  {
    slug: 'accessories',
    terms: ['اكسسوار', 'مشبك', 'توكه', 'accessor', 'keychain'],
  },
  { slug: 'socks', terms: ['جوارب', 'جراب', 'كلسات', 'sock'] },
];

const RULES_BY_SLUG = new Map(
  WOMEN_CATEGORY_RULES.map((rule) => [rule.slug, rule]),
);

export function isWomenCategorySlug(slug: string): boolean {
  return RULES_BY_SLUG.has(slug);
}

/** Folds the Arabic letter variants vendors use interchangeably (أ/إ/آ,
 * ة/ه, ى/ي) and strips diacritics, so "تنورة" matches "تنوره". */
export function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

function containsTerm(haystack: string, term: string): boolean {
  // A trailing "$" marks a whole-word Latin term (plural "s" allowed), so
  // "bra$" never matches "bracelet" and "hat$" never matches "chat".
  const wholeWord = term.endsWith('$');
  const normalized = normalizeText(wholeWord ? term.slice(0, -1) : term);
  // Latin terms match at a word start only, so "tee" never matches
  // "steel" and "set" never matches "closet".
  if (/^[a-z-]+$/.test(normalized)) {
    const escaped = normalized.replace(/-/g, '\\-');
    return new RegExp(
      `(^|[^a-z])${escaped}${wholeWord ? 's?([^a-z]|$)' : ''}`,
    ).test(haystack);
  }
  return haystack.includes(normalized);
}

/** `searchText` must already be normalizeText()-ed. */
export function matchesWomenCategory(
  searchText: string,
  slug: string,
): boolean {
  const rule = RULES_BY_SLUG.get(slug);
  if (!rule) return false;
  if (rule.exclude?.some((term) => containsTerm(searchText, term)))
    return false;
  return rule.terms.some((term) => containsTerm(searchText, term));
}

/** The text a product is matched on: its Arabic and English canonical
 * names plus its canonical category's Arabic name. */
export function productSearchText(
  nameAr: string | null,
  nameEn: string | null,
  categoryNameAr: string | null,
): string {
  return normalizeText(
    `${nameAr ?? ''} ${nameEn ?? ''} ${categoryNameAr ?? ''}`,
  );
}
