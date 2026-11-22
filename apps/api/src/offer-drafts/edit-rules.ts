import { BadRequestException } from '@nestjs/common';
import { DraftPayload, draftVersions, versionKey } from './draft-payload';

/**
 * Edit drafts: the product as it was when the draft was opened - its
 * content as a draft payload (no stock, no SKUs), and which draft colour
 * key stands for which existing product colour.
 */
export interface EditSnapshot {
  payload: DraftPayload;
  /** draft colour key -> the product colour id it stands for */
  colorIds: Record<string, string>;
  /** colours whose sizes held different image sets (unified if edited) */
  mixedImages: string[];
}

function refuse(code: string, message: string, details: unknown[] = []) {
  return new BadRequestException({ code, message, details });
}

/**
 * What an edit draft may NOT change (the server's rule, on every save and
 * again when applying): the audience, the category and the size system; an
 * existing colour's family; removing an existing colour or one of its
 * sizes (nothing is ever deleted); the stock or SKU of an existing version
 * (live stock stays on the stock screen). A new colour, a new size of a
 * colour (same size system), names, swatches, images, order, the price,
 * the model, the size table, specs and the brand may change.
 */
export function assertEditAllowed(base: EditSnapshot, p: DraftPayload): void {
  const b = base.payload;
  for (const field of ['audience', 'category', 'size_system'] as const) {
    if ((p[field] ?? null) !== (b[field] ?? null)) {
      throw refuse(
        'EDIT_LOCKED_FIELD',
        `The ${field} of a published product is not changed here - copy it as a new product`,
        [{ field }],
      );
    }
  }
  const colors = new Map((p.colors ?? []).map((c) => [c.key, c]));
  for (const c of b.colors ?? []) {
    const now = colors.get(c.key);
    if (!now) {
      throw refuse(
        'EDIT_REMOVE_NOT_ALLOWED',
        'An existing colour is never removed',
        [{ color: c.key }],
      );
    }
    if ((now.family ?? null) !== (c.family ?? null)) {
      throw refuse(
        'EDIT_LOCKED_FIELD',
        "An existing colour's family is not changed",
        [{ field: 'color_family', color: c.key }],
      );
    }
    for (const size of b.sizes?.[c.key] ?? []) {
      if (!(p.sizes?.[c.key] ?? []).includes(size)) {
        throw refuse(
          'EDIT_REMOVE_NOT_ALLOWED',
          "An existing colour's size is never removed",
          [{ color: c.key, size }],
        );
      }
    }
  }
  const existing = new Set(
    draftVersions(b).map((v) => versionKey(v.color, v.size)),
  );
  if (p.default_stock !== undefined || p.stock_overrides !== undefined) {
    throw refuse(
      'EDIT_STOCK_EXISTING',
      'Only the new versions take an opening quantity',
    );
  }
  for (const per of Object.values(p.stock ?? {})) {
    for (const [key, q] of Object.entries(per)) {
      if (existing.has(key) && q > 0) {
        throw refuse(
          'EDIT_STOCK_EXISTING',
          "An existing version's stock is changed on the stock screen only",
          [{ version: key }],
        );
      }
    }
  }
  for (const key of Object.keys(p.sku_overrides ?? {})) {
    if (existing.has(key)) {
      throw refuse(
        'EDIT_SKU_EXISTING',
        "An existing version's SKU is not changed here",
        [{ version: key }],
      );
    }
  }
}

/** The groups the review step and a conflict talk about. */
export const EDIT_GROUPS = [
  'title',
  'description',
  'specs',
  'brand',
  'price',
  'colors',
  'images',
  'sizes',
  'shared_images',
  'model',
  'measurements',
  // fabric composition and country of origin, together
  'composition',
] as const;
export type EditGroup = (typeof EDIT_GROUPS)[number];

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b2]) =>
            a < b2 ? -1 : a > b2 ? 1 : 0,
          ),
        )
      : x,
  );
}

export function groupValue(p: DraftPayload, g: EditGroup): unknown {
  switch (g) {
    case 'title':
      return [(p.title_ar ?? '').trim(), (p.title_en ?? '').trim()];
    case 'description':
      return [(p.description_ar ?? '').trim(), (p.description_en ?? '').trim()];
    case 'specs':
      return p.specs ?? {};
    case 'brand':
      return p.brand ?? null;
    case 'price':
      return [p.price ?? null, p.discount ?? null];
    case 'colors':
      return (p.colors ?? []).map((c) => [
        c.key,
        c.family ?? null,
        c.name_ar.trim(),
        (c.name_en ?? '').trim() || null,
        c.hex ?? null,
        c.swatch ?? null,
      ]);
    case 'images':
      return Object.fromEntries((p.colors ?? []).map((c) => [c.key, c.images]));
    case 'sizes':
      return Object.fromEntries(
        Object.entries(p.sizes ?? {}).map(([k, l]) => [k, [...l].sort()]),
      );
    case 'shared_images':
      return p.shared_images ?? [];
    case 'model':
      return p.model?.height_cm || p.model?.size ? p.model : null;
    case 'measurements':
      return p.measurements ?? null;
    case 'composition':
      return [p.composition ?? null, p.country_of_origin ?? null];
  }
}

export function groupChanged(a: DraftPayload, b: DraftPayload, g: EditGroup) {
  return stable(groupValue(a, g)) !== stable(groupValue(b, g));
}

export function changedGroups(a: DraftPayload, b: DraftPayload): EditGroup[] {
  return EDIT_GROUPS.filter((g) => groupChanged(a, b, g));
}

/**
 * A conflict, group by group: `elsewhere` - changed on the product since
 * the draft was opened, not in the draft (the draft takes the current
 * value only when the seller confirms «تحديث المسودة»); `both` - changed in
 * both (the seller chooses: hers or the current one). Never merged silently.
 */
export function conflictGroups(
  base: DraftPayload,
  current: DraftPayload,
  mine: DraftPayload,
) {
  return EDIT_GROUPS.filter((g) => groupChanged(base, current, g)).map((g) => ({
    group: g,
    kind: groupChanged(base, mine, g)
      ? ('both' as const)
      : ('elsewhere' as const),
    current: groupValue(current, g),
    mine: groupValue(mine, g),
  }));
}
