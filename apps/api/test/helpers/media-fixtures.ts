// VIA phase 5 - media fixtures for the Media Library spec. Images are real
// (encoded by sharp); videos are container files assembled box by box /
// element by element, so every codec, size and duration case is exact.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');

export async function image(
  format: 'jpeg' | 'png' | 'webp',
  width = 64,
  height = 48,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 30, b: 60 },
    },
    limitInputPixels: false,
  })
    [format]()
    .toBuffer();
}

/** A PNG of random noise (does not compress), about `bytes` large. */
export async function noisyPng(bytes: number): Promise<Buffer> {
  const side = Math.ceil(Math.sqrt(bytes / 3));
  const raw = Buffer.alloc(side * side * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (Math.random() * 256) | 0;
  return sharp(raw, { raw: { width: side, height: side, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

// ------------------------------------------------------------------ MP4

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([
    u32(body.length + 8),
    Buffer.from(type, 'latin1'),
    body,
  ]);
};

function trak(
  kind: 'vide' | 'soun',
  codec: string,
  width: number,
  height: number,
  id: number,
) {
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(id, 12);
  tkhd.writeUInt32BE(width << 16, 76);
  tkhd.writeUInt32BE(height << 16, 80);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(1000, 12); // timescale
  const hdlr = Buffer.concat([
    Buffer.alloc(8),
    Buffer.from(kind, 'latin1'),
    Buffer.alloc(13),
  ]);
  const stsd = Buffer.concat([
    u32(0),
    u32(1),
    u32(16),
    Buffer.from(codec, 'latin1'),
    Buffer.alloc(8),
  ]);
  return box(
    'trak',
    box('tkhd', tkhd),
    box(
      'mdia',
      box('mdhd', mdhd),
      box('hdlr', hdlr),
      box('minf', box('stbl', box('stsd', stsd))),
    ),
  );
}

export function mp4(o: {
  videoCodec?: string;
  audioCodec?: string | null;
  width?: number;
  height?: number;
  seconds?: number;
  padBytes?: number;
}): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round((o.seconds ?? 5) * 1000), 16);
  const traks = [
    trak('vide', o.videoCodec ?? 'avc1', o.width ?? 1280, o.height ?? 720, 1),
  ];
  if (o.audioCodec) traks.push(trak('soun', o.audioCodec, 0, 0, 2));
  return Buffer.concat([
    box(
      'ftyp',
      Buffer.from('isom', 'latin1'),
      u32(0),
      Buffer.from('isomavc1', 'latin1'),
    ),
    box('moov', box('mvhd', mvhd), ...traks),
    box('mdat', Buffer.alloc(o.padBytes ?? 256, 7)),
  ]);
}

// ------------------------------------------------------------------ WebM

const idBytes = (id: number) => {
  const hex = id.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
};
const size8 = (n: number) => {
  const b = Buffer.alloc(8);
  b[0] = 0x01;
  b.writeUIntBE(n, 2, 6);
  return b;
};
const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const el = (id: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([idBytes(id), size8(body.length), body]);
};
const uint = (n: number, bytes = 4) => {
  const b = Buffer.alloc(bytes);
  b.writeUIntBE(n, 0, bytes);
  return b;
};
const f64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b;
};

export function webm(o: {
  videoCodec?: string;
  audioCodec?: string | null;
  width?: number;
  height?: number;
  seconds?: number;
  /** omit Duration (a recording): measured from the block timecodes */
  noDuration?: boolean;
  unknownSizeSegment?: boolean;
  docType?: string;
}): Buffer {
  const header = el(
    0x1a45dfa3,
    el(0x4282, Buffer.from(o.docType ?? 'webm', 'latin1')),
  );
  const ms = Math.round((o.seconds ?? 5) * 1000);
  const info = el(
    0x1549a966,
    el(0x2ad7b1, uint(1_000_000, 3)),
    ...(o.noDuration ? [] : [el(0x4489, f64(ms))]),
  );
  const tracks = [
    el(
      0xae,
      el(0xd7, uint(1, 1)),
      el(0x83, uint(1, 1)),
      el(0x86, Buffer.from(o.videoCodec ?? 'V_VP9', 'latin1')),
      el(
        0xe0,
        el(0xb0, uint(o.width ?? 640, 2)),
        el(0xba, uint(o.height ?? 360, 2)),
      ),
    ),
  ];
  if (o.audioCodec) {
    tracks.push(
      el(
        0xae,
        el(0xd7, uint(2, 1)),
        el(0x83, uint(2, 1)),
        el(0x86, Buffer.from(o.audioCodec, 'latin1')),
      ),
    );
  }
  const block = (rel: number) => {
    const b = Buffer.alloc(4 + 16, 9);
    b[0] = 0x81; // track 1
    b.writeInt16BE(rel, 1);
    b[3] = 0x80;
    return el(0xa3, b);
  };
  // Clusters every second up to the duration, one block each.
  const clusters: Buffer[] = [];
  for (let t = 0; t <= ms; t += 1000) {
    clusters.push(el(0x1f43b675, el(0xe7, uint(t, 4)), block(0)));
  }
  const segBody = Buffer.concat([info, el(0x1654ae6b, ...tracks), ...clusters]);
  const segment = o.unknownSizeSegment
    ? Buffer.concat([idBytes(0x18538067), UNKNOWN, segBody])
    : el(0x18538067, segBody);
  return Buffer.concat([header, segment]);
}
