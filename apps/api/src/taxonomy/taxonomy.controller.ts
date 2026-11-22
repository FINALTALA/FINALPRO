import { Controller, Get } from '@nestjs/common';
import {
  AUDIENCES,
  SEASONS,
  TAXONOMY_VERSION,
  TaxonomyService,
} from './taxonomy.service';
import { isSizeGuideCategory } from '../size-guides/size-guide-rules';

// Sprint 27: the fixed product taxonomy, public and unauthenticated - the
// single source every screen (owner forms, customer filters) reads, so
// no list is ever duplicated in the frontend.
@Controller('taxonomy')
export class TaxonomyController {
  constructor(private readonly taxonomy: TaxonomyService) {}

  @Get()
  async get() {
    const t = await this.taxonomy.get();
    return {
      version: TAXONOMY_VERSION,
      audiences: AUDIENCES.map((a, n) => ({
        code: a.code,
        name_ar: a.nameAr,
        name_en: a.nameEn,
        sort_order: n + 1,
      })),
      seasons: SEASONS.map((s, n) => ({
        code: s.code,
        name_ar: s.nameAr,
        name_en: s.nameEn,
        sort_order: n + 1,
      })),
      categories: t.categories.map((c) => ({
        code: c.code,
        name_ar: c.nameAr,
        name_en: c.nameEn,
        sort_order: c.sortOrder,
        audiences: c.audiences,
        // PD-4: whether a size guide can describe this category (false
        // for accessories) - the size-guide editor reads it from here.
        size_guide: isSizeGuideCategory(c.code),
      })),
      colors: t.colors.map((c) => ({
        code: c.code,
        name_ar: c.nameAr,
        name_en: c.nameEn,
        hex: c.hex,
        sort_order: c.sortOrder,
      })),
      sizes: t.sizes.map((s) => ({
        code: s.code,
        label: s.label,
        group: s.group,
        sort_order: s.sortOrder,
      })),
    };
  }
}
