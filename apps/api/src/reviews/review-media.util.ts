import { BadRequestException } from '@nestjs/common';
import * as path from 'path';
import { sniffImage, uploadsDir } from '../uploads/uploads.util';

// sharp's package "types" field sends this project's node10 module
// resolution to its ESM typings (no call signature), while require()
// returns the CommonJS export - the sharp function itself. Type it from
// sharp's own CommonJS declaration.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');

/** PD-3: largest file accepted before processing. */
export const MAX_REVIEW_IMAGE_BYTES = 5 * 1024 * 1024;
/** Longest side after processing. */
const MAX_REVIEW_IMAGE_SIDE = 2048;
/** Refuse decompression bombs before decoding them. */
const MAX_INPUT_PIXELS = 40_000_000;

/**
 * PD-3: review images live OUTSIDE the statically served /uploads tree
 * (UPLOADS_DIR is served whole, with year-long immutable caching), so a
 * hidden or deleted review's image can never stay reachable by URL.
 * They are only ever streamed by ReviewMediaController, which re-checks
 * the review and the image are still public on every request.
 */
export function reviewMediaDir(): string {
  const dir = path.resolve(
    process.env.REVIEW_MEDIA_DIR ?? path.join(process.cwd(), 'review-media'),
  );
  const rel = path.relative(uploadsDir(), dir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(
      'REVIEW_MEDIA_DIR must not be inside UPLOADS_DIR (that tree is served publicly)',
    );
  }
  return dir;
}

export function reviewMediaPath(reviewId: string, fileName: string): string {
  return path.join(reviewMediaDir(), reviewId, fileName);
}

/** Base of this API's public URLs (".../api/v1"). */
export function apiPublicBaseUrl(): string {
  const base =
    process.env.API_PUBLIC_BASE_URL ??
    `http://localhost:${process.env.API_PORT ?? 3001}/api/v1`;
  return base.replace(/\/+$/, '');
}

/** The public URL of a review image (served only while it is public). */
export function reviewMediaUrl(mediaId: string): string {
  return `${apiPublicBaseUrl()}/review-media/${mediaId}`;
}

/** An administrator's view of any image, hidden ones included. */
export function adminReviewMediaUrl(mediaId: string): string {
  return `${apiPublicBaseUrl()}/admin/review-media/${mediaId}/file`;
}

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * The type is decided by the file's own bytes (JPEG/PNG/WebP - no GIF,
 * no SVG), then the image is fully re-encoded: EXIF orientation applied,
 * every metadata block (EXIF incl. GPS, XMP, ICC comments) dropped,
 * resized to at most 2048px, written as WebP. Re-encoding also drops
 * anything appended to or smuggled inside the original file.
 */
export async function processReviewImage(
  input: Buffer,
): Promise<ProcessedImage> {
  const kind = sniffImage(input);
  if (!kind || kind.ext === 'gif') {
    throw new BadRequestException({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Only JPEG, PNG or WebP images can be attached to a review',
    });
  }
  try {
    const { data, info } = await sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
    })
      .rotate()
      .resize({
        width: MAX_REVIEW_IMAGE_SIDE,
        height: MAX_REVIEW_IMAGE_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch {
    throw new BadRequestException({
      code: 'UNPROCESSABLE_IMAGE',
      message: 'This image could not be read - try another file',
    });
  }
}
