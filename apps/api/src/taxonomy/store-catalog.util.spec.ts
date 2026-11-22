import {
  CatalogFilters,
  CatalogOffer,
  computeFacets,
  matchesFilters,
} from './store-catalog.util';

const none = (): CatalogFilters => ({
  audiences: new Set(),
  categories: new Set(),
  seasons: new Set(),
  colors: new Set(),
  sizes: new Set(),
  minPrice: null,
  maxPrice: null,
});

function offer(p: Partial<CatalogOffer> & { id: string }): CatalogOffer {
  return {
    createdAt: new Date(),
    classified: true,
    audiences: ['WOMEN'],
    categories: ['JEANS'],
    season: null,
    minPrice: 100,
    combinations: [],
    ...p,
  };
}

const combo = (
  colorCode: string | null,
  sizeCode: string | null,
  available: number,
) => ({
  variantId: `${colorCode}-${sizeCode}`,
  colorCode,
  sizeCode,
  available,
});

const order = {
  audiences: ['WOMEN', 'MEN', 'KIDS'],
  categories: ['JEANS', 'SHIRTS', 'GIRLS_DRESSES', 'TOPS'],
  seasons: ['SUMMER', 'WINTER', 'FALL'],
  colors: ['BLACK', 'BEIGE', 'RED'],
  sizes: ['M', 'L', 'AGE_2_3Y'],
  categoryAudiences: new Map<string, Set<string>>([
    ['JEANS', new Set(['WOMEN', 'MEN', 'KIDS'])],
    ['SHIRTS', new Set(['WOMEN', 'MEN', 'KIDS'])],
    ['GIRLS_DRESSES', new Set(['KIDS'])],
    ['TOPS', new Set(['WOMEN', 'KIDS'])],
  ]),
};

describe('matchesFilters', () => {
  const unisex = offer({ id: 'u', audiences: ['WOMEN', 'MEN'] });

  it('a Unisex offer appears under every audience it was given', () => {
    expect(
      matchesFilters(unisex, { ...none(), audiences: new Set(['WOMEN']) }),
    ).toBe(true);
    expect(
      matchesFilters(unisex, { ...none(), audiences: new Set(['MEN']) }),
    ).toBe(true);
    expect(
      matchesFilters(unisex, { ...none(), audiences: new Set(['KIDS']) }),
    ).toBe(false);
  });

  it('values within one filter are OR, filters are AND', () => {
    const f = {
      ...none(),
      audiences: new Set(['KIDS', 'MEN']),
      categories: new Set(['JEANS']),
    };
    expect(matchesFilters(unisex, f)).toBe(true);
    expect(
      matchesFilters(unisex, { ...f, categories: new Set(['SHIRTS']) }),
    ).toBe(false);
  });

  it('colour and size must be satisfied by ONE in-stock combination', () => {
    const o = offer({
      id: 'o',
      combinations: [combo('BLACK', 'L', 3), combo('BEIGE', 'M', 2)],
    });
    const both = (c: string, s: string) =>
      matchesFilters(o, {
        ...none(),
        colors: new Set([c]),
        sizes: new Set([s]),
      });
    expect(both('BLACK', 'L')).toBe(true);
    expect(both('BLACK', 'M')).toBe(false); // black exists, M exists, black/M does not
  });

  it('a sold-out combination never filters an offer in', () => {
    const o = offer({ id: 'o', combinations: [combo('RED', 'M', 0)] });
    expect(matchesFilters(o, { ...none(), colors: new Set(['RED']) })).toBe(
      false,
    );
  });

  it('unclassified legacy offers are listed without taxonomy filters and excluded with any', () => {
    const legacy = offer({
      id: 'l',
      classified: false,
      audiences: [],
      categories: [],
    });
    expect(matchesFilters(legacy, none())).toBe(true);
    expect(matchesFilters(legacy, { ...none(), minPrice: 50 })).toBe(true);
    expect(
      matchesFilters(legacy, { ...none(), seasons: new Set(['WINTER']) }),
    ).toBe(false);
  });

  it('season filter: an unseasonal (null) offer does not match a season', () => {
    expect(
      matchesFilters(offer({ id: 's', season: null }), {
        ...none(),
        seasons: new Set(['SUMMER']),
      }),
    ).toBe(false);
    expect(
      matchesFilters(offer({ id: 's', season: 'SUMMER' }), {
        ...none(),
        seasons: new Set(['SUMMER']),
      }),
    ).toBe(true);
  });

  it('price range uses the offer price, inclusive', () => {
    const o = offer({ id: 'p', minPrice: 100 });
    expect(matchesFilters(o, { ...none(), minPrice: 100, maxPrice: 100 })).toBe(
      true,
    );
    expect(matchesFilters(o, { ...none(), minPrice: 101 })).toBe(false);
    expect(matchesFilters(o, { ...none(), maxPrice: 99 })).toBe(false);
  });
});

describe('computeFacets', () => {
  const offers = [
    offer({
      id: 'a',
      audiences: ['WOMEN', 'MEN'],
      categories: ['JEANS'],
      season: 'WINTER',
      minPrice: 80,
      combinations: [combo('BLACK', 'M', 5), combo('BEIGE', 'M', 0)],
    }),
    offer({
      id: 'b',
      audiences: ['KIDS', 'WOMEN'],
      categories: ['GIRLS_DRESSES', 'TOPS'],
      minPrice: 40,
      combinations: [combo('RED', 'AGE_2_3Y', 1)],
    }),
    offer({
      id: 'c',
      classified: false,
      audiences: [],
      categories: [],
      minPrice: 500,
    }),
  ];

  it('lists only values with stock, never a sold-out colour', () => {
    const f = computeFacets(offers, none(), order);
    expect(f.colors).toEqual([
      { code: 'BLACK', count: 1 },
      { code: 'RED', count: 1 },
    ]);
    expect(f.colors.find((c) => c.code === 'BEIGE')).toBeUndefined();
    expect(f.audiences).toEqual([
      { code: 'WOMEN', count: 2 },
      { code: 'MEN', count: 1 },
      { code: 'KIDS', count: 1 },
    ]);
    expect(f.price).toEqual({ min: '40.00', max: '500.00' });
  });

  it('a facet ignores its own selection, so other values stay offered', () => {
    const f = computeFacets(
      offers,
      { ...none(), colors: new Set(['BLACK']) },
      order,
    );
    expect(f.colors.map((c) => c.code)).toEqual(['BLACK', 'RED']);
    expect(f.sizes.map((s) => s.code)).toEqual(['M']); // only sizes available in BLACK
  });

  it('under an audience, categories of other audiences are not offered', () => {
    const f = computeFacets(
      offers,
      { ...none(), audiences: new Set(['WOMEN']) },
      order,
    );
    expect(f.categories.map((c) => c.code)).toEqual(['JEANS', 'TOPS']);
  });
});
