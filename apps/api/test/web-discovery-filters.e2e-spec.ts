import { readFileSync } from 'fs';
import * as path from 'path';
import {
  EMPTY_FILTERS,
  activeDrawerFilterCount,
  categoryCodeForSlug,
  clearDrawerFilters,
  filtersKey,
  filtersToApiParams,
  filtersToSearch,
  hasAnyFilter,
  parseFilters,
  sizeGroupFor,
  type DiscoveryFilters,
} from '../../web/src/lib/discoveryFilters';
import { KIDS_CATEGORIES } from '../../web/src/lib/kidsCategories';
import { MEN_CATEGORIES } from '../../web/src/lib/menCategories';
import { WOMEN_CATEGORIES } from '../../web/src/lib/womenCategories';

// The /women, /men and /kids listing filters: page URL <-> filters <->
// GET /discovery/all browse parameters (apps/web/src/lib/discoveryFilters.ts).
describe('Web - listing filters to query params', () => {
  const full: DiscoveryFilters = {
    category: 'JEANS',
    colors: ['BLACK', 'GRAY'],
    sizes: ['M', 'XXL'],
    seasons: ['SPRING'],
    minPrice: 50,
    maxPrice: 300,
    availableOnly: true,
    sort: 'price-asc',
    tab: 'discounts',
  };

  it('no filters -> a clean URL and a plain browse request for the audience', () => {
    expect(filtersToSearch(EMPTY_FILTERS)).toBe('');
    expect(
      Object.fromEntries(
        filtersToApiParams('WOMEN', EMPTY_FILTERS, { pageSize: 20 }),
      ),
    ).toEqual({ audience: 'WOMEN', sort: 'newest', page_size: '20' });
    expect(hasAnyFilter(EMPTY_FILTERS)).toBe(false);
    expect(activeDrawerFilterCount(EMPTY_FILTERS)).toBe(0);
  });

  it('every filter maps to the API parameter the backend reads', () => {
    const params = filtersToApiParams('MEN', full, {
      pageSize: 20,
      cursor: 'abc',
      withFacets: true,
    });
    expect(Object.fromEntries(params)).toEqual({
      audience: 'MEN',
      sort: 'price-asc',
      page_size: '20',
      category: 'JEANS',
      color: 'BLACK,GRAY',
      size: 'M,XXL',
      season: 'SPRING',
      min_price: '50',
      max_price: '300',
      available_only: 'true',
      filter: 'discounts',
      cursor: 'abc',
      facets: 'categories',
    });
  });

  it('the page URL round-trips every filter (refresh / back / shared link)', () => {
    const search = filtersToSearch(full);
    expect(search).toBe(
      '?category=JEANS&color=BLACK%2CGRAY&size=M%2CXXL&season=SPRING&min_price=50&max_price=300&available=1&sort=price-asc&tab=discounts',
    );
    expect(parseFilters(search)).toEqual(full);
    expect(parseFilters(new URLSearchParams(search.slice(1)))).toEqual(full);
    expect(activeDrawerFilterCount(full)).toBe(7);
  });

  it('sort alone is not "filtered"; equal filters give the same key', () => {
    expect(hasAnyFilter({ ...EMPTY_FILTERS, sort: 'price-desc' })).toBe(false);
    expect(hasAnyFilter({ ...EMPTY_FILTERS, availableOnly: true })).toBe(true);
    expect(filtersKey('KIDS', full)).toBe(
      filtersKey('KIDS', parseFilters(filtersToSearch(full))),
    );
    expect(filtersKey('KIDS', full)).not.toBe(filtersKey('WOMEN', full));
  });

  it('a hand-edited URL is cleaned: unknown sort/tab, bad codes, bad and swapped prices', () => {
    expect(
      parseFilters(
        '?sort=cheapest&tab=hot&color=black,BLACK,<x>,BLACK&min_price=-5&max_price=abc&available=yes',
      ),
    ).toEqual({ ...EMPTY_FILTERS, colors: ['BLACK'] });
    expect(parseFilters('?min_price=400&max_price=100')).toMatchObject({
      minPrice: 100,
      maxPrice: 400,
    });
    expect(parseFilters('?category=JEANS,SHIRTS').category).toBe('JEANS');
  });

  it('the circle category scopes every other filter: it is sent together with them (AND), never replaced', () => {
    const jewellery: DiscoveryFilters = {
      ...EMPTY_FILTERS,
      category: 'JEWELLERY',
    };
    // The drawer applies its fields on top of the active category.
    const yellow = { ...jewellery, colors: ['YELLOW'], seasons: ['SUMMER'] };
    const params = filtersToApiParams('WOMEN', yellow, { pageSize: 20 });
    expect(params.get('category')).toBe('JEWELLERY');
    expect(params.get('color')).toBe('YELLOW');
    expect(params.get('season')).toBe('SUMMER');
    expect(filtersToSearch(yellow)).toBe(
      '?category=JEWELLERY&color=YELLOW&season=SUMMER',
    );
    // Switching category keeps the other filters; un-selecting it too.
    expect(filtersToSearch({ ...yellow, category: 'JEANS' })).toBe(
      '?category=JEANS&color=YELLOW&season=SUMMER',
    );
    expect(filtersToSearch({ ...yellow, category: '' })).toBe(
      '?color=YELLOW&season=SUMMER',
    );
  });

  it('"مسح الكل" clears the drawer filters but keeps the category (and the tab)', () => {
    expect(clearDrawerFilters(full)).toEqual({
      ...EMPTY_FILTERS,
      category: 'JEANS',
      tab: 'discounts',
    });
    expect(filtersToSearch(clearDrawerFilters(full))).toBe(
      '?category=JEANS&tab=discounts',
    );
    expect(clearDrawerFilters({ ...full, category: '' }).category).toBe('');
  });

  it('kids get age sizes, women and men adult sizes', () => {
    expect(sizeGroupFor('KIDS')).toBe('KIDS_AGE');
    expect(sizeGroupFor('WOMEN')).toBe('ADULT');
    expect(sizeGroupFor('MEN')).toBe('ADULT');
  });

  it("every category image of each page maps to a real taxonomy category of that page's audience", () => {
    const sql = readFileSync(
      path.join(
        __dirname,
        '../prisma/migrations/20261021120000_sprint27_product_taxonomy/migration.sql',
      ),
      'utf8',
    );
    const links = sql.slice(
      sql.indexOf('INSERT INTO "taxonomy_category_audiences"'),
    );
    const linked = new Set(
      [...links.matchAll(/\('([A-Z_]+)', '(WOMEN|MEN|KIDS)'\)/g)].map(
        (m) => `${m[1]}:${m[2]}`,
      ),
    );
    for (const [audience, list] of [
      ['WOMEN', WOMEN_CATEGORIES],
      ['MEN', MEN_CATEGORIES],
      ['KIDS', KIDS_CATEGORIES],
    ] as const) {
      const missing = list
        .map((item) => categoryCodeForSlug(item.slug))
        .filter((code) => !linked.has(`${code}:${audience}`));
      expect({ audience, missing }).toEqual({ audience, missing: [] });
    }
  });
});
