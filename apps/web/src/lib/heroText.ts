import type { CSSProperties } from "react";

// The hero title's and the hero description's own text styling (their
// pencils on the public store page). The two are fully independent; a
// null colour / font / weight renders the stylesheet's default, so an
// untouched store looks exactly as before. Pure functions only
// (unit-tested in apps/api/test/web-store-hero-text.e2e-spec.ts).

export type HeroTextField = "hero_title" | "bio";

/** Only Arabic-supporting faces the app already ships (@font-face in
 * globals.css) - the API accepts exactly these identifiers. */
export const HERO_FONTS = [
  { id: "NOTO_SANS", label: "نوتو سانس", family: "'Finalpro Noto', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif", weights: [400, 500, 600, 700] },
  { id: "AMIRI", label: "أميري", family: "'Finalpro Amiri', 'Finalpro Noto', Georgia, serif", weights: [700] },
  { id: "REEM_KUFI", label: "ريم كوفي", family: "'Via Reem Kufi', 'Finalpro Noto', sans-serif", weights: [400, 500, 600, 700] },
  { id: "BALOO_BHAIJAAN", label: "بالو بهيجان", family: "'Via Baloo Bhaijaan', 'Finalpro Noto', sans-serif", weights: [400, 500, 600, 700] },
] as const;
export type HeroFont = (typeof HERO_FONTS)[number]["id"];

export const HERO_WEIGHTS = [
  { value: 400, label: "عادي" },
  { value: 500, label: "متوسط" },
  { value: 600, label: "شبه عريض" },
  { value: 700, label: "عريض" },
] as const;

export const HERO_TEXT_PRESETS = ["#1C1416", "#4A1626", "#813E51", "#B5832F", "#6B5F5A", "#FFFAF6"];
/** What the colour picker shows while the stylesheet default is used. */
export const HERO_TEXT_FALLBACK: Record<HeroTextField, string> = { hero_title: "#1C1416", bio: "#6B5F5A" };
export const DEFAULT_SHADOW_STRENGTH = 0.5;

export interface HeroTextStyle {
  color: string | null;
  font: HeroFont | null;
  weight: number | null;
  shadowEnabled: boolean;
  /** 0.1-1, kept while the shadow is off. */
  shadowStrength: number;
}

export type HeroTextLook = Record<HeroTextField, HeroTextStyle>;

export const DEFAULT_HERO_TEXT_STYLE: HeroTextStyle = {
  color: null,
  font: null,
  weight: null,
  shadowEnabled: false,
  shadowStrength: DEFAULT_SHADOW_STRENGTH,
};

/** The storefront response's `hero_title_*` / `bio_*` fields. */
export type HeroTextDto = Partial<Record<
  `${HeroTextField}_${"color" | "font" | "weight" | "shadow_enabled" | "shadow_strength"}`,
  string | number | boolean | null
>>;

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHeroColor = (value: string) => HEX.test(value);

function styleFromDto(dto: HeroTextDto, field: HeroTextField): HeroTextStyle {
  const color = dto[`${field}_color`];
  const font = dto[`${field}_font`];
  const weight = dto[`${field}_weight`];
  const strength = dto[`${field}_shadow_strength`];
  return {
    color: typeof color === "string" && isHeroColor(color) ? color : null,
    font: HERO_FONTS.some((f) => f.id === font) ? (font as HeroFont) : null,
    weight: typeof weight === "number" && HERO_WEIGHTS.some((w) => w.value === weight) ? weight : null,
    shadowEnabled: dto[`${field}_shadow_enabled`] === true,
    shadowStrength: typeof strength === "number" ? strength : DEFAULT_SHADOW_STRENGTH,
  };
}

export function heroTextFromDto(dto: HeroTextDto): HeroTextLook {
  return { hero_title: styleFromDto(dto, "hero_title"), bio: styleFromDto(dto, "bio") };
}

/** The weights the chosen font ships (all four for the default font). */
export function weightsFor(font: HeroFont | null): readonly number[] {
  return HERO_FONTS.find((f) => f.id === font)?.weights ?? [400, 500, 600, 700];
}

/** A new font keeps the weight only if that font ships it. */
export function withFont(style: HeroTextStyle, font: HeroFont | null): HeroTextStyle {
  const weight = style.weight !== null && weightsFor(font).includes(style.weight) ? style.weight : null;
  return { ...style, font, weight };
}

/** Why the draft cannot be saved (null = fine). */
export function heroTextProblem(style: HeroTextStyle): string | null {
  if (style.color !== null && !isHeroColor(style.color)) return "لون النص غير صالح - استخدمي صيغة مثل #4A1626";
  return null;
}

/** The PUT body for one text: only its own `${field}_*` keys. */
export function heroTextBody(field: HeroTextField, style: HeroTextStyle) {
  return {
    [`${field}_color`]: style.color,
    [`${field}_font`]: style.font,
    [`${field}_weight`]: style.weight,
    [`${field}_shadow_enabled`]: style.shadowEnabled,
    [`${field}_shadow_strength`]: style.shadowStrength,
  };
}

function isDark(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140;
}

/**
 * Inline styles for the text - empty for an untouched style, so the
 * stylesheet keeps rendering it. The shadow is a dark glow behind light
 * text and a light halo behind dark text (`lightByDefault`: the default
 * colour is light, i.e. the hero switched to light text).
 */
export function heroTextCss(style: HeroTextStyle, lightByDefault = false): CSSProperties {
  const css: CSSProperties = {};
  if (style.color) css.color = style.color;
  if (style.font) css.fontFamily = HERO_FONTS.find((f) => f.id === style.font)!.family;
  if (style.weight !== null) css.fontWeight = style.weight;
  if (style.shadowEnabled) {
    const s = Math.min(1, Math.max(0.1, style.shadowStrength));
    const dark = style.color ? isDark(style.color) : !lightByDefault;
    const blur = Math.round(4 + 14 * s);
    css.textShadow = dark
      ? `0 1px ${blur}px rgba(255, 250, 247, ${(0.45 + 0.5 * s).toFixed(2)})`
      : `0 1px ${blur}px rgba(20, 8, 12, ${(0.25 + 0.5 * s).toFixed(2)})`;
  }
  return css;
}
