// sharp's package "types" field sends this project's node10 module
// resolution to its ESM typings (no call signature), while require()
// returns the CommonJS export - the sharp function itself (same as
// reviews/review-media.util.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');

/** Refuse decompression bombs before reading them. */
const MAX_INPUT_PIXELS = 40_000_000;

/**
 * Phase A++ (item 6): an uploaded image's width and height in pixels, as
 * displayed (EXIF orientation applied). Reads the header only - nothing is
 * decoded or re-encoded, the stored file is the uploaded bytes. null when
 * the image cannot be read (the upload itself is not refused for it).
 */
export async function imageDimensions(
  buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const m = await sharp(buffer, {
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
    if (!m.width || !m.height) return null;
    const turned = (m.orientation ?? 1) >= 5;
    return turned
      ? { width: m.height, height: m.width }
      : { width: m.width, height: m.height };
  } catch {
    return null;
  }
}
