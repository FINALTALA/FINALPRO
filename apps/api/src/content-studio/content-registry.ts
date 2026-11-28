/**
 * VIA phase 6 - Content Studio: the managed sections of the three pages
 * and what each may contain. ONE registry, used to validate drafts
 * (structure), publication (required copy, alt text, dependencies) and to
 * drive the admin editor (served at GET /admin/content/registry).
 *
 * Document (typed, versioned JSON - schemaVersion 1):
 *   { schemaVersion: 1, sections: Section[] }
 *   Section = { id, key, enabled, fields: {name: Value}, items: Item[] }
 *   Item    = { id, fields: {name: Value} }
 * Order is explicit: the array order (sections and items).
 * Value by field type:
 *   text  -> { ar: string, en: string }
 *   media -> { source: 'bundled', path } | { source: 'library', assetId },
 *            + alt: { ar, en } (required for publication)
 *   link  -> { href }                       (a site-relative path)
 *   ref   -> { refType, refId }             (store | collection | category | product)
 */

export const CONTENT_SCHEMA_VERSION = 1;
export const CONTENT_PAGES = [
  'HOMEPAGE',
  'TRENDING',
  'ADS',
  'WOMEN',
  'MEN',
  'KIDS',
] as const;
export type ContentPageKey = (typeof CONTENT_PAGES)[number];

export type FieldType = 'text' | 'media' | 'link' | 'ref';
export interface FieldDef {
  name: string;
  type: FieldType;
  /** required for publication (drafts may be incomplete) */
  required?: boolean;
  /** media: which kinds; ref: which reference type */
  media?: ('IMAGE' | 'VIDEO')[];
  refType?: 'store' | 'collection' | 'category' | 'product';
  /** a required structural visual: if it breaks after publication the public page uses its bundled fallback */
  structural?: boolean;
  /** media: purely decorative (rendered with alt="" and hidden from assistive tech) - needs no alt text */
  decorative?: boolean;
  label: { ar: string; en: string };
}
export interface SectionDef {
  key: string;
  page: ContentPageKey;
  label: { ar: string; en: string };
  fields: FieldDef[];
  items?: {
    min: number;
    max: number;
    fields: FieldDef[];
    label: { ar: string; en: string };
  };
}

const t = (ar: string, en: string) => ({ ar, en });
const heading: FieldDef = {
  name: 'heading',
  type: 'text',
  required: true,
  label: t('العنوان', 'Heading'),
};

export const SECTIONS: SectionDef[] = [
  // -------------------------------------------------------- HOMEPAGE
  {
    key: 'home.hero',
    page: 'HOMEPAGE',
    label: t('الواجهة الرئيسية', 'Hero'),
    fields: [
      {
        name: 'headline',
        type: 'text',
        required: true,
        label: t('العنوان الرئيسي', 'Headline'),
      },
      { name: 'subline', type: 'text', label: t('النص الفرعي', 'Subline') },
      {
        name: 'cta_label',
        type: 'text',
        required: true,
        label: t('نص الزر', 'Button label'),
      },
      {
        name: 'cta_link',
        type: 'link',
        required: true,
        label: t('رابط الزر', 'Button link'),
      },
      {
        name: 'image',
        type: 'media',
        media: ['IMAGE'],
        required: true,
        structural: true,
        label: t('الصورة', 'Image'),
      },
    ],
  },
  {
    key: 'home.stories',
    page: 'HOMEPAGE',
    label: t('قصص VIA', 'VIA Stories'),
    fields: [heading],
    items: {
      min: 1,
      max: 12,
      label: t('قصة', 'Story'),
      fields: [
        {
          name: 'label',
          type: 'text',
          required: true,
          label: t('التصنيف', 'Label'),
        },
        {
          name: 'title',
          type: 'text',
          required: true,
          label: t('العنوان', 'Title'),
        },
        {
          name: 'image',
          type: 'media',
          media: ['IMAGE'],
          required: true,
          label: t('الصورة', 'Image'),
        },
        { name: 'link', type: 'link', label: t('الرابط', 'Link') },
      ],
    },
  },
  {
    key: 'home.picks',
    page: 'HOMEPAGE',
    label: t('اختيارات المحررين', 'Editorial Product Picks'),
    fields: [heading],
    items: {
      min: 0,
      max: 24,
      label: t('منتج', 'Product'),
      fields: [
        {
          name: 'product',
          type: 'ref',
          refType: 'product',
          required: true,
          label: t('المنتج', 'Product'),
        },
      ],
    },
  },
  {
    key: 'home.categories',
    page: 'HOMEPAGE',
    label: t('تصنيفات الرئيسية', 'Homepage Categories'),
    fields: [heading],
    items: {
      min: 1,
      max: 8,
      label: t('تصنيف', 'Category'),
      fields: [
        {
          name: 'label',
          type: 'text',
          required: true,
          label: t('الاسم', 'Label'),
        },
        {
          name: 'image',
          type: 'media',
          media: ['IMAGE'],
          required: true,
          label: t('الصورة', 'Image'),
        },
        {
          name: 'link',
          type: 'link',
          required: true,
          label: t('الرابط', 'Link'),
        },
      ],
    },
  },
  {
    key: 'home.how',
    page: 'HOMEPAGE',
    label: t('كيف تعمل VIA', 'How VIA Works'),
    fields: [heading],
    items: {
      min: 1,
      max: 6,
      label: t('خطوة', 'Step'),
      fields: [
        {
          name: 'title',
          type: 'text',
          required: true,
          label: t('العنوان', 'Title'),
        },
        {
          name: 'text',
          type: 'text',
          required: true,
          label: t('النص', 'Text'),
        },
        {
          name: 'image',
          type: 'media',
          media: ['IMAGE'],
          required: true,
          label: t('الصورة', 'Image'),
        },
      ],
    },
  },
  // -------------------------------------------------------- TRENDING
  {
    key: 'trend.hero',
    page: 'TRENDING',
    label: t('واجهة الرائج', 'Trending Hero'),
    fields: [
      {
        name: 'headline',
        type: 'text',
        required: true,
        label: t('العنوان الرئيسي', 'Headline'),
      },
      // The stage's visuals are its own animated poses (not swappable).
      { name: 'subline', type: 'text', label: t('النص الفرعي', 'Subline') },
    ],
  },
  {
    key: 'trend.look',
    page: 'TRENDING',
    label: t('إطلالة الأسبوع', 'Look of the Week'),
    fields: [
      heading,
      { name: 'subline', type: 'text', label: t('النص', 'Text') },
    ],
    items: {
      min: 1,
      max: 8,
      label: t('قطعة', 'Piece'),
      fields: [
        {
          name: 'title',
          type: 'text',
          required: true,
          label: t('الاسم', 'Name'),
        },
        {
          name: 'image',
          type: 'media',
          media: ['IMAGE'],
          required: true,
          label: t('الصورة', 'Image'),
        },
        {
          name: 'product',
          type: 'ref',
          refType: 'product',
          label: t('المنتج', 'Product'),
        },
      ],
    },
  },
  {
    key: 'trend.reels',
    page: 'TRENDING',
    label: t('ريلز وفيديوهات', 'Reels & Videos'),
    fields: [heading],
    items: {
      min: 1,
      max: 12,
      label: t('فيديو', 'Video'),
      fields: [
        {
          name: 'title',
          type: 'text',
          required: true,
          label: t('العنوان', 'Title'),
        },
        {
          name: 'video',
          type: 'media',
          media: ['VIDEO', 'IMAGE'],
          required: true,
          label: t('الفيديو', 'Video'),
        },
      ],
    },
  },
  {
    key: 'trend.collections',
    page: 'TRENDING',
    label: t('اكتشف المجموعات', 'Discover Collections'),
    fields: [heading],
    items: {
      min: 1,
      max: 12,
      label: t('مجموعة', 'Collection'),
      fields: [
        {
          name: 'title',
          type: 'text',
          required: true,
          label: t('العنوان', 'Title'),
        },
        {
          name: 'image',
          type: 'media',
          media: ['IMAGE'],
          required: true,
          label: t('الصورة', 'Image'),
        },
        {
          name: 'collection',
          type: 'ref',
          refType: 'collection',
          label: t('مجموعة المنصة', 'Platform collection'),
        },
        { name: 'link', type: 'link', label: t('الرابط', 'Link') },
      ],
    },
  },
  // -------------------------------------------------------- ADS (editorial only)
  {
    key: 'ads.hero',
    page: 'ADS',
    label: t('واجهة الإعلانات', 'Ads Hero'),
    fields: [],
    items: {
      min: 1,
      max: 8,
      label: t('شريحة', 'Slide'),
      fields: [
        {
          name: 'title',
          type: 'text',
          required: true,
          label: t('العنوان', 'Title'),
        },
        { name: 'text', type: 'text', label: t('النص', 'Text') },
        {
          name: 'image',
          type: 'media',
          media: ['IMAGE'],
          required: true,
          structural: true,
          label: t('الصورة', 'Image'),
        },
        { name: 'link', type: 'link', label: t('الرابط', 'Link') },
      ],
    },
  },
  {
    key: 'ads.stories',
    page: 'ADS',
    label: t('قصص الإعلانات', 'Ads Stories'),
    fields: [heading],
    items: {
      min: 1,
      max: 16,
      label: t('قصة', 'Story'),
      fields: [
        {
          name: 'title',
          type: 'text',
          required: true,
          label: t('العنوان', 'Title'),
        },
        {
          name: 'image',
          type: 'media',
          media: ['IMAGE', 'VIDEO'],
          required: true,
          label: t('الوسائط', 'Media'),
        },
        {
          name: 'store',
          type: 'ref',
          refType: 'store',
          label: t('المتجر', 'Store'),
        },
      ],
    },
  },
  {
    key: 'ads.reels',
    page: 'ADS',
    label: t('ريلز الإعلانات', 'Ads Reels'),
    fields: [heading],
    items: {
      min: 1,
      max: 12,
      label: t('ريل', 'Reel'),
      fields: [
        {
          name: 'title',
          type: 'text',
          required: true,
          label: t('العنوان', 'Title'),
        },
        {
          name: 'video',
          type: 'media',
          media: ['VIDEO', 'IMAGE'],
          required: true,
          label: t('الفيديو', 'Video'),
        },
        {
          name: 'store',
          type: 'ref',
          refType: 'store',
          label: t('المتجر', 'Store'),
        },
      ],
    },
  },
  {
    key: 'ads.featured',
    page: 'ADS',
    label: t('إعلانات مميزة', 'Featured Advertisements'),
    fields: [heading],
    items: {
      min: 1,
      max: 12,
      label: t('إعلان', 'Advertisement'),
      fields: [
        {
          name: 'title',
          type: 'text',
          required: true,
          label: t('العنوان', 'Title'),
        },
        { name: 'text', type: 'text', label: t('النص', 'Text') },
        {
          name: 'image',
          type: 'media',
          media: ['IMAGE'],
          required: true,
          label: t('الصورة', 'Image'),
        },
        { name: 'link', type: 'link', label: t('الرابط', 'Link') },
        {
          name: 'store',
          type: 'ref',
          refType: 'store',
          label: t('المتجر', 'Store'),
        },
      ],
    },
  },
  {
    key: 'ads.stores',
    page: 'ADS',
    label: t('متاجر مميزة', 'Featured Stores'),
    fields: [heading],
    items: {
      min: 1,
      max: 12,
      label: t('متجر', 'Store'),
      fields: [
        {
          name: 'store',
          type: 'ref',
          refType: 'store',
          required: true,
          label: t('المتجر', 'Store'),
        },
        {
          name: 'image',
          type: 'media',
          media: ['IMAGE'],
          label: t('صورة الغلاف', 'Cover image'),
        },
      ],
    },
  },
];

// ------------------------------------------ WOMEN / MEN / KIDS (editorial only)
// The audience pages share one design: a hero, a ticker of short phrases and
// a delivery-offer strip. Their category grid, collection showcase and the
// product listing stay the live catalogue (merchant data) and are not here.
function audiencePage(
  page: 'WOMEN' | 'MEN' | 'KIDS',
  name: { ar: string; en: string },
): SectionDef[] {
  const p = page.toLowerCase();
  const hero: FieldDef[] = [
    {
      name: 'title',
      type: 'text',
      required: true,
      label: t('عنوان الصفحة (لقارئ الشاشة)', 'Page title (screen readers)'),
    },
  ];
  if (page !== 'WOMEN')
    hero.push(
      {
        name: 'copy_strong',
        type: 'text',
        required: true,
        label: t('السطر العريض', 'Bold line'),
      },
      {
        name: 'copy_span',
        type: 'text',
        label: t('السطر الثاني', 'Second line'),
      },
    );
  hero.push(
    {
      name: 'cta_label',
      type: 'text',
      required: true,
      label: t('نص الزر', 'Button label'),
    },
    { name: 'cta_link', type: 'link', label: t('رابط الزر', 'Button link') },
    {
      name: 'image',
      type: 'media',
      media: ['IMAGE'],
      required: true,
      structural: true,
      decorative: page === 'WOMEN',
      label: t('صورة الواجهة', 'Hero image'),
    },
  );
  if (page === 'WOMEN')
    hero.push(
      {
        name: 'title_art',
        type: 'media',
        media: ['IMAGE'],
        decorative: true,
        label: t('العنوان المرسوم', 'Title artwork'),
      },
      {
        name: 'subject',
        type: 'media',
        media: ['IMAGE'],
        decorative: true,
        label: t('الصورة المقصوصة فوق العنوان', 'Cut-out over the title'),
      },
    );
  const text = (name: string, ar: string, en: string): FieldDef => ({
    name,
    type: 'text',
    required: true,
    label: t(ar, en),
  });
  return [
    {
      key: `${p}.hero`,
      page,
      label: t(`واجهة ${name.ar}`, `${name.en} hero`),
      fields: hero,
    },
    {
      key: `${p}.ticker`,
      page,
      label: t('الشريط المتحرك', 'Ticker'),
      fields: [
        text('label', 'وصف الشريط (لقارئ الشاشة)', 'Ticker label (screen readers)'),
      ],
      items: {
        min: 1,
        max: 6,
        label: t('عبارة', 'Phrase'),
        fields: [text('text', 'النص', 'Text')],
      },
    },
    {
      key: `${p}.offer`,
      page,
      label: t('شريط العرض', 'Offer strip'),
      fields: [
        text('pre', 'قبل المبلغ', 'Before the amount'),
        text('amount', 'المبلغ', 'Amount'),
        text('mid', 'بعد المبلغ', 'After the amount'),
        text('benefit', 'الميزة', 'Benefit'),
        text('link_label', 'نص الرابط', 'Link label'),
        { name: 'link', type: 'link', label: t('الرابط', 'Link') },
      ],
    },
  ];
}
SECTIONS.push(
  ...audiencePage('WOMEN', t('النساء', 'Women')),
  ...audiencePage('MEN', t('الرجال', 'Men')),
  ...audiencePage('KIDS', t('الأطفال', 'Kids')),
);

export const SECTION_BY_KEY = new Map(SECTIONS.map((s) => [s.key, s]));
export const sectionsOf = (page: ContentPageKey) =>
  SECTIONS.filter((s) => s.page === page);
