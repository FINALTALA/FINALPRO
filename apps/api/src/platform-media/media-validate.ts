import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { promises as fs } from 'fs';
import { sniffImage } from '../uploads/uploads.util';
import { probeMp4, probeWebm, ProbeError, VideoProbe } from './media-probe';

// sharp's typings resolve to ESM here; require() returns the CJS function
// (same as uploads/image-dimensions.util.ts). Version-pinned in package.json.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');
// No file cache: the validated file is moved right after (Windows locks).
sharp.cache(false);

/** VIA phase 5 - the approved upload limits. */
export const MEDIA_LIMITS = {
  imageMaxBytes: 10 * 1024 * 1024,
  imageMaxPixels: 40_000_000,
  videoMaxBytes: 100 * 1024 * 1024,
  videoMaxMs: 120_000,
  /** 1920x1080 landscape or its portrait equivalent (1080x1920). */
  videoLongEdge: 1920,
  videoShortEdge: 1080,
} as const;
/** The streaming cap: nothing larger is ever written to disk. */
export const UPLOAD_HARD_CAP = MEDIA_LIMITS.videoMaxBytes;

const VIDEO_CODECS = {
  mp4: { video: ['avc1', 'avc3'], audio: ['mp4a'] },
  webm: { video: ['V_VP8', 'V_VP9'], audio: ['A_OPUS'] },
} as const;

export interface ValidatedMedia {
  kind: 'IMAGE' | 'VIDEO';
  mime: string;
  ext: string;
  width: number;
  height: number;
  durationMs: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

function invalid(reason: string, message: string): never {
  throw new BadRequestException({
    code: 'MEDIA_INVALID',
    message,
    details: [{ reason }],
  });
}

function tooLarge(message: string): never {
  throw new PayloadTooLargeException({ code: 'MEDIA_TOO_LARGE', message });
}

/** Decides from the file's real bytes - never from its name or a declared type. */
export async function validateMediaFile(
  filePath: string,
  sizeBytes: number,
): Promise<ValidatedMedia> {
  if (sizeBytes <= 0) invalid('EMPTY', 'The file is empty');
  const fh = await fs.open(filePath, 'r');
  const head = Buffer.alloc(16);
  try {
    await fh.read(head, 0, 16, 0);
  } finally {
    await fh.close();
  }

  const image = sniffImage(head);
  if (image && image.ext !== 'gif') {
    if (sizeBytes > MEDIA_LIMITS.imageMaxBytes)
      tooLarge('An image is at most 10 MiB');
    let meta: {
      format?: string;
      width?: number;
      height?: number;
      orientation?: number;
    };
    try {
      // From a buffer (an image is at most 10 MiB): sharp never holds the
      // temporary file open, so it can be moved or deleted at once.
      meta = await sharp(await fs.readFile(filePath), {
        limitInputPixels: MEDIA_LIMITS.imageMaxPixels,
      }).metadata();
    } catch (e) {
      const m = (e as Error).message ?? '';
      if (/pixel limit/i.test(m))
        invalid('IMAGE_TOO_MANY_PIXELS', 'An image is at most 40 megapixels');
      invalid('IMAGE_UNREADABLE', 'The image could not be read');
    }
    const formatOf = { jpg: 'jpeg', png: 'png', webp: 'webp' } as const;
    if (meta.format !== formatOf[image.ext as keyof typeof formatOf]) {
      invalid(
        'IMAGE_FORMAT_MISMATCH',
        'The image content does not match its type',
      );
    }
    if (!meta.width || !meta.height)
      invalid('IMAGE_UNREADABLE', 'The image has no dimensions');
    if (meta.width * meta.height > MEDIA_LIMITS.imageMaxPixels) {
      invalid('IMAGE_TOO_MANY_PIXELS', 'An image is at most 40 megapixels');
    }
    const turned = (meta.orientation ?? 1) >= 5;
    return {
      kind: 'IMAGE',
      mime: image.mime,
      ext: image.ext,
      width: turned ? meta.height : meta.width,
      height: turned ? meta.width : meta.height,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    };
  }

  const isMp4 = head.toString('latin1', 4, 8) === 'ftyp';
  const isEbml = head.readUInt32BE(0) === 0x1a45dfa3;
  if (!isMp4 && !isEbml) {
    invalid(
      'UNSUPPORTED_TYPE',
      'Only JPEG, PNG, WebP images and MP4, WebM videos are accepted',
    );
  }
  if (sizeBytes > MEDIA_LIMITS.videoMaxBytes)
    tooLarge('A video is at most 100 MiB');

  let probe: VideoProbe;
  try {
    const buf = await fs.readFile(filePath);
    probe = isMp4 ? probeMp4(buf) : probeWebm(buf);
  } catch (e) {
    if (e instanceof ProbeError)
      invalid('VIDEO_UNREADABLE', `The video could not be read: ${e.message}`);
    throw e;
  }
  const rules = VIDEO_CODECS[probe.container];
  const videos = probe.tracks.filter((t) => t.kind === 'video');
  const audios = probe.tracks.filter((t) => t.kind === 'audio');
  if (probe.tracks.some((t) => t.kind === 'other')) {
    invalid(
      'VIDEO_EXTRA_TRACKS',
      'Only one video track and at most one audio track are accepted',
    );
  }
  if (videos.length !== 1 || audios.length > 1) {
    invalid(
      'VIDEO_TRACKS',
      'Exactly one video track and at most one audio track are accepted',
    );
  }
  const v = videos[0];
  if (!(rules.video as readonly string[]).includes(v.codec)) {
    invalid(
      'VIDEO_CODEC_NOT_ALLOWED',
      probe.container === 'mp4'
        ? 'MP4 video must be H.264'
        : 'WebM video must be VP8 or VP9',
    );
  }
  const a = audios[0];
  if (a && !(rules.audio as readonly string[]).includes(a.codec)) {
    invalid(
      'AUDIO_CODEC_NOT_ALLOWED',
      probe.container === 'mp4'
        ? 'MP4 audio must be AAC'
        : 'WebM audio must be Opus',
    );
  }
  const w = v.width ?? 0;
  const h = v.height ?? 0;
  if (w <= 0 || h <= 0)
    invalid('VIDEO_NO_DIMENSIONS', 'The video has no dimensions');
  if (
    Math.max(w, h) > MEDIA_LIMITS.videoLongEdge ||
    Math.min(w, h) > MEDIA_LIMITS.videoShortEdge
  ) {
    invalid(
      'VIDEO_TOO_LARGE_DIMENSIONS',
      'A video is at most 1920x1080 (or 1080x1920)',
    );
  }
  if (probe.durationMs === null || probe.durationMs <= 0) {
    invalid(
      'VIDEO_DURATION_UNKNOWN',
      'The video duration could not be determined',
    );
  }
  if (probe.durationMs > MEDIA_LIMITS.videoMaxMs) {
    invalid('VIDEO_TOO_LONG', 'A video is at most 120 seconds');
  }
  return {
    kind: 'VIDEO',
    mime: probe.container === 'mp4' ? 'video/mp4' : 'video/webm',
    ext: probe.container,
    width: w,
    height: h,
    durationMs: probe.durationMs,
    videoCodec: v.codec,
    audioCodec: a?.codec ?? null,
  };
}
