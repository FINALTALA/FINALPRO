import {
  WOMEN_CATEGORY_RULES,
  isWomenCategorySlug,
  matchesWomenCategory,
  productSearchText,
} from './women-categories';

const categoriesOf = (
  ar: string,
  en: string,
  category: string | null = null,
) => {
  const text = productSearchText(ar, en, category);
  return WOMEN_CATEGORY_RULES.filter((rule) =>
    matchesWomenCategory(text, rule.slug),
  ).map((rule) => rule.slug);
};

describe('women category matching', () => {
  it('defines 38 unique slugs', () => {
    const slugs = WOMEN_CATEGORY_RULES.map((rule) => rule.slug);
    expect(slugs).toHaveLength(38);
    expect(new Set(slugs).size).toBe(38);
    expect(isWomenCategorySlug('dresses')).toBe(true);
    expect(isWomenCategorySlug('nope')).toBe(false);
  });

  it('folds Arabic letter variants (ة/ه, أ/ا)', () => {
    expect(categoriesOf('تنورة بليسيه', 'Pleated Skirt')).toEqual(['skirts']);
    expect(categoriesOf('أحذية رياضية', '', null)).toContain('shoes');
  });

  it('keeps whole-word Latin terms from matching inside other words', () => {
    expect(categoriesOf('سوار ذهبي', 'Gold bracelet')).toEqual(['jewelry']);
    expect(categoriesOf('صدرية قطنية', 'Cotton bra')).toEqual(['underwear']);
    expect(categoriesOf('فستان', 'Short-sleeve dress')).toEqual(['dresses']);
  });

  it('applies exclusions', () => {
    expect(categoriesOf('قميص نوم حرير', 'Silk nightgown')).toEqual([
      'sleepwear',
    ]);
    expect(categoriesOf('تيشيرت قطني', 'Cotton T-shirt')).toEqual(['t-shirts']);
    expect(categoriesOf('بدلة رياضية', 'Tracksuit')).toEqual(['activewear']);
    expect(categoriesOf('بيجاما قطعتين', 'Two-piece pajama set')).toEqual([
      'sleepwear',
    ]);
  });

  it('matches on the canonical category name too', () => {
    expect(categoriesOf('كنزة ناعمة', 'Soft Jumper', 'كنزات')).toEqual([
      'knitwear',
    ]);
  });
});
