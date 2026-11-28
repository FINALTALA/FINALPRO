import { BadRequestException } from '@nestjs/common';
import {
  CONTENT_SCHEMA_VERSION,
  ContentPageKey,
  FieldDef,
  SECTION_BY_KEY,
  SectionDef,
  sectionsOf,
} from './content-registry';

/**
 * VIA phase 6 - the content document: structural parsing (what a DRAFT
 * must satisfy - it may be incomplete) and publication validation (what a
 * published or scheduled revision must satisfy). Dependency checks against
 * the database (media, stores, collections...) are in the service.
 */

export interface TextValue {
  ar: string;
  en: string;
}
export type MediaRef =
  | { source: 'bundled'; path: string; alt?: TextValue }
  | { source: 'library'; assetId: string; alt?: TextValue };
export interface LinkValue {
  href: string;
}
export interface RefValue {
  refType: 'store' | 'collection' | 'category' | 'product';
  refId: string;
}
export type FieldValue = TextValue | MediaRef | LinkValue | RefValue;
export interface ContentItem {
  id: string;
  fields: Record<string, FieldValue | null>;
}
export interface ContentSection {
  id: string;
  key: string;
  enabled: boolean;
  fields: Record<string, FieldValue | null>;
  items: ContentItem[];
}
export interface ContentDocument {
  schemaVersion: number;
  sections: ContentSection[];
}

export interface ContentProblem {
  section_id: string;
  section_key: string;
  item_id: string | null;
  field: string | null;
  code: string;
  message: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f-]{36}$/i;
// The site's own bundled assets (apps/web/public), by folder and extension.
const BUNDLED =
  /^\/(images|videos|media|trend|advertising|ads|home|brand)\/[A-Za-z0-9 ._()\-/؀-ۿ]{1,240}\.(jpe?g|png|webp|avif|svg|mp4|webm)$/i;
const HREF = /^\/(?!\/)[^\s<>"']{0,300}$/;
const MAX_TEXT = 2000;

function bad(message: string, details?: unknown): never {
  throw new BadRequestException({
    code: 'CONTENT_INVALID',
    message,
    ...(details ? { details } : {}),
  });
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseText(v: unknown, where: string): TextValue {
  if (!isObj(v)) bad(`${where}: text must be { ar, en }`);
  const ar = v.ar ?? '';
  const en = v.en ?? '';
  if (typeof ar !== 'string' || typeof en !== 'string')
    bad(`${where}: text must be strings`);
  if (ar.length > MAX_TEXT || en.length > MAX_TEXT)
    bad(`${where}: text is too long`);
  return { ar, en };
}

function parseField(
  def: FieldDef,
  v: unknown,
  where: string,
): FieldValue | null {
  if (v === null || v === undefined) return null;
  switch (def.type) {
    case 'text':
      return parseText(v, where);
    case 'media': {
      if (!isObj(v)) bad(`${where}: media must be an object`);
      const alt =
        v.alt === undefined ? undefined : parseText(v.alt, `${where}.alt`);
      if (v.source === 'bundled') {
        if (
          typeof v.path !== 'string' ||
          !BUNDLED.test(v.path) ||
          v.path.includes('..')
        ) {
          bad(`${where}: bundled media must be a site asset path`);
        }
        return { source: 'bundled', path: v.path, ...(alt ? { alt } : {}) };
      }
      if (v.source === 'library') {
        if (typeof v.assetId !== 'string' || !UUID.test(v.assetId))
          bad(`${where}: library media needs an assetId`);
        return {
          source: 'library',
          assetId: v.assetId.toLowerCase(),
          ...(alt ? { alt } : {}),
        };
      }
      return bad(`${where}: media source must be bundled or library`);
    }
    case 'link':
      if (!isObj(v) || typeof v.href !== 'string' || !HREF.test(v.href))
        bad(`${where}: a link is a site path starting with /`);
      return { href: v.href };
    case 'ref':
      if (
        !isObj(v) ||
        v.refType !== def.refType ||
        typeof v.refId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(v.refId)
      ) {
        bad(
          `${where}: a ${def.refType} reference is { refType: '${def.refType}', refId }`,
        );
      }
      return { refType: def.refType!, refId: v.refId };
  }
}

function parseFields(defs: FieldDef[], raw: unknown, where: string) {
  if (raw !== undefined && !isObj(raw))
    bad(`${where}: fields must be an object`);
  const src = (raw ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (!defs.some((d) => d.name === k)) bad(`${where}: unknown field "${k}"`);
  }
  const out: Record<string, FieldValue | null> = {};
  for (const d of defs)
    out[d.name] = parseField(d, src[d.name], `${where}.${d.name}`);
  return out;
}

/** The structure every saved draft must have (it may still be incomplete). */
export function parseDocument(
  page: ContentPageKey,
  raw: unknown,
): ContentDocument {
  if (!isObj(raw)) bad('The document must be an object');
  if (raw.schemaVersion !== CONTENT_SCHEMA_VERSION)
    bad(`schemaVersion must be ${CONTENT_SCHEMA_VERSION}`);
  if (!Array.isArray(raw.sections)) bad('sections must be an array');
  const allowed = new Set(sectionsOf(page).map((s) => s.key));
  const seenSections = new Set<string>();
  const seenKeys = new Set<string>();
  const sections: ContentSection[] = raw.sections.map(
    (s: unknown, i: number) => {
      const where = `sections[${i}]`;
      if (!isObj(s)) bad(`${where} must be an object`);
      if (typeof s.id !== 'string' || !ID.test(s.id) || seenSections.has(s.id))
        bad(`${where}: id must be unique [A-Za-z0-9_-]`);
      seenSections.add(s.id);
      if (typeof s.key !== 'string' || !allowed.has(s.key))
        bad(`${where}: "${String(s.key)}" is not a section of ${page}`);
      if (seenKeys.has(s.key))
        bad(`${where}: section "${s.key}" appears twice`);
      seenKeys.add(s.key);
      const def = SECTION_BY_KEY.get(s.key)!;
      const fields = parseFields(def.fields, s.fields, `${where}.fields`);
      const itemsRaw = s.items ?? [];
      if (!Array.isArray(itemsRaw)) bad(`${where}.items must be an array`);
      if (!def.items && itemsRaw.length > 0)
        bad(`${where}: "${s.key}" has no items`);
      if (def.items && itemsRaw.length > def.items.max)
        bad(`${where}: at most ${def.items.max} items`);
      const seenItems = new Set<string>();
      const items: ContentItem[] = itemsRaw.map((it: unknown, j: number) => {
        const w = `${where}.items[${j}]`;
        if (!isObj(it)) bad(`${w} must be an object`);
        if (
          typeof it.id !== 'string' ||
          !ID.test(it.id) ||
          seenItems.has(it.id)
        )
          bad(`${w}: id must be unique within the section`);
        seenItems.add(it.id);
        return {
          id: it.id,
          fields: parseFields(def.items!.fields, it.fields, `${w}.fields`),
        };
      });
      return {
        id: s.id,
        key: s.key,
        enabled: s.enabled !== false,
        fields,
        items,
      };
    },
  );
  return { schemaVersion: CONTENT_SCHEMA_VERSION, sections };
}

/** Required Arabic + English copy, informative alt text, item counts - before publication. */
export function publicationProblems(doc: ContentDocument): ContentProblem[] {
  const problems: ContentProblem[] = [];
  const check = (
    def: SectionDef,
    s: ContentSection,
    fields: FieldDef[],
    values: Record<string, FieldValue | null>,
    itemId: string | null,
  ) => {
    for (const f of fields) {
      const v = values[f.name];
      const at = {
        section_id: s.id,
        section_key: s.key,
        item_id: itemId,
        field: f.name,
      };
      if (!v) {
        if (f.required)
          problems.push({
            ...at,
            code: 'REQUIRED',
            message: `${f.label.en} is required`,
          });
        continue;
      }
      if (f.type === 'text') {
        const tv = v as TextValue;
        const missing = (['ar', 'en'] as const).filter((l) => !tv[l].trim());
        if (f.required && missing.length) {
          problems.push({
            ...at,
            code: 'TRANSLATION_MISSING',
            message: `${f.label.en}: ${missing.join(' and ').toUpperCase()} text is missing`,
          });
        } else if (!f.required && missing.length === 1) {
          problems.push({
            ...at,
            code: 'TRANSLATION_MISSING',
            message: `${f.label.en}: ${missing[0].toUpperCase()} text is missing`,
          });
        }
      }
      // A decorative image (alt="", hidden from assistive tech) needs no alt text.
      if (f.type === 'media' && !f.decorative) {
        const alt = (v as MediaRef).alt;
        const missing = (['ar', 'en'] as const).filter(
          (l) => !alt || alt[l].trim().length < 3,
        );
        if (missing.length) {
          problems.push({
            ...at,
            code: 'ALT_TEXT_MISSING',
            message: `${f.label.en}: informative ${missing.join(' and ').toUpperCase()} alt text (3+ characters) is missing`,
          });
        }
      }
    }
    void def;
  };
  for (const s of doc.sections) {
    if (!s.enabled) continue;
    const def = SECTION_BY_KEY.get(s.key)!;
    check(def, s, def.fields, s.fields, null);
    if (def.items) {
      if (s.items.length < def.items.min) {
        problems.push({
          section_id: s.id,
          section_key: s.key,
          item_id: null,
          field: null,
          code: 'TOO_FEW_ITEMS',
          message: `At least ${def.items.min} item(s)`,
        });
      }
      for (const it of s.items)
        check(def, s, def.items.fields, it.fields, it.id);
    }
  }
  return problems;
}

/** Every Media Library asset id a document references. */
export function libraryAssets(doc: ContentDocument): Set<string> {
  const ids = new Set<string>();
  const visit = (values: Record<string, FieldValue | null>) => {
    for (const v of Object.values(values)) {
      if (v && (v as MediaRef).source === 'library')
        ids.add((v as { assetId: string }).assetId);
    }
  };
  for (const s of doc.sections) {
    visit(s.fields);
    for (const it of s.items) visit(it.fields);
  }
  return ids;
}

/** Every typed reference (store, collection, category, product) with where it is. */
export function references(doc: ContentDocument) {
  const out: {
    ref: RefValue;
    section: ContentSection;
    itemId: string | null;
    field: string;
  }[] = [];
  for (const s of doc.sections) {
    for (const [k, v] of Object.entries(s.fields))
      if (v && (v as RefValue).refType)
        out.push({ ref: v as RefValue, section: s, itemId: null, field: k });
    for (const it of s.items) {
      for (const [k, v] of Object.entries(it.fields))
        if (v && (v as RefValue).refType)
          out.push({ ref: v as RefValue, section: s, itemId: it.id, field: k });
    }
  }
  return out;
}

/** Every library media value with where it is (for dependency checks). */
export function mediaPlaces(doc: ContentDocument) {
  const out: {
    media: MediaRef;
    section: ContentSection;
    itemId: string | null;
    field: string;
  }[] = [];
  const visit = (
    s: ContentSection,
    values: Record<string, FieldValue | null>,
    itemId: string | null,
  ) => {
    for (const [k, v] of Object.entries(values)) {
      if (
        v &&
        ((v as MediaRef).source === 'library' ||
          (v as MediaRef).source === 'bundled')
      )
        out.push({ media: v as MediaRef, section: s, itemId, field: k });
    }
  };
  for (const s of doc.sections) {
    visit(s, s.fields, null);
    for (const it of s.items) visit(s, it.fields, it.id);
  }
  return out;
}
