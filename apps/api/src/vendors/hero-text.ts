import { BadRequestException } from '@nestjs/common';
import type { UpdateStorefrontDto } from './dto/update-storefront.dto';

/**
 * The fonts a hero text may use: only Arabic-supporting faces the web app
 * already ships (apps/web/public/fonts, @font-face in globals.css) -
 * never a URL or an uploaded file. Amiri ships its bold face only.
 */
export const HERO_FONTS = {
  NOTO_SANS: [400, 500, 600, 700],
  AMIRI: [700],
  REEM_KUFI: [400, 500, 600, 700],
  BALOO_BHAIJAAN: [400, 500, 600, 700],
} as const;
export type HeroFont = keyof typeof HERO_FONTS;
export const HERO_FONT_IDS = Object.keys(HERO_FONTS) as HeroFont[];
export const HERO_WEIGHTS = [400, 500, 600, 700] as const;

/** The Vendor columns of the hero title's and description's styling. */
export interface HeroTextColumns {
  heroTitleColor: string | null;
  heroTitleFont: string | null;
  heroTitleWeight: number | null;
  heroTitleShadowEnabled: boolean;
  heroTitleShadowStrength: number;
  bioColor: string | null;
  bioFont: string | null;
  bioWeight: number | null;
  bioShadowEnabled: boolean;
  bioShadowStrength: number;
}

/**
 * The styling as the owner AND public storefront endpoints return it
 * (one mapping, so the two never drift). null = the stylesheet default.
 */
export function heroTextDto(v: HeroTextColumns) {
  return {
    hero_title_color: v.heroTitleColor,
    hero_title_font: v.heroTitleFont,
    hero_title_weight: v.heroTitleWeight,
    hero_title_shadow_enabled: v.heroTitleShadowEnabled,
    hero_title_shadow_strength: v.heroTitleShadowStrength,
    bio_color: v.bioColor,
    bio_font: v.bioFont,
    bio_weight: v.bioWeight,
    bio_shadow_enabled: v.bioShadowEnabled,
    bio_shadow_strength: v.bioShadowStrength,
  };
}

/** "" and null both restore the default; undefined = unchanged. */
function resettable<T>(value: T | '' | null | undefined): T | null | undefined {
  if (value === undefined) return undefined;
  return value === '' || value === null ? null : value;
}

/** The PUT body's hero-text fields -> Prisma data (undefined = unchanged). */
export function heroTextData(
  dto: UpdateStorefrontDto,
): Partial<HeroTextColumns> {
  return {
    heroTitleColor: resettable(dto.hero_title_color),
    heroTitleFont: resettable(dto.hero_title_font),
    heroTitleWeight: resettable(dto.hero_title_weight),
    heroTitleShadowEnabled: dto.hero_title_shadow_enabled,
    heroTitleShadowStrength: dto.hero_title_shadow_strength,
    bioColor: resettable(dto.bio_color),
    bioFont: resettable(dto.bio_font),
    bioWeight: resettable(dto.bio_weight),
    bioShadowEnabled: dto.bio_shadow_enabled,
    bioShadowStrength: dto.bio_shadow_strength,
  };
}

/**
 * A weight the chosen font actually ships (Amiri: bold only), checked on
 * the result of the update - a new font against the stored weight too.
 */
export function assertHeroFontWeights(
  current: HeroTextColumns,
  data: Partial<HeroTextColumns>,
) {
  for (const [field, font, weight] of [
    [
      'hero_title',
      data.heroTitleFont === undefined
        ? current.heroTitleFont
        : data.heroTitleFont,
      data.heroTitleWeight === undefined
        ? current.heroTitleWeight
        : data.heroTitleWeight,
    ],
    [
      'bio',
      data.bioFont === undefined ? current.bioFont : data.bioFont,
      data.bioWeight === undefined ? current.bioWeight : data.bioWeight,
    ],
  ] as const) {
    if (!font || weight === null) continue;
    const weights: readonly number[] = HERO_FONTS[font as HeroFont];
    if (!weights.includes(weight)) {
      throw new BadRequestException({
        code: 'FONT_WEIGHT_UNAVAILABLE',
        message: `${field}_weight ${weight} is not available in ${font} (${weights.join(', ')})`,
      });
    }
  }
}
