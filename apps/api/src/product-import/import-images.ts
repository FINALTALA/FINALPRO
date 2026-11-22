import { createHash } from 'crypto';
import { writeFile } from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import * as yauzl from 'yauzl';
import { MAX_SHARED_IMAGES } from '../offers/offer-presentation';
import { normalizeColorName } from '../offers/color-name';
import { MAX_IMAGES_PER_COLOR } from '../offer-drafts/draft-payload';
import { sniffImage, uploadsDir } from '../uploads/uploads.util';
import type { BuiltProduct, ImportProblem } from './build-drafts';
import {
  headerKey,
  IMAGE_COLUMNS,
  IMAGE_KIND_WORDS,
  plain,
  SHEETS,
  type ImageKind,
} from './import-labels';
import { sheetOf, type SheetRows } from './workbook';

// sharp's package "types" field sends this project's node10 module
// resolution to its ESM typings (no call signature), while require()
// returns the CommonJS export (same as uploads/image-dimensions.util.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');

/**
 * Images in bulk (2026-11-18): the product import's ZIP of images and its
 * «الصور» sheet. The ZIP is read from disk entry by entry (yauzl - never
 * unpacked to disk by its own names, never all in memory); only the images
 * the sheet names are read, checked by their bytes, re-encoded without
 * their metadata (EXIF: location, camera) and kept in a PRIVATE staging
 * folder outside the public uploads until the owner confirms.
 */

export const MAX_ZIP_BYTES = 150 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
export const MAX_ZIP_IMAGES = 1000;
/** Every entry, folders and system files included (the central directory itself is bounded). */
export const MAX_ZIP_ENTRIES = 5000;
export const MAX_IMPORT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
export const MAX_IMAGE_ROWS = 3000;
/** An entry that unpacks to more than this many times its packed size (and over 1 MB) is a ZIP bomb. */
const MAX_RATIO = 100;
/** A draft's image while the check waits for confirmation: never a URL anyone can open. */
export const STAGED_PREFIX = 'staged:';

/** The private staging root: outside the public uploads folder, always. */
export function importStagingRoot(): string {
  const root = path.resolve(
    process.env.IMPORT_STAGING_DIR ??
      path.join(path.dirname(uploadsDir()), 'import-staging'),
  );
  const pub = uploadsDir();
  if (
    root === pub ||
    root.startsWith(pub + path.sep) ||
    pub.startsWith(root + path.sep)
  )
    throw new Error(
      'The import staging folder must be outside the public uploads folder',
    );
  return root;
}
export const stagingDirOf = (vendorId: string, batchId: string) =>
  path.join(importStagingRoot(), 'batches', vendorId, batchId);
export const incomingDir = () => path.join(importStagingRoot(), 'incoming');

/** How a typed or archived name is compared: Unicode NFC, case-insensitive, «/» only. */
export function nameKey(name: string): string {
  return name
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .normalize('NFC')
    .toLowerCase();
}

const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

interface ZipEntryInfo {
  name: string;
  key: string;
  size: number;
  entry: yauzl.Entry;
}
export interface ZipIndex {
  zip: yauzl.ZipFile | null;
  entries: Map<string, ZipEntryInfo>;
  byBase: Map<string, ZipEntryInfo[]>;
  /** System files skipped on purpose (__MACOSX, .DS_Store, Thumbs.db). */
  ignored: string[];
  /** Problems with the ZIP itself: any of them refuses it as a whole. */
  problems: ImportProblem[];
}

const zipProblem = (code: string, value?: string, file?: string) =>
  ({
    sheet: 'zip',
    row: null,
    column: null,
    code,
    ...(value !== undefined ? { value } : {}),
    ...(file !== undefined ? { file } : {}),
  }) as ImportProblem;

/**
 * Reads the ZIP's central directory only (no file data): names, sizes and
 * flags. Refused as a whole: not a ZIP, too many entries, an unsafe path
 * (absolute, «..»), a symbolic link, an encrypted entry or an unknown
 * compression, two entries with the same name, a name whose encoding is
 * not declared (non-Latin bytes without the UTF-8 flag), a ZIP bomb, too
 * much once unpacked.
 */
export async function openZipIndex(zipPath: string): Promise<ZipIndex> {
  const index: ZipIndex = {
    zip: null,
    entries: new Map(),
    byBase: new Map(),
    ignored: [],
    problems: [],
  };
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(zipPath, {
      decodeStrings: false,
      autoClose: false,
      validateEntrySizes: true,
    });
  } catch {
    index.problems.push(zipProblem('ZIP_UNREADABLE'));
    return index;
  }
  index.zip = zip;
  if (zip.entryCount > MAX_ZIP_ENTRIES) {
    index.problems.push(
      zipProblem('ZIP_TOO_MANY_FILES', String(MAX_ZIP_IMAGES)),
    );
    return index;
  }
  let unpacked = 0;
  let files = 0;
  const badEncoding: string[] = [];
  try {
    for await (const e of zip.eachEntry()) {
      const raw = e.fileNameRaw ?? (e.fileName as unknown as Buffer);
      const declared =
        (e.generalPurposeBitFlag & 0x800) !== 0 ||
        e.extraFields.some((x) => x.id === 0x7075);
      if (!declared && raw.some((b) => b >= 0x80)) {
        // the archiver wrote the name in a local code page it did not declare
        badEncoding.push(raw.toString('latin1'));
        continue;
      }
      const name = yauzl.getFileNameLowLevel(
        e.generalPurposeBitFlag,
        raw,
        e.extraFields,
        false,
      );
      if (name.includes('�')) {
        badEncoding.push(name);
        continue;
      }
      if (
        yauzl.validateFileName(name) !== null ||
        /[\u0000-\u001f]/.test(name)
      ) {
        index.problems.push(zipProblem('ZIP_UNSAFE_PATH', name, name));
        continue;
      }
      if (name.endsWith('/')) continue; // a folder
      const mode = (e.externalFileAttributes >>> 16) & 0o170000;
      if (mode === 0o120000) {
        index.problems.push(zipProblem('ZIP_SYMLINK', name, name));
        continue;
      }
      const parts = name.split('/');
      const base = parts[parts.length - 1];
      if (
        parts.some((p) => p === '__MACOSX') ||
        SYSTEM_FILES.has(base.toLowerCase()) ||
        base.startsWith('._')
      ) {
        index.ignored.push(name);
        continue;
      }
      if (e.isEncrypted()) {
        index.problems.push(zipProblem('ZIP_ENCRYPTED', name, name));
        continue;
      }
      if (!e.canDecodeFileData()) {
        index.problems.push(zipProblem('ZIP_COMPRESSION', name, name));
        continue;
      }
      const key = nameKey(name);
      if (index.entries.has(key)) {
        index.problems.push(zipProblem('ZIP_DUPLICATE_NAME', name, name));
        continue;
      }
      if (
        e.uncompressedSize > 1024 * 1024 &&
        e.uncompressedSize > MAX_RATIO * Math.max(1, e.compressedSize)
      ) {
        index.problems.push(zipProblem('ZIP_BOMB', name, name));
        continue;
      }
      unpacked += e.uncompressedSize;
      files += 1;
      const info = { name, key, size: e.uncompressedSize, entry: e };
      index.entries.set(key, info);
      const baseKey = nameKey(base);
      index.byBase.set(baseKey, [...(index.byBase.get(baseKey) ?? []), info]);
    }
  } catch {
    index.problems.push(zipProblem('ZIP_UNREADABLE'));
    return index;
  }
  if (badEncoding.length > 0)
    index.problems.push(
      zipProblem('ZIP_NAME_ENCODING', String(badEncoding.length)),
    );
  if (files > MAX_ZIP_IMAGES)
    index.problems.push(
      zipProblem('ZIP_TOO_MANY_FILES', String(MAX_ZIP_IMAGES)),
    );
  if (unpacked > MAX_UNPACKED_BYTES)
    index.problems.push(zipProblem('ZIP_TOO_LARGE_UNPACKED', '300'));
  return index;
}

export function closeZip(index: ZipIndex) {
  try {
    index.zip?.close();
  } catch {
    // already closed
  }
}

/**
 * The ZIP entry a name typed in «الصور» points at: the full path inside the
 * ZIP, or - for a bare file name - the only entry with that name in any
 * folder (a ZIP made from a folder adds the folder's name).
 */
export function resolveImageName(
  index: ZipIndex,
  typed: string,
): { key: string } | { code: 'IMAGE_FILE_MISSING' | 'IMAGE_NAME_AMBIGUOUS' } {
  const key = nameKey(typed);
  if (index.entries.has(key)) return { key };
  if (!key.includes('/')) {
    const list = index.byBase.get(key) ?? [];
    if (list.length === 1) return { key: list[0].key };
    if (list.length > 1) return { code: 'IMAGE_NAME_AMBIGUOUS' };
  }
  return { code: 'IMAGE_FILE_MISSING' };
}

export type StagedImage =
  | {
      ok: true;
      name: string;
      /** The cleaned file's name in the staging folder: <sha256 of the original>.<ext>. */
      staged: string;
      sha256: string;
      width: number;
      height: number;
    }
  | { ok: false; name: string; code: string; value?: string };

const ALLOWED_EXT: Record<string, string[]> = {
  jpg: ['jpg', 'jpeg'],
  png: ['png'],
  webp: ['webp'],
};

/** What a file that is not JPEG/PNG/WebP actually is, for the message. */
function otherFormat(buf: Buffer, ext: string): string {
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (/^avi[fs]$/.test(brand)) return 'AVIF';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand))
      return 'HEIC';
  }
  const head = buf.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
  if (
    head.startsWith('<svg') ||
    (head.startsWith('<') && head.includes('<svg'))
  )
    return 'SVG';
  const sig = buf.subarray(0, 4).toString('latin1');
  if (sig.startsWith('BM')) return 'BMP';
  if (sig === 'II*\u0000' || sig === 'MM\u0000*') return 'TIFF';
  if (sig === 'PK\u0003\u0004') return 'ZIP';
  if (sig.startsWith('GIF8')) return 'GIF';
  if (ext === 'heic' || ext === 'heif') return 'HEIC';
  if (ext === 'svg') return 'SVG';
  return ext ? ext.toUpperCase() : '?';
}

async function collect(
  stream: Readable,
  limit: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of stream) {
    const c = chunk as Buffer;
    n += c.length;
    if (n > limit) {
      stream.destroy();
      return null;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * One image of the ZIP, checked and kept in the staging folder: the type by
 * its own bytes (JPEG, PNG or WebP - never by its name; HEIC, SVG, GIF and
 * the rest are named), the extension must say the same, at most 5 MB and
 * 25 megapixels, and it must decode. The kept copy is re-encoded upright
 * without any metadata (EXIF location, camera, comments).
 */
export async function stageImage(
  index: ZipIndex,
  key: string,
  stagingDir: string,
): Promise<StagedImage> {
  const info = index.entries.get(key)!;
  const name = info.name;
  const no = (code: string, value?: string): StagedImage => ({
    ok: false,
    name,
    code,
    ...(value !== undefined ? { value } : {}),
  });
  if (info.size > MAX_IMPORT_IMAGE_BYTES) return no('IMAGE_TOO_LARGE', '5');
  let buf: Buffer | null;
  try {
    buf = await collect(
      await index.zip!.openReadStreamPromise(info.entry),
      MAX_IMPORT_IMAGE_BYTES,
    );
  } catch {
    return no('IMAGE_UNREADABLE');
  }
  if (!buf) return no('IMAGE_TOO_LARGE', '5');
  const ext = path.extname(name).slice(1).toLowerCase();
  const kind = sniffImage(buf);
  if (!kind || kind.ext === 'gif')
    return no('IMAGE_FORMAT', kind ? 'GIF' : otherFormat(buf, ext));
  if (!ALLOWED_EXT[kind.ext].includes(ext))
    return no(
      'IMAGE_EXT_MISMATCH',
      `${ext ? `.${ext}` : '-'} → ${kind.ext === 'jpg' ? 'JPEG' : kind.ext.toUpperCase()}`,
    );
  let width = 0;
  let height = 0;
  let clean: Buffer;
  try {
    const meta = await sharp(buf, { limitInputPixels: false }).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    if (!width || !height) return no('IMAGE_UNREADABLE');
    if (width * height > MAX_IMAGE_PIXELS)
      return no('IMAGE_TOO_MANY_PIXELS', `${width}×${height}`);
    const img = sharp(buf, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'error',
    }).rotate(); // upright by its EXIF orientation - the orientation tag goes with the rest
    clean = await (
      kind.ext === 'jpg'
        ? img.jpeg({ quality: 90 })
        : kind.ext === 'png'
          ? img.png()
          : img.webp({ quality: 90 })
    ).toBuffer(); // sharp writes no metadata unless asked: EXIF, XMP, IPTC are dropped
    if ((meta.orientation ?? 1) >= 5) [width, height] = [height, width];
  } catch {
    return no('IMAGE_UNREADABLE');
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const staged = `${sha256}.${kind.ext}`;
  try {
    await writeFile(path.join(stagingDir, staged), clean, { flag: 'wx' });
  } catch (err) {
    // the same picture twice in the ZIP (two names): one staged copy
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return { ok: true, name, staged, sha256, width, height };
}

export interface ImageRow {
  row: number;
  ref: string | null;
  color: string | null;
  file: string | null;
  kind: string | null;
  order: string | null;
}
export interface ImageSheet {
  rows: ImageRow[];
  /** The columns as written in the file (for where a problem is). */
  header: Record<keyof typeof IMAGE_COLUMNS, string | null>;
  /** Problems with the sheet itself: missing, a required column missing, too many rows. */
  problems: ImportProblem[];
}

/** «الصور»: its rows by column, whatever language the template was in. */
export function readImageSheet(sheets: Map<string, SheetRows>): ImageSheet {
  const header = {
    ref: null,
    color_name_ar: null,
    file: null,
    kind: null,
    order: null,
  } as ImageSheet['header'];
  const sheet = sheetOf(sheets, SHEETS.images);
  if (!sheet)
    return {
      rows: [],
      header,
      problems: [
        {
          sheet: 'file',
          row: null,
          column: null,
          code: 'SHEET_MISSING',
          value: SHEETS.images.ar,
        },
      ],
    };
  const problems: ImportProblem[] = [];
  const index: Partial<Record<keyof typeof IMAGE_COLUMNS, number>> = {};
  sheet.headers.forEach((h, i) => {
    if (!h) return;
    const k = headerKey(h, IMAGE_COLUMNS);
    if (k) {
      index[k] = i;
      header[k] = h;
    } else
      problems.push({
        sheet: 'images',
        row: null,
        column: h,
        code: 'UNKNOWN_COLUMN',
      });
  });
  for (const k of ['ref', 'file', 'kind'] as const)
    if (index[k] === undefined)
      problems.push({
        sheet: 'images',
        row: null,
        column: IMAGE_COLUMNS[k].ar,
        code: 'COLUMN_MISSING',
      });
  if (sheet.rows.length > MAX_IMAGE_ROWS)
    problems.push({
      sheet: 'images',
      row: null,
      column: null,
      code: 'TOO_MANY_ROWS',
      value: String(MAX_IMAGE_ROWS),
    });
  const at = (cells: (string | null)[], k: keyof typeof IMAGE_COLUMNS) =>
    index[k] === undefined ? null : (cells[index[k]] ?? null);
  return {
    rows: sheet.rows.map((r) => ({
      row: r.row,
      ref: at(r.cells, 'ref'),
      color: at(r.cells, 'color_name_ar'),
      file: at(r.cells, 'file'),
      kind: at(r.cells, 'kind'),
      order: at(r.cells, 'order'),
    })),
    header,
    problems,
  };
}

export interface ProductImages {
  errors: ImportProblem[];
  warnings: ImportProblem[];
  /** colour key -> staged names, the main image first. */
  colors: Record<string, string[]>;
  shared: string[];
  count: number;
}

const toNumber = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(
    v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)),
  );
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/**
 * Links «الصور» to the products: exactly one main image per colour, the
 * extra images on a colour of the product, the shared ones on no colour;
 * every reference to a file that is in the ZIP and passed its check; the
 * limits per colour (10) and shared (6); the same picture twice in one
 * product refused, the same picture in two products a named warning.
 * Pure: the ZIP was already read (found: by row; images: by entry).
 */
export function linkImages(
  products: BuiltProduct[],
  sheet: ImageSheet,
  found: Map<number, { key: string } | { code: string }>,
  images: Map<string, StagedImage>,
): { byRef: Map<string, ProductImages>; fileProblems: ImportProblem[] } {
  const fileProblems: ImportProblem[] = [];
  const byRef = new Map<string, ProductImages>();
  const known = new Set(products.map((p) => plain(p.ref)));
  const rowsByRef = new Map<string, ImageRow[]>();
  for (const r of sheet.rows) {
    if (!r.ref) {
      fileProblems.push({
        sheet: 'images',
        row: r.row,
        column: sheet.header.ref,
        code: 'REQUIRED',
      });
      continue;
    }
    if (!known.has(plain(r.ref))) {
      fileProblems.push({
        sheet: 'images',
        row: r.row,
        column: sheet.header.ref,
        code: 'REF_UNKNOWN',
        value: r.ref,
      });
      continue;
    }
    rowsByRef.set(plain(r.ref), [...(rowsByRef.get(plain(r.ref)) ?? []), r]);
  }

  const owners = new Map<string, { ref: string; title: string }>();
  for (const p of products) {
    const out: ProductImages = {
      errors: [],
      warnings: [],
      colors: {},
      shared: [],
      count: 0,
    };
    byRef.set(p.ref, out);
    const err = (
      row: number | null,
      column: string | null,
      code: string,
      value?: string | null,
      file?: string,
    ) =>
      out.errors.push({
        sheet: 'images',
        row,
        column,
        code,
        ...(value ? { value } : {}),
        ...(file ? { file } : {}),
      });
    const mains = new Map<string, { row: number; staged: string }>();
    const extras = new Map<
      string,
      { row: number; order: number | null; staged: string }[]
    >();
    const shared: { row: number; order: number | null; staged: string }[] = [];
    const seen = new Set<string>();
    for (const r of rowsByRef.get(plain(p.ref)) ?? []) {
      const before = out.errors.length;
      let kind: ImageKind | null = null;
      if (!r.kind) err(r.row, sheet.header.kind, 'REQUIRED');
      else {
        kind =
          (Object.entries(IMAGE_KIND_WORDS).find(([code, w]) =>
            [code, w.ar, w.en].some((x) => plain(x) === plain(r.kind!)),
          )?.[0] as ImageKind | undefined) ?? null;
        if (!kind) err(r.row, sheet.header.kind, 'UNKNOWN_VALUE', r.kind);
      }
      const color = r.color
        ? (p.colorKeys.find(
            (c) => c.nameKey === normalizeColorName(r.color!),
          ) ?? null)
        : null;
      if (kind === 'SHARED' && r.color)
        err(r.row, sheet.header.color_name_ar, 'SHARED_WITH_COLOR', r.color);
      else if (r.color && !color)
        err(r.row, sheet.header.color_name_ar, 'IMAGE_COLOR_UNKNOWN', r.color);
      else if ((kind === 'MAIN' || kind === 'EXTRA') && !r.color)
        err(r.row, sheet.header.color_name_ar, 'IMAGE_COLOR_REQUIRED');
      const order = toNumber(r.order);
      if (r.order !== null && order === null)
        err(r.row, sheet.header.order, 'NOT_A_NUMBER', r.order);
      let image: Extract<StagedImage, { ok: true }> | null = null;
      if (!r.file) err(r.row, sheet.header.file, 'REQUIRED');
      else {
        const f = found.get(r.row);
        if (!f || 'code' in f)
          err(
            r.row,
            sheet.header.file,
            f && 'code' in f ? f.code : 'IMAGE_FILE_MISSING',
            r.file,
            r.file,
          );
        else {
          const img = images.get(f.key);
          if (!img || !img.ok)
            err(
              r.row,
              sheet.header.file,
              img?.ok === false ? img.code : 'IMAGE_UNREADABLE',
              img?.ok === false ? (img.value ?? null) : null,
              img?.name ?? r.file,
            );
          else image = img;
        }
      }
      if (out.errors.length > before || !image || !kind) continue;
      if (seen.has(image.sha256)) {
        err(r.row, sheet.header.file, 'IMAGE_REPEATED', r.file, image.name);
        continue;
      }
      seen.add(image.sha256);
      const owner = owners.get(image.sha256);
      if (owner && owner.ref !== p.ref)
        out.warnings.push({
          sheet: 'images',
          row: r.row,
          column: sheet.header.file,
          code: 'IMAGE_IN_OTHER_PRODUCT',
          value: owner.title,
          file: image.name,
        });
      else if (!owner) owners.set(image.sha256, { ref: p.ref, title: p.title });
      if (kind === 'MAIN') {
        if (mains.has(color!.key))
          err(r.row, sheet.header.kind, 'MAIN_IMAGE_DUPLICATE', color!.name);
        else mains.set(color!.key, { row: r.row, staged: image.staged });
      } else if (kind === 'EXTRA')
        extras.set(color!.key, [
          ...(extras.get(color!.key) ?? []),
          { row: r.row, order, staged: image.staged },
        ]);
      else shared.push({ row: r.row, order, staged: image.staged });
    }
    const byOrder = (
      a: { row: number; order: number | null },
      b: { row: number; order: number | null },
    ) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) -
        (b.order ?? Number.MAX_SAFE_INTEGER) || a.row - b.row;
    for (const c of p.colorKeys) {
      const main = mains.get(c.key);
      const more = (extras.get(c.key) ?? []).sort(byOrder);
      if (!main) err(null, null, 'MAIN_IMAGE_MISSING', c.name);
      else if (1 + more.length > MAX_IMAGES_PER_COLOR)
        err(null, null, 'TOO_MANY_IMAGES', c.name);
      else out.colors[c.key] = [main.staged, ...more.map((x) => x.staged)];
    }
    if (shared.length > MAX_SHARED_IMAGES)
      err(null, null, 'TOO_MANY_SHARED', String(MAX_SHARED_IMAGES));
    out.shared = shared.sort(byOrder).map((x) => x.staged);
    out.count =
      Object.values(out.colors).reduce((n, l) => n + l.length, 0) +
      out.shared.length;
  }
  return { byRef, fileProblems };
}
