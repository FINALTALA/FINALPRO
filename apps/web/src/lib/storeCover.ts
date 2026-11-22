// The public store hero's cover: independent layers, bottom to top -
//   1. the cover image,
//   2. the upper (radial) wash of the cover colour,
//   3. a global colour layer over the whole hero,
//   4. the fade/shadow rising from the white product panel.
// Each has its own switch; turning one off keeps its colour and strength
// saved. The defaults are the look every store had before these became
// settings. Pure functions only (unit-tested in
// apps/api/test/web-store-cover.e2e-spec.ts).

export const DEFAULT_COVER_IMAGE_OPACITY = 0.2;
export const DEFAULT_COVER_TINT_OPACITY = 0.3;
/** Pre-selected when an owner first turns the upper layer on. */
export const DEFAULT_COVER_TINT_COLOR = "#D6AFA4";
export const COVER_COLOR_PRESETS = ["#813E51", "#A56A78", "#C99585", "#D6AFA4", "#756B8A", "#607D78"];
/** The global layer's brightness range (1 = the colour as chosen). */
export const MIN_OVERLAY_BRIGHTNESS = 0.5;
export const MAX_OVERLAY_BRIGHTNESS = 1.5;

export interface CoverLook {
  imageUrl: string | null;
  imageEnabled: boolean;
  imageOpacity: number;
  tintEnabled: boolean;
  /** The store's cover_color; null = no upper wash at all. */
  tintColor: string | null;
  tintOpacity: number;
  overlayEnabled: boolean;
  overlayColor: string;
  overlayOpacity: number;
  overlayBrightness: number;
  fadeEnabled: boolean;
  fadeColor: string;
  fadeOpacity: number;
}

export const DEFAULT_COVER_LOOK: CoverLook = {
  imageUrl: null,
  imageEnabled: true,
  imageOpacity: DEFAULT_COVER_IMAGE_OPACITY,
  tintEnabled: true,
  tintColor: null,
  tintOpacity: DEFAULT_COVER_TINT_OPACITY,
  overlayEnabled: false,
  overlayColor: "#D6AFA4",
  overlayOpacity: 0.25,
  overlayBrightness: 1,
  // The product panel's original shadow: rgba(74, 22, 38, .06).
  fadeEnabled: true,
  fadeColor: "#4A1626",
  fadeOpacity: 0.06,
};

/** The storefront endpoints' cover fields (owner and public alike). */
export interface StorefrontCoverDto {
  cover_image_url: string | null;
  cover_color: string | null;
  cover_image_enabled?: boolean;
  cover_image_opacity?: number;
  cover_tint_enabled?: boolean;
  cover_tint_opacity?: number;
  cover_global_overlay_enabled?: boolean;
  cover_global_overlay_color?: string;
  cover_global_overlay_opacity?: number;
  cover_global_overlay_brightness?: number;
  cover_bottom_fade_enabled?: boolean;
  cover_bottom_fade_color?: string;
  cover_bottom_fade_opacity?: number;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isCoverColor(value: string | null | undefined): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** A saved opacity, clamped to 0..1 (anything else -> the default). */
export function coverOpacity(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function brightness(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_OVERLAY_BRIGHTNESS, Math.max(MIN_OVERLAY_BRIGHTNESS, value))
    : 1;
}

const flag = (value: boolean | undefined, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const color = (value: string | undefined, fallback: string) => (isCoverColor(value) ? value : fallback);

/** 0..1 <-> the sliders' whole percentages. */
export const toPercent = (opacity: number) => Math.round(opacity * 100);
export const fromPercent = (percent: number) => Math.min(100, Math.max(0, Math.round(percent))) / 100;

export function coverLookFromDto(dto: StorefrontCoverDto): CoverLook {
  const d = DEFAULT_COVER_LOOK;
  return {
    imageUrl: dto.cover_image_url,
    imageEnabled: flag(dto.cover_image_enabled, d.imageEnabled),
    imageOpacity: coverOpacity(dto.cover_image_opacity, d.imageOpacity),
    tintEnabled: flag(dto.cover_tint_enabled, d.tintEnabled),
    tintColor: isCoverColor(dto.cover_color) ? dto.cover_color : null,
    tintOpacity: coverOpacity(dto.cover_tint_opacity, d.tintOpacity),
    overlayEnabled: flag(dto.cover_global_overlay_enabled, d.overlayEnabled),
    overlayColor: color(dto.cover_global_overlay_color, d.overlayColor),
    overlayOpacity: coverOpacity(dto.cover_global_overlay_opacity, d.overlayOpacity),
    overlayBrightness: brightness(dto.cover_global_overlay_brightness),
    fadeEnabled: flag(dto.cover_bottom_fade_enabled, d.fadeEnabled),
    fadeColor: color(dto.cover_bottom_fade_color, d.fadeColor),
    fadeOpacity: coverOpacity(dto.cover_bottom_fade_opacity, d.fadeOpacity),
  };
}

/** The look's fields for PUT /vendors/:id/storefront (not the image URL,
 * which each screen saves its own way). A missing upper colour is sent
 * as "" - the API's "no colour". */
export function coverLookBody(look: CoverLook) {
  return {
    cover_image_enabled: look.imageEnabled,
    cover_image_opacity: look.imageOpacity,
    cover_tint_enabled: look.tintEnabled,
    cover_color: look.tintColor ?? "",
    cover_tint_opacity: look.tintOpacity,
    cover_global_overlay_enabled: look.overlayEnabled,
    cover_global_overlay_color: look.overlayColor,
    cover_global_overlay_opacity: look.overlayOpacity,
    cover_global_overlay_brightness: look.overlayBrightness,
    cover_bottom_fade_enabled: look.fadeEnabled,
    cover_bottom_fade_color: look.fadeColor,
    cover_bottom_fade_opacity: look.fadeOpacity,
  };
}

/** The first invalid colour of an enabled layer, as an Arabic message. */
export function coverLookProblem(look: CoverLook): string | null {
  if (look.tintEnabled && look.tintColor !== null && !isCoverColor(look.tintColor)) return "لون الطبقة العلوية يجب أن يكون بصيغة مثل #D6AFA4";
  if (!isCoverColor(look.overlayColor)) return "لون الطبقة العامة يجب أن يكون بصيغة مثل #D6AFA4";
  if (!isCoverColor(look.fadeColor)) return "لون تدرج البانيل يجب أن يكون بصيغة مثل #4A1626";
  return null;
}

/** sRGB relative luminance (WCAG) of #rrggbb, after a brightness factor. */
function luminance(hex: string, factor = 1): number {
  const channel = (i: number) => {
    const c = Math.min(255, parseInt(hex.slice(i, i + 2), 16) * factor) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const CREAM_LUMINANCE = luminance("#f8f2ef");

/**
 * The CSS custom properties and classes for the hero, the global layer
 * and the product panel. A layer is not rendered at all when it is
 * switched off or would be invisible (opacity 0, no image, no colour).
 * `lightText`: a strong, dark global layer would make the hero's dark
 * text hard to read, so the hero switches to light text.
 */
export function coverPresentation(look: CoverLook, isSafeUrl: (url: string) => boolean) {
  const heroVars: Record<string, string> = {};
  const heroClasses: string[] = [];
  const panelVars: Record<string, string> = {};
  const panelClasses: string[] = [];

  if (look.imageEnabled && look.imageUrl && isSafeUrl(look.imageUrl) && look.imageOpacity > 0) {
    heroVars["--store-cover-image"] = `url(${JSON.stringify(look.imageUrl)})`;
    heroVars["--store-cover-image-opacity"] = String(look.imageOpacity);
    heroClasses.push("has-cover-image");
  }
  if (look.tintEnabled && isCoverColor(look.tintColor) && look.tintOpacity > 0) {
    heroVars["--store-cover-tint"] = look.tintColor;
    heroVars["--store-cover-tint-strength"] = `${toPercent(look.tintOpacity)}%`;
    heroClasses.push("has-cover-tint");
  }
  const overlay = look.overlayEnabled && isCoverColor(look.overlayColor) && look.overlayOpacity > 0;
  let lightText = false;
  if (overlay) {
    heroVars["--store-cover-overlay-color"] = look.overlayColor;
    heroVars["--store-cover-overlay-opacity"] = String(look.overlayOpacity);
    heroVars["--store-cover-overlay-brightness"] = String(brightness(look.overlayBrightness));
    heroClasses.push("has-cover-overlay");
    const behindText =
      CREAM_LUMINANCE * (1 - look.overlayOpacity) +
      luminance(look.overlayColor, brightness(look.overlayBrightness)) * look.overlayOpacity;
    lightText = behindText < 0.3;
    if (lightText) heroClasses.push("has-light-cover-text");
  }
  if (look.fadeEnabled && isCoverColor(look.fadeColor) && look.fadeOpacity > 0) {
    panelVars["--store-bottom-fade-color"] = look.fadeColor;
    panelVars["--store-bottom-fade-strength"] = `${toPercent(look.fadeOpacity)}%`;
    panelClasses.push("has-bottom-fade");
  } else {
    panelClasses.push("no-bottom-fade");
  }
  return { heroVars, heroClasses, overlay, lightText, panelVars, panelClasses };
}
