import { applyDecorators } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsUrlOrOwnUpload } from '../../uploads/uploads.util';
import { HERO_FONT_IDS, HERO_WEIGHTS, type HeroFont } from '../hero-text';

// Sprint 26: an empty string is the owner's explicit "remove this"
// (e.g. no WhatsApp any more) - it skips the URL/colour check and the
// controller stores it as null. Anything non-empty is validated as
// before.
const unlessCleared = ValidateIf((_o: unknown, v: unknown) => v !== '');
// Validate only when the field was sent at all (unlike IsOptional, which
// also skips null).
const sentOnly = ValidateIf((_o: unknown, v: unknown) => v !== undefined);

/** A number in [min, max] - absent = unchanged, null refused. */
function RangeField(name: string, min: number, max: number) {
  const message = `${name} must be a number between ${min} and ${max}`;
  return applyDecorators(
    sentOnly,
    IsNumber({ allowNaN: false, allowInfinity: false }, { message }),
    Min(min, { message }),
    Max(max, { message }),
  );
}

/** A required #rrggbb colour (these columns always hold one). */
function HexColorField(name: string) {
  return applyDecorators(
    sentOnly,
    Matches(/^#[0-9a-fA-F]{6}$/, {
      message: `${name} must be a hex colour like #4a1626`,
    }),
  );
}

/** An optional #rrggbb colour (null / "" = the default). */
function HeroColorField(name: string) {
  return applyDecorators(
    IsOptional(),
    unlessCleared,
    Matches(/^#[0-9a-fA-F]{6}$/, {
      message: `${name} must be a hex colour like #4a1626`,
    }),
  );
}

/** One of the predefined hero fonts (null / "" = the default). */
function HeroFontField(name: string) {
  return applyDecorators(
    IsOptional(),
    unlessCleared,
    IsIn(HERO_FONT_IDS, {
      message: `${name} must be one of ${HERO_FONT_IDS.join(', ')}`,
    }),
  );
}

/** 400/500/600/700 (null / "" = the default). */
function HeroWeightField(name: string) {
  return applyDecorators(
    IsOptional(),
    unlessCleared,
    IsIn([...HERO_WEIGHTS], {
      message: `${name} must be one of ${HERO_WEIGHTS.join(', ')}`,
    }),
  );
}

/** A layer on/off switch. */
function FlagField(name: string) {
  return applyDecorators(
    sentOnly,
    IsBoolean({ message: `${name} must be true or false` }),
  );
}

// Sprint 7 (RB-STOREF-001, PDR-011): partial update - every field
// optional, only the ones sent are changed. slug is never here (stable,
// immutable, set once at vendor creation - see slug.util.ts).
export class UpdateStorefrontDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  display_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  hero_title?: string;

  // Sprint 26: a public URL, or one returned by POST /vendors/:id/uploads.
  @IsOptional()
  @unlessCleared
  @IsUrlOrOwnUpload('logo_url must be a valid URL')
  logo_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @unlessCleared
  @IsUrlOrOwnUpload('cover_image_url must be a valid URL')
  cover_image_url?: string;

  // Sprint 26: rendered on the public store page, so only a plain
  // #rrggbb hex colour is accepted.
  @IsOptional()
  @unlessCleared
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'cover_color must be a hex colour like #4a1626',
  })
  cover_color?: string;

  // How visible the cover image is (0 = hidden, 1 = fully shown) and how
  // strong the cover_color wash over it is. Default 0.2 / 0.3. Absent =
  // unchanged; null is NOT "absent" here (the columns are required), so it
  // is validated - and refused - like any other non-number.
  @sentOnly
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'cover_image_opacity must be a number between 0 and 1' },
  )
  @Min(0, { message: 'cover_image_opacity must be between 0 and 1' })
  @Max(1, { message: 'cover_image_opacity must be between 0 and 1' })
  cover_image_opacity?: number;

  @sentOnly
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'cover_tint_opacity must be a number between 0 and 1' },
  )
  @Min(0, { message: 'cover_tint_opacity must be between 0 and 1' })
  @Max(1, { message: 'cover_tint_opacity must be between 0 and 1' })
  cover_tint_opacity?: number;

  // Independent cover layers (see the Vendor model): each one's switch,
  // colour and strength. Switching a layer off keeps its values.
  @FlagField('cover_image_enabled')
  cover_image_enabled?: boolean;

  @FlagField('cover_tint_enabled')
  cover_tint_enabled?: boolean;

  @FlagField('cover_global_overlay_enabled')
  cover_global_overlay_enabled?: boolean;

  @HexColorField('cover_global_overlay_color')
  cover_global_overlay_color?: string;

  @RangeField('cover_global_overlay_opacity', 0, 1)
  cover_global_overlay_opacity?: number;

  /** 0.5-1.5: the global colour's brightness (1 = as chosen). */
  @RangeField('cover_global_overlay_brightness', 0.5, 1.5)
  cover_global_overlay_brightness?: number;

  @FlagField('cover_bottom_fade_enabled')
  cover_bottom_fade_enabled?: boolean;

  @HexColorField('cover_bottom_fade_color')
  cover_bottom_fade_color?: string;

  @RangeField('cover_bottom_fade_opacity', 0, 1)
  cover_bottom_fade_opacity?: number;

  // The product panel's appearance: a PARTIAL nested object (only the
  // settings that change; null on a section/group/state restores it).
  // Its full shape is checked by validateAppearancePatch() in the
  // controller - class-validator only sees that it is an object.
  @sentOnly
  @IsObject({ message: 'storefront_appearance must be an object' })
  storefront_appearance?: Record<string, unknown>;

  // The hero title's and description's own text styling (independent of
  // each other). null or "" restores the stylesheet default.
  @HeroColorField('hero_title_color')
  hero_title_color?: string | null;

  @HeroFontField('hero_title_font')
  hero_title_font?: HeroFont | null;

  @HeroWeightField('hero_title_weight')
  hero_title_weight?: number | null;

  @FlagField('hero_title_shadow_enabled')
  hero_title_shadow_enabled?: boolean;

  @RangeField('hero_title_shadow_strength', 0.1, 1)
  hero_title_shadow_strength?: number;

  @HeroColorField('bio_color')
  bio_color?: string | null;

  @HeroFontField('bio_font')
  bio_font?: HeroFont | null;

  @HeroWeightField('bio_weight')
  bio_weight?: number | null;

  @FlagField('bio_shadow_enabled')
  bio_shadow_enabled?: boolean;

  @RangeField('bio_shadow_strength', 0.1, 1)
  bio_shadow_strength?: number;

  @IsOptional()
  @unlessCleared
  @IsUrl(undefined, { message: 'instagram_url must be a valid URL' })
  instagram_url?: string;

  @IsOptional()
  @unlessCleared
  @IsUrl(undefined, { message: 'facebook_url must be a valid URL' })
  facebook_url?: string;

  @IsOptional()
  @unlessCleared
  @IsUrl(undefined, { message: 'whatsapp_url must be a valid URL' })
  whatsapp_url?: string;
}
