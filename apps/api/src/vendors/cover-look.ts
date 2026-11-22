import { UpdateStorefrontDto } from './dto/update-storefront.dto';

/** The Vendor columns describing the storefront cover's layers. */
export interface CoverLookColumns {
  coverImageEnabled: boolean;
  coverImageOpacity: number;
  coverTintEnabled: boolean;
  coverTintOpacity: number;
  coverGlobalOverlayEnabled: boolean;
  coverGlobalOverlayColor: string;
  coverGlobalOverlayOpacity: number;
  coverGlobalOverlayBrightness: number;
  coverBottomFadeEnabled: boolean;
  coverBottomFadeColor: string;
  coverBottomFadeOpacity: number;
}

/**
 * The cover look as the owner AND public storefront endpoints return it
 * (one mapping, so the two can never drift). cover_image_url and
 * cover_color stay where they always were in each response.
 */
export function coverLookDto(v: CoverLookColumns) {
  return {
    cover_image_enabled: v.coverImageEnabled,
    cover_image_opacity: v.coverImageOpacity,
    cover_tint_enabled: v.coverTintEnabled,
    cover_tint_opacity: v.coverTintOpacity,
    cover_global_overlay_enabled: v.coverGlobalOverlayEnabled,
    cover_global_overlay_color: v.coverGlobalOverlayColor,
    cover_global_overlay_opacity: v.coverGlobalOverlayOpacity,
    cover_global_overlay_brightness: v.coverGlobalOverlayBrightness,
    cover_bottom_fade_enabled: v.coverBottomFadeEnabled,
    cover_bottom_fade_color: v.coverBottomFadeColor,
    cover_bottom_fade_opacity: v.coverBottomFadeOpacity,
  };
}

/** The PUT body's cover-look fields -> Prisma data (undefined = unchanged). */
export function coverLookData(
  dto: UpdateStorefrontDto,
): Partial<CoverLookColumns> {
  return {
    coverImageEnabled: dto.cover_image_enabled,
    coverImageOpacity: dto.cover_image_opacity,
    coverTintEnabled: dto.cover_tint_enabled,
    coverTintOpacity: dto.cover_tint_opacity,
    coverGlobalOverlayEnabled: dto.cover_global_overlay_enabled,
    coverGlobalOverlayColor: dto.cover_global_overlay_color,
    coverGlobalOverlayOpacity: dto.cover_global_overlay_opacity,
    coverGlobalOverlayBrightness: dto.cover_global_overlay_brightness,
    coverBottomFadeEnabled: dto.cover_bottom_fade_enabled,
    coverBottomFadeColor: dto.cover_bottom_fade_color,
    coverBottomFadeOpacity: dto.cover_bottom_fade_opacity,
  };
}
