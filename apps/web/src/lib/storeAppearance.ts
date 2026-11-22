// The product panel's appearance (the "panel" pencil on the public store
// page): the white product panel, the smart buttons, the main department
// buttons and the detailed subcategory chips. The API returns the full
// configuration (its defaults + the owner's overrides); this file turns
// it into CSS custom properties. The defaults below are the stylesheet's
// own values and must equal apps/api/src/vendors/storefront-appearance.ts
// (asserted in apps/api/test/web-store-appearance.e2e-spec.ts), so an
// untouched store renders exactly as before. Pure functions only.

export interface ButtonStyle {
  background: string;
  background_opacity: number;
  text: string;
  border: string;
  border_opacity: number;
  glow: string;
  glow_strength: number;
  shadow_color: string;
  shadow_opacity: number;
  shadow_blur: number;
}
export interface SubcategoryStyle extends ButtonStyle {
  radius: number;
}
export interface ButtonPair<S = ButtonStyle> {
  default: S;
  active: S;
}
export interface PanelStyle {
  background: string;
  background_opacity: number;
  text: string;
  muted_text: string;
  divider: string;
  divider_opacity: number;
  border: string;
  border_opacity: number;
  radius: number;
  shadow_color: string;
  shadow_opacity: number;
  shadow_blur: number;
  shadow_offset_y: number;
}
export type Department = "women" | "men" | "kids";
export interface StoreAppearance {
  panel: PanelStyle;
  smart: ButtonPair & { radius: number };
  departments: Record<"all" | Department, ButtonPair>;
  subcategories: Record<Department, ButtonPair<SubcategoryStyle>>;
}

const departmentButton: ButtonPair = {
  default: {
    background: "#FFFFFF", background_opacity: 1, text: "#1C1416", border: "#EADFDA", border_opacity: 1,
    glow: "#FFFFFF", glow_strength: 0, shadow_color: "#4A1626", shadow_opacity: 0.05, shadow_blur: 12,
  },
  active: {
    background: "#4A1626", background_opacity: 1, text: "#FFFFFF", border: "#4A1626", border_opacity: 0,
    glow: "#7A2E3A", glow_strength: 1, shadow_color: "#4A1626", shadow_opacity: 0.3, shadow_blur: 18,
  },
};
const subcategoryChip: ButtonPair<SubcategoryStyle> = {
  default: {
    background: "#FFFDFB", background_opacity: 0.68, text: "#704755", border: "#813E51", border_opacity: 0.18,
    glow: "#FFFDFB", glow_strength: 0, shadow_color: "#4A1626", shadow_opacity: 0, shadow_blur: 0, radius: 999,
  },
  active: {
    background: "#F7E8E4", background_opacity: 1, text: "#702F43", border: "#A96173", border_opacity: 1,
    glow: "#F7E8E4", glow_strength: 0, shadow_color: "#4A1626", shadow_opacity: 0, shadow_blur: 0, radius: 999,
  },
};

export const DEFAULT_APPEARANCE: StoreAppearance = {
  panel: {
    background: "#FFFDFC", background_opacity: 1, text: "#1C1416", muted_text: "#6B5F5A",
    divider: "#B28962", divider_opacity: 0.62, border: "#EADFDA", border_opacity: 0, radius: 28,
    shadow_color: "#4A1626", shadow_opacity: 0, shadow_blur: 30, shadow_offset_y: -10,
  },
  smart: {
    radius: 999,
    default: {
      background: "#FFFFFF", background_opacity: 1, text: "#7A5520", border: "#C99A45", border_opacity: 0.6,
      glow: "#FFFAF0", glow_strength: 1, shadow_color: "#4A1626", shadow_opacity: 0.05, shadow_blur: 12,
    },
    active: {
      background: "#B5832F", background_opacity: 1, text: "#FFFFFF", border: "#B5832F", border_opacity: 0,
      glow: "#D8AC57", glow_strength: 1, shadow_color: "#B5832F", shadow_opacity: 0.32, shadow_blur: 18,
    },
  },
  departments: { all: departmentButton, women: departmentButton, men: departmentButton, kids: departmentButton },
  subcategories: { women: subcategoryChip, men: subcategoryChip, kids: subcategoryChip },
};

/** The slider ranges (the API refuses anything outside them). */
export const APPEARANCE_RANGES = {
  shadowBlur: { min: 0, max: 60 },
  panelRadius: { min: 0, max: 60 },
  panelShadowBlur: { min: 0, max: 80 },
  panelShadowOffset: { min: -40, max: 40 },
  /** Button radius slider; its top end means "fully rounded" (999). */
  buttonRadius: { min: 0, max: 30, pill: 999 },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHex = (value: string) => HEX.test(value);

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
const round = (n: number) => Math.round(n * 10000) / 10000;

/** #rrggbb at an opacity: the hex itself when opaque, else rgba(). */
export function withAlpha(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${round(Math.max(0, alpha))})`;
}

/** `a` mixed into `b` by `amount` (1 = a, 0 = b), as #rrggbb. */
function mix(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x: number, y: number) => Math.round(x * amount + y * (1 - amount)).toString(16).padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`.toUpperCase();
}

/** Background: the colour, fading from the glow colour when there is
 * glow (at full strength the gradient runs glow -> colour, as the
 * stylesheet's own gradients do). */
function background(s: ButtonStyle, angle: string): string {
  const base = withAlpha(s.background, s.background_opacity);
  if (s.glow_strength <= 0) return base;
  return `linear-gradient(${angle}, ${withAlpha(mix(s.glow, s.background, s.glow_strength), s.background_opacity)}, ${base})`;
}

/** Shadow: drops by a third of its blur (the stylesheet's 0 4px 12px /
 * 0 6px 18px); default-state buttons also keep their soft contact
 * shadow (0 1px 2px at 80% of the strength). */
function shadow(s: ButtonStyle, contact: number): string {
  if (s.shadow_opacity <= 0) return "none";
  const parts: string[] = [];
  if (contact > 0) parts.push(`0 1px 2px ${withAlpha(s.shadow_color, s.shadow_opacity * contact)}`);
  parts.push(`0 ${round(s.shadow_blur / 3)}px ${s.shadow_blur}px ${withAlpha(s.shadow_color, s.shadow_opacity)}`);
  return parts.join(", ");
}

const radius = (value: number) => (value >= APPEARANCE_RANGES.buttonRadius.pill ? "999px" : `${value}px`);

function buttonVars(prefix: string, s: ButtonStyle, angle: string, contact: number, out: Record<string, string>) {
  out[`${prefix}-bg`] = background(s, angle);
  out[`${prefix}-fg`] = s.text;
  out[`${prefix}-border`] = withAlpha(s.border, s.border_opacity);
  out[`${prefix}-shadow`] = shadow(s, contact);
}

const sameDivider = (p: PanelStyle) =>
  p.divider.toUpperCase() === DEFAULT_APPEARANCE.panel.divider && p.divider_opacity === DEFAULT_APPEARANCE.panel.divider_opacity;

/** The configuration as CSS custom properties (set on the store page's
 * root; only the panel and these button groups read them). */
export function appearanceVars(a: StoreAppearance): Record<string, string> {
  const out: Record<string, string> = {};
  const p = a.panel;
  out["--pa-panel-bg"] = withAlpha(p.background, p.background_opacity);
  out["--pa-panel-text"] = p.text;
  out["--pa-panel-muted"] = p.muted_text;
  out["--pa-panel-radius-n"] = String(p.radius);
  out["--pa-panel-shadow"] =
    p.shadow_opacity > 0 ? `0 ${p.shadow_offset_y}px ${p.shadow_blur}px ${withAlpha(p.shadow_color, p.shadow_opacity)}` : "0 0 0 transparent";
  out["--pa-panel-border"] = p.border_opacity > 0 ? `inset 0 0 0 1px ${withAlpha(p.border, p.border_opacity)}` : "inset 0 0 0 0 transparent";
  // The divider keeps the stylesheet's own two-tone line until changed.
  if (!sameDivider(p)) {
    out["--pa-divider-bg"] = `radial-gradient(ellipse 56% 100% at 50% 50%, ${withAlpha(p.divider, p.divider_opacity)} 0%, ${withAlpha(p.divider, p.divider_opacity * 0.45)} 48%, transparent 100%)`;
    out["--pa-divider-glow"] = `0 0 7px ${withAlpha(p.divider, p.divider_opacity * 0.42)}`;
  }
  buttonVars("--pa-smart-default", a.smart.default, "180deg", 0.8, out);
  buttonVars("--pa-smart-active", a.smart.active, "135deg", 0, out);
  out["--pa-smart-radius"] = radius(a.smart.radius);
  for (const d of ["all", "women", "men", "kids"] as const) {
    buttonVars(`--pa-dept-${d}-default`, a.departments[d].default, "135deg", 0.8, out);
    buttonVars(`--pa-dept-${d}-active`, a.departments[d].active, "135deg", 0, out);
  }
  for (const d of ["women", "men", "kids"] as const) {
    for (const state of ["default", "active"] as const) {
      const s = a.subcategories[d][state];
      buttonVars(`--pa-sub-${d}-${state}`, s, "135deg", 0, out);
      out[`--pa-sub-${d}-${state}-radius`] = radius(s.radius);
    }
  }
  return out;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b2] = rgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The readable text colour for a background (light on dark). */
export function readableText(bg: string): string {
  return contrastRatio("#FFFFFF", bg) >= contrastRatio("#1C1416", bg) ? "#FFFFFF" : "#1C1416";
}

/** A suggestion when text would be hard to read on its background
 * (null = fine). A see-through background is judged over the panel. */
export function readabilityHint(text: string, bg: string, bgOpacity: number, under = "#FFFDFC", min = 4.5): string | null {
  if (!isHex(text) || !isHex(bg)) return null;
  const seen = mix(bg, under, Math.max(0, Math.min(1, bgOpacity)));
  return contrastRatio(text, seen) < min ? readableText(seen) : null;
}

type Tree = { [key: string]: unknown };

/** True when every colour in the configuration is #rrggbb (the only
 * strings it holds). */
export function appearanceColorsValid(value: unknown): boolean {
  if (typeof value === "string") return isHex(value);
  if (typeof value === "object" && value !== null) return Object.values(value).every(appearanceColorsValid);
  return true;
}
const isTree = (v: unknown): v is Tree => typeof v === "object" && v !== null && !Array.isArray(v);

function deepEqual(a: unknown, b: unknown): boolean {
  if (isTree(a) && isTree(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => deepEqual(a[k], b[k]));
  }
  return typeof a === "string" && typeof b === "string" ? a.toUpperCase() === b.toUpperCase() : a === b;
}

function diff(next: Tree, prev: Tree): Tree {
  const out: Tree = {};
  for (const [key, value] of Object.entries(next)) {
    if (isTree(value)) {
      const d = diff(value, isTree(prev[key]) ? (prev[key] as Tree) : {});
      if (Object.keys(d).length) out[key] = d;
    } else if (!deepEqual(value, prev[key])) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The PUT body's partial `storefront_appearance`: only what changed, and a
 * section that is back to its defaults is sent as null (its overrides
 * are dropped, so it follows future defaults too). Null = nothing to save.
 */
export function appearancePatch(next: StoreAppearance, saved: StoreAppearance): Tree | null {
  const patch: Tree = {};
  for (const section of Object.keys(next) as (keyof StoreAppearance)[]) {
    if (deepEqual(next[section], saved[section])) continue;
    patch[section] = deepEqual(next[section], DEFAULT_APPEARANCE[section])
      ? null
      : diff(next[section] as unknown as Tree, saved[section] as unknown as Tree);
  }
  return Object.keys(patch).length ? patch : null;
}

/** A response's configuration, with any missing part from the defaults
 * (an older API simply has none). */
export function resolveAppearance(value: unknown, defaults: unknown = DEFAULT_APPEARANCE): StoreAppearance {
  const walk = (v: unknown, d: unknown): unknown => {
    if (isTree(d)) {
      const src = isTree(v) ? v : {};
      return Object.fromEntries(Object.entries(d).map(([k, dv]) => [k, walk(src[k], dv)]));
    }
    return typeof v === typeof d ? v : d;
  };
  return walk(value, defaults) as StoreAppearance;
}
