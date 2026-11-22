import { BadRequestException } from '@nestjs/common';

// The storefront's product-panel appearance (the owner's "panel" pencil on
// the public store page): the white product panel, the smart buttons
// (وصل حديثاً / تخفيضات / الترند), the main department buttons (الكل /
// نساء / رجال / أطفال) and the detailed subcategory chips - visual
// styling only. Nothing here touches the cover layers.
//
// Stored on Vendor.storefrontAppearance as the owner's OVERRIDES only
// ('{}' for every store until it changes something); every response
// returns the full resolved configuration = DEFAULTS + overrides. The
// defaults are the exact values the stylesheet used before this editor
// existed, so an untouched store looks exactly as it did.

type Field = { kind: 'color' } | { kind: 'number'; min: number; max: number };
interface Group {
  [key: string]: Field | Group;
}

const COLOR: Field = { kind: 'color' };
const UNIT: Field = { kind: 'number', min: 0, max: 1 };
const BLUR: Field = { kind: 'number', min: 0, max: 60 };
/** 999 = fully rounded (pill). */
const RADIUS: Field = { kind: 'number', min: 0, max: 999 };

/** One button state (default or active). */
const BUTTON_STATE: Group = {
  background: COLOR,
  background_opacity: UNIT,
  text: COLOR,
  border: COLOR,
  border_opacity: UNIT,
  /** The shine/highlight colour the background fades from. */
  glow: COLOR,
  glow_strength: UNIT,
  shadow_color: COLOR,
  shadow_opacity: UNIT,
  shadow_blur: BLUR,
};
const SUBCATEGORY_STATE: Group = { ...BUTTON_STATE, radius: RADIUS };
const pair = (state: Group): Group => ({ default: state, active: state });

export const APPEARANCE_SCHEMA: Group = {
  panel: {
    background: COLOR,
    background_opacity: UNIT,
    text: COLOR,
    muted_text: COLOR,
    divider: COLOR,
    divider_opacity: UNIT,
    border: COLOR,
    border_opacity: UNIT,
    radius: { kind: 'number', min: 0, max: 60 },
    shadow_color: COLOR,
    shadow_opacity: UNIT,
    shadow_blur: { kind: 'number', min: 0, max: 80 },
    shadow_offset_y: { kind: 'number', min: -40, max: 40 },
  },
  smart: { radius: RADIUS, ...pair(BUTTON_STATE) },
  departments: {
    all: pair(BUTTON_STATE),
    women: pair(BUTTON_STATE),
    men: pair(BUTTON_STATE),
    kids: pair(BUTTON_STATE),
  },
  subcategories: {
    women: pair(SUBCATEGORY_STATE),
    men: pair(SUBCATEGORY_STATE),
    kids: pair(SUBCATEGORY_STATE),
  },
};

export type AppearanceValue = number | string | AppearanceTree;
export interface AppearanceTree {
  [key: string]: AppearanceValue;
}

// The stylesheet's own values before this editor (globals.css):
//  .store-chip           #fff bg, var(--store-line) #EADFDA border,
//                        #1C1416 text, 0 1px 2px / 0 4px 12px
//                        rgba(74,22,38,.04/.05)
//  .store-chip.active    linear-gradient(135deg, #7A2E3A, #4A1626), #fff,
//                        transparent border, 0 6px 18px rgba(74,22,38,.3)
//  .store-chip-smart     linear-gradient(180deg, #FFFAF0, #fff), #7A5520,
//                        dashed rgba(201,154,69,.6)
//  .store-chip-smart.active  linear-gradient(135deg, #D8AC57, #B5832F),
//                        #fff, 0 6px 18px rgba(181,131,47,.32)
//  .store-subcategory-chip   rgba(255,253,251,.68), #704755,
//                        rgba(129,62,81,.18) border; active #F7E8E4,
//                        #702F43, #A96173 border
//  .store-products       #FFFDFC, radius 28px, no border, no own shadow
const departmentButton = {
  default: {
    background: '#FFFFFF',
    background_opacity: 1,
    text: '#1C1416',
    border: '#EADFDA',
    border_opacity: 1,
    glow: '#FFFFFF',
    glow_strength: 0,
    shadow_color: '#4A1626',
    shadow_opacity: 0.05,
    shadow_blur: 12,
  },
  active: {
    background: '#4A1626',
    background_opacity: 1,
    text: '#FFFFFF',
    border: '#4A1626',
    border_opacity: 0,
    glow: '#7A2E3A',
    glow_strength: 1,
    shadow_color: '#4A1626',
    shadow_opacity: 0.3,
    shadow_blur: 18,
  },
};
const subcategoryChip = {
  default: {
    background: '#FFFDFB',
    background_opacity: 0.68,
    text: '#704755',
    border: '#813E51',
    border_opacity: 0.18,
    glow: '#FFFDFB',
    glow_strength: 0,
    shadow_color: '#4A1626',
    shadow_opacity: 0,
    shadow_blur: 0,
    radius: 999,
  },
  active: {
    background: '#F7E8E4',
    background_opacity: 1,
    text: '#702F43',
    border: '#A96173',
    border_opacity: 1,
    glow: '#F7E8E4',
    glow_strength: 0,
    shadow_color: '#4A1626',
    shadow_opacity: 0,
    shadow_blur: 0,
    radius: 999,
  },
};

export const APPEARANCE_DEFAULTS: AppearanceTree = {
  panel: {
    background: '#FFFDFC',
    background_opacity: 1,
    text: '#1C1416',
    muted_text: '#6B5F5A',
    divider: '#B28962',
    divider_opacity: 0.62,
    border: '#EADFDA',
    border_opacity: 0,
    radius: 28,
    shadow_color: '#4A1626',
    shadow_opacity: 0,
    shadow_blur: 30,
    shadow_offset_y: -10,
  },
  smart: {
    radius: 999,
    default: {
      background: '#FFFFFF',
      background_opacity: 1,
      text: '#7A5520',
      border: '#C99A45',
      border_opacity: 0.6,
      glow: '#FFFAF0',
      glow_strength: 1,
      shadow_color: '#4A1626',
      shadow_opacity: 0.05,
      shadow_blur: 12,
    },
    active: {
      background: '#B5832F',
      background_opacity: 1,
      text: '#FFFFFF',
      border: '#B5832F',
      border_opacity: 0,
      glow: '#D8AC57',
      glow_strength: 1,
      shadow_color: '#B5832F',
      shadow_opacity: 0.32,
      shadow_blur: 18,
    },
  },
  departments: {
    all: departmentButton,
    women: departmentButton,
    men: departmentButton,
    kids: departmentButton,
  },
  subcategories: {
    women: subcategoryChip,
    men: subcategoryChip,
    kids: subcategoryChip,
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const isTree = (v: unknown): v is AppearanceTree =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isField = (node: Field | Group): node is Field =>
  typeof (node as Field).kind === 'string' &&
  ((node as Field).kind === 'color' || (node as Field).kind === 'number') &&
  Object.keys(node).every((k) => ['kind', 'min', 'max'].includes(k));

function invalid(path: string, message: string): never {
  throw new BadRequestException({
    code: 'INVALID_STOREFRONT_APPEARANCE',
    message: `storefront_appearance.${path}: ${message}`,
    details: [path],
  });
}

/**
 * Validates a PARTIAL update against the schema: every key must exist,
 * every leaf has the right type and range. `null` on a section/group/
 * state means "restore it to the defaults" (its overrides are dropped);
 * null on a single value is refused.
 */
export function validateAppearancePatch(
  patch: unknown,
  schema: Group = APPEARANCE_SCHEMA,
  path = '',
): void {
  if (!isTree(patch)) invalid(path || '(root)', 'must be an object');
  for (const [key, value] of Object.entries(patch)) {
    const here = path ? `${path}.${key}` : key;
    const node = schema[key];
    if (node === undefined) invalid(here, 'unknown setting');
    if (isField(node)) {
      if (node.kind === 'color') {
        if (typeof value !== 'string' || !HEX.test(value)) {
          invalid(here, 'must be a hex colour like #4A1626');
        }
      } else if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < node.min ||
        value > node.max
      ) {
        invalid(here, `must be a number between ${node.min} and ${node.max}`);
      }
    } else if (value !== null) {
      validateAppearancePatch(value, node, here);
    }
  }
}

/** overrides + patch (null drops a subtree back to the defaults). */
export function mergeAppearanceOverrides(
  overrides: AppearanceTree,
  patch: AppearanceTree,
): AppearanceTree {
  const out: AppearanceTree = { ...overrides };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isTree(value)) {
      const merged = mergeAppearanceOverrides(
        isTree(out[key]) ? out[key] : {},
        value,
      );
      if (Object.keys(merged).length === 0) delete out[key];
      else out[key] = merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The full configuration a response returns: defaults + overrides
 * (anything stored that no longer fits the schema is ignored). */
export function resolveAppearance(
  overrides: unknown,
  defaults: AppearanceTree = APPEARANCE_DEFAULTS,
): AppearanceTree {
  const out: AppearanceTree = {};
  const stored = isTree(overrides) ? overrides : {};
  for (const [key, def] of Object.entries(defaults)) {
    const value = stored[key];
    if (isTree(def)) out[key] = resolveAppearance(value, def);
    else out[key] = typeof value === typeof def ? value : def;
  }
  return out;
}
