import { BadRequestException, Injectable } from '@nestjs/common';
import { ProductAudience, SizeGroup } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Sprint 27 (product taxonomy). The reference rows are seeded by the
// sprint27_product_taxonomy migration and only ever change through a new
// migration, so one read per process is enough - every rule below is
// checked against this snapshot, never against client-sent labels.

export const TAXONOMY_VERSION = 1;

export const AUDIENCES: {
  code: ProductAudience;
  nameAr: string;
  nameEn: string;
}[] = [
  { code: 'WOMEN', nameAr: 'نساء', nameEn: 'Women' },
  { code: 'MEN', nameAr: 'رجال', nameEn: 'Men' },
  { code: 'KIDS', nameAr: 'أطفال', nameEn: 'Kids' },
];

// SPRING added by the product_taxonomy_spring_gray migration.
export const SEASONS = [
  { code: 'SUMMER', nameAr: 'الصيف', nameEn: 'Summer' },
  { code: 'WINTER', nameAr: 'الشتاء', nameEn: 'Winter' },
  { code: 'FALL', nameAr: 'الخريف', nameEn: 'Fall' },
  { code: 'SPRING', nameAr: 'الربيع', nameEn: 'Spring' },
] as const;

export interface TaxonomySnapshot {
  categories: {
    code: string;
    nameAr: string;
    nameEn: string;
    sortOrder: number;
    audiences: ProductAudience[];
  }[];
  colors: {
    code: string;
    nameAr: string;
    nameEn: string;
    hex: string | null;
    sortOrder: number;
  }[];
  sizes: { code: string; label: string; group: SizeGroup; sortOrder: number }[];
  categoryAudiences: Map<string, Set<ProductAudience>>;
  colorByCode: Map<string, { nameAr: string }>;
  sizeByCode: Map<string, { label: string; group: SizeGroup }>;
}

function bad(
  code: string,
  message: string,
  details: unknown[] = [],
): BadRequestException {
  return new BadRequestException({ code, message, details });
}

@Injectable()
export class TaxonomyService {
  private snapshot: Promise<TaxonomySnapshot> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  get(): Promise<TaxonomySnapshot> {
    if (!this.snapshot) {
      this.snapshot = this.load().catch((err) => {
        this.snapshot = null; // never cache a failed read
        throw err;
      });
    }
    return this.snapshot;
  }

  private async load(): Promise<TaxonomySnapshot> {
    const [categories, colors, sizes] = await Promise.all([
      this.prisma.taxonomyCategory.findMany({
        orderBy: { sortOrder: 'asc' },
        include: { audiences: { select: { audience: true } } },
      }),
      this.prisma.taxonomyColor.findMany({ orderBy: { sortOrder: 'asc' } }),
      this.prisma.taxonomySize.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);
    const audienceOrder = AUDIENCES.map((a) => a.code);
    const mapped = categories.map((c) => ({
      code: c.code,
      nameAr: c.nameAr,
      nameEn: c.nameEn,
      sortOrder: c.sortOrder,
      audiences: c.audiences
        .map((a) => a.audience)
        .sort((x, y) => audienceOrder.indexOf(x) - audienceOrder.indexOf(y)),
    }));
    return {
      categories: mapped,
      colors,
      sizes,
      categoryAudiences: new Map(
        mapped.map((c) => [c.code, new Set(c.audiences)]),
      ),
      colorByCode: new Map(colors.map((c) => [c.code, { nameAr: c.nameAr }])),
      sizeByCode: new Map(
        sizes.map((s) => [s.code, { label: s.label, group: s.group }]),
      ),
    };
  }

  /**
   * Audiences >= 1 and categories >= 1, every category belonging to at
   * least one chosen audience (a Unisex offer may use the union of its
   * audiences' categories). Duplicates are removed, order is kept.
   */
  async validateClassification(input: {
    audiences: ProductAudience[];
    categories: string[];
  }): Promise<{ audiences: ProductAudience[]; categories: string[] }> {
    const t = await this.get();
    const audiences = [...new Set(input.audiences)];
    const categories = [...new Set(input.categories)];
    if (audiences.length === 0) {
      throw bad(
        'AUDIENCE_REQUIRED',
        'Choose at least one of WOMEN, MEN or KIDS',
      );
    }
    if (categories.length === 0) {
      throw bad('CATEGORY_REQUIRED', 'Choose at least one category');
    }
    const unknown = categories.filter((c) => !t.categoryAudiences.has(c));
    if (unknown.length > 0) {
      throw bad(
        'UNKNOWN_CATEGORY',
        `Unknown category code(s): ${unknown.join(', ')}`,
        unknown,
      );
    }
    const chosen = new Set(audiences);
    const outside = categories.filter(
      (c) =>
        ![...(t.categoryAudiences.get(c) ?? [])].some((a) => chosen.has(a)),
    );
    if (outside.length > 0) {
      throw bad(
        'CATEGORY_NOT_IN_AUDIENCE',
        `Category ${outside.join(', ')} does not belong to the chosen audience(s) ${audiences.join(', ')}`,
        outside,
      );
    }
    return { audiences, categories };
  }

  /** One colour/size combination's codes against the offer's audiences. */
  async validateCombination(
    audiences: ProductAudience[],
    colorCode: string | null,
    sizeCode: string | null,
  ): Promise<void> {
    const t = await this.get();
    if (colorCode !== null && !t.colorByCode.has(colorCode)) {
      throw bad('UNKNOWN_COLOR', `Unknown colour code: ${colorCode}`, [
        colorCode,
      ]);
    }
    if (sizeCode !== null) {
      const size = t.sizeByCode.get(sizeCode);
      if (!size)
        throw bad('UNKNOWN_SIZE', `Unknown size code: ${sizeCode}`, [sizeCode]);
      if (size.group === 'KIDS_AGE' && !audiences.includes('KIDS')) {
        throw bad(
          'AGE_SIZE_REQUIRES_KIDS',
          `Age size ${sizeCode} is only allowed on a product whose audiences include KIDS`,
          [sizeCode],
        );
      }
    }
  }

  async isKidsAgeSize(sizeCode: string | null): Promise<boolean> {
    if (sizeCode === null) return false;
    return (await this.get()).sizeByCode.get(sizeCode)?.group === 'KIDS_AGE';
  }

  /**
   * The public browsing filters (?audience=&category=&season=&color=
   * &size=, each a comma list) - shared by the store page and
   * /discovery/all so an unknown code is refused the same way on both.
   */
  async parseFilterCodes(
    q: Record<string, string | undefined>,
  ): Promise<TaxonomyFilterCodes> {
    const t = await this.get();
    const check = (
      raw: string | undefined,
      known: Iterable<string>,
      code: string,
      what: string,
    ) => {
      const values = (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const knownSet = new Set(known);
      const unknown = values.filter((v) => !knownSet.has(v));
      if (unknown.length) {
        throw bad(code, `Unknown ${what}: ${unknown.join(', ')}`, unknown);
      }
      return new Set(values);
    };
    return {
      audiences: check(
        q.audience,
        AUDIENCES.map((a) => a.code),
        'UNKNOWN_AUDIENCE',
        'audience',
      ),
      categories: check(
        q.category,
        t.categoryAudiences.keys(),
        'UNKNOWN_CATEGORY',
        'category',
      ),
      seasons: check(
        q.season,
        SEASONS.map((s) => s.code),
        'UNKNOWN_SEASON',
        'season',
      ),
      colors: check(q.color, t.colorByCode.keys(), 'UNKNOWN_COLOR', 'colour'),
      sizes: check(q.size, t.sizeByCode.keys(), 'UNKNOWN_SIZE', 'size'),
    };
  }
}

export interface TaxonomyFilterCodes {
  audiences: Set<string>;
  categories: Set<string>;
  seasons: Set<string>;
  colors: Set<string>;
  sizes: Set<string>;
}
