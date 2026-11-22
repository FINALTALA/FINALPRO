import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { isURL, ValidateBy } from 'class-validator';
import { existsSync } from 'fs';
import * as path from 'path';

// Sprint 26: owner image uploads (store logo/cover, product photos).
// Files live on the API host's disk under UPLOADS_DIR and are served
// read-only at /uploads/* (see configureUploadServing). The URL handed
// back is absolute (UPLOADS_PUBLIC_BASE_URL) so it can be stored in the
// same url columns external links already use - nothing that reads
// logoUrl/coverImageUrl/OfferVariantMedia.url has to change.

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface SniffedImage {
  ext: 'jpg' | 'png' | 'webp' | 'gif';
  mime: string;
}

/**
 * Identifies the image by its leading bytes, never by the client's
 * filename or Content-Type. Raster formats only: SVG is refused on
 * purpose (it can carry script).
 */
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (
    buf.length >= 8 &&
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a')
      return { ext: 'gif', mime: 'image/gif' };
  }
  return null;
}

export function uploadsDir(): string {
  return path.resolve(
    process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads'),
  );
}

export function uploadsPublicBaseUrl(): string {
  const base =
    process.env.UPLOADS_PUBLIC_BASE_URL ??
    `http://localhost:${process.env.API_PORT ?? 3001}/uploads`;
  return base.replace(/\/+$/, '');
}

const OWN_UPLOAD_PATH =
  /^\/vendors\/([0-9a-f-]{36})\/([0-9a-f]{32}\.(?:jpg|png|webp|gif))$/;

/** The vendor id and file name of a URL this API issued, else null. */
export function parseOwnUploadUrl(
  url: string,
): { vendorId: string; file: string } | null {
  const base = uploadsPublicBaseUrl();
  if (!url.startsWith(`${base}/`)) return null;
  const match = OWN_UPLOAD_PATH.exec(url.slice(base.length));
  return match ? { vendorId: match[1], file: match[2] } : null;
}

export function ownUploadUrl(vendorId: string, file: string): string {
  return `${uploadsPublicBaseUrl()}/vendors/${vendorId}/${file}`;
}

/** A public http(s) URL, or an upload URL this API itself issued. */
export function isUrlOrOwnUpload(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (isURL(value) || parseOwnUploadUrl(value) !== null)
  );
}

/** class-validator decorator form of isUrlOrOwnUpload(). */
export function IsUrlOrOwnUpload(message: string) {
  return ValidateBy({
    name: 'isUrlOrOwnUpload',
    validator: {
      validate: (value: unknown) => isUrlOrOwnUpload(value),
      defaultMessage: () => message,
    },
  });
}

/**
 * An own-upload URL must belong to the vendor it is being attached to
 * and must actually exist on disk. External URLs pass through as before.
 */
export function ownUploadProblem(
  url: string | undefined | null,
  vendorId: string,
): string | null {
  if (!url) return null;
  const own = parseOwnUploadUrl(url);
  if (!own) return null;
  if (own.vendorId !== vendorId)
    return 'This image was uploaded by a different store';
  if (!existsSync(path.join(uploadsDir(), 'vendors', own.vendorId, own.file))) {
    return 'This uploaded image no longer exists';
  }
  return null;
}

export function configureUploadServing(app: INestApplication): void {
  (app as NestExpressApplication).useStaticAssets(uploadsDir(), {
    prefix: '/uploads/',
    index: false,
    dotfiles: 'deny',
    fallthrough: false,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      // File names are random and never reused, so they can be cached hard.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });
}
