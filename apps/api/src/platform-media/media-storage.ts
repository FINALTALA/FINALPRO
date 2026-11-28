import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import type { Request, Response } from 'express';
import { uploadsDir } from '../uploads/uploads.util';

/**
 * VIA phase 5 - platform media storage: its own root (PLATFORM_MEDIA_DIR,
 * the persistent platform-media volume), never the merchant uploads
 * directory. Files are written under generated keys only:
 *   <category>/<yyyy>/<uuid>.<ext>
 * Temporary upload files live in <root>/.tmp until validated.
 */

export function mediaRoot(): string {
  return path.resolve(
    process.env.PLATFORM_MEDIA_DIR ??
      path.join(process.cwd(), 'platform-media'),
  );
}

export function mediaTmpDir(): string {
  return path.join(mediaRoot(), '.tmp');
}

/** Refuses a configuration that would mix platform media with merchant uploads. */
export function assertSeparateFromUploads(): void {
  const media = mediaRoot();
  const uploads = path.resolve(uploadsDir());
  const inside = (a: string, b: string) =>
    a === b || a.startsWith(b + path.sep);
  if (inside(media, uploads) || inside(uploads, media)) {
    throw new Error(
      'PLATFORM_MEDIA_DIR must be separate from UPLOADS_DIR (merchant uploads)',
    );
  }
}

const KEY =
  /^(homepage|trending|ads|collections)\/\d{4}\/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$/;

export function storageKey(
  category: string,
  id: string,
  ext: string,
  now = new Date(),
): string {
  return `${category.toLowerCase()}/${now.getUTCFullYear()}/${id}.${ext}`;
}

/** The absolute path of a stored key - only ever a key this service generated. */
export function keyPath(key: string): string {
  if (!KEY.test(key)) throw new Error('Invalid media storage key');
  return path.join(mediaRoot(), ...key.split('/'));
}

// ------------------------------------------------------------------
// Signed admin previews (unpublished assets) - short-lived, per asset.

const SECRET =
  process.env.MEDIA_PREVIEW_SECRET &&
  process.env.MEDIA_PREVIEW_SECRET.length >= 32
    ? process.env.MEDIA_PREVIEW_SECRET
    : randomBytes(32).toString('hex'); // per process: previews expire on restart
export const PREVIEW_TTL_SECONDS = 10 * 60;

function sign(id: string, exp: number): string {
  return createHmac('sha256', SECRET)
    .update(`${id}.${exp}`)
    .digest('base64url');
}

export function previewQuery(id: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + PREVIEW_TTL_SECONDS;
  return `exp=${exp}&sig=${sign(id, exp)}`;
}

export function verifyPreview(
  id: string,
  expRaw: unknown,
  sigRaw: unknown,
): boolean {
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000))
    return false;
  if (typeof sigRaw !== 'string') return false;
  const want = Buffer.from(sign(id, exp));
  const got = Buffer.from(sigRaw);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ------------------------------------------------------------------
// Delivery: validated type, nosniff, single byte ranges (video seeking).

export async function sendMediaFile(
  req: Request,
  res: Response,
  absPath: string,
  mime: string,
  size: number,
  cacheControl: string,
): Promise<void> {
  try {
    await fs.access(absPath);
  } catch {
    res
      .status(404)
      .json({ error: { code: 'MEDIA_NOT_FOUND', message: 'Not found' } });
    return;
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', String(size));
    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }
    res.status(200);
    createReadStream(absPath).pipe(res);
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start: number;
  let end: number;
  if (!m || (m[1] === '' && m[2] === '')) {
    start = -1;
    end = -1;
  } else if (m[1] === '') {
    const suffix = Number(m[2]);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start < 0 || start >= size || end < start) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return;
  }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(absPath, { start, end }).pipe(res);
}
