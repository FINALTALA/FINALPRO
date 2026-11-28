/**
 * VIA phase 5 - a bounded, local media probe (no external binary, no
 * network; pinned with this repository). It reads the container
 * structure of the uploaded bytes and reports container, codecs,
 * dimensions and duration - the upload is accepted only from these
 * facts, never from a filename, extension or client-declared type.
 *
 *  - MP4 (ISO-BMFF): ftyp, moov/mvhd (+ mvex/mehd), trak/tkhd, mdia/mdhd,
 *    hdlr, stsd sample entry. A fragmented file without a stated duration
 *    is measured from its moof/traf (tfdt + trun).
 *  - WebM (Matroska/EBML): DocType "webm", Info (TimecodeScale, Duration),
 *    Tracks (CodecID, PixelWidth/Height). Without a Duration (a recorded
 *    stream) it is measured from the Cluster/Block timecodes. Unknown-size
 *    masters are handled.
 *
 * Bounded: at most MAX_ELEMENTS elements are read, nesting is capped, and
 * the caller only probes files already under the size cap.
 */

export const MAX_ELEMENTS = 2_000_000;
const MAX_DEPTH = 12;

export interface ProbeTrack {
  kind: 'video' | 'audio' | 'other';
  codec: string;
  width?: number;
  height?: number;
}

export interface VideoProbe {
  container: 'mp4' | 'webm';
  durationMs: number | null;
  tracks: ProbeTrack[];
}

export class ProbeError extends Error {}

// ------------------------------------------------------------------
// MP4

const MP4_CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'mvex',
  'moof',
  'traf',
  'edts',
  'dinf',
]);

export function probeMp4(buf: Buffer): VideoProbe {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') {
    throw new ProbeError('not an MP4 (no ftyp box)');
  }
  let elements = 0;
  let movieTimescale = 0;
  let movieDuration = 0;
  let fragmentDuration = 0;
  const tracks: (ProbeTrack & {
    id: number;
    timescale: number;
    defaultDuration: number;
  })[] = [];
  let current: (typeof tracks)[number] | null = null;
  // fragment state
  let fragTrackId = 0;
  let fragBase = 0;
  let fragDefault = 0;
  const fragEnd = new Map<number, number>();

  const walk = (start: number, end: number, depth: number) => {
    if (depth > MAX_DEPTH) throw new ProbeError('MP4 nested too deeply');
    let pos = start;
    while (pos + 8 <= end) {
      if (++elements > MAX_ELEMENTS)
        throw new ProbeError('MP4 has too many boxes');
      let size = buf.readUInt32BE(pos);
      const type = buf.toString('latin1', pos + 4, pos + 8);
      let header = 8;
      if (size === 1) {
        if (pos + 16 > end) throw new ProbeError('MP4 box truncated');
        const big = buf.readBigUInt64BE(pos + 8);
        if (big > BigInt(end - pos))
          throw new ProbeError('MP4 box overruns the file');
        size = Number(big);
        header = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < header || pos + size > end)
        throw new ProbeError(`MP4 box "${type}" overruns its parent`);
      const body = pos + header;
      const boxEnd = pos + size;
      if (type === 'trak') {
        current = {
          kind: 'other',
          codec: '',
          id: 0,
          timescale: 0,
          defaultDuration: 0,
        };
        tracks.push(current);
      }
      if (MP4_CONTAINERS.has(type)) {
        walk(body, boxEnd, depth + 1);
      } else {
        leaf(type, body, boxEnd);
      }
      pos = boxEnd;
    }
  };

  const leaf = (type: string, p: number, end: number) => {
    const version = buf[p];
    switch (type) {
      case 'mvhd':
        if (version === 1) {
          movieTimescale = buf.readUInt32BE(p + 20);
          movieDuration = Number(buf.readBigUInt64BE(p + 24));
        } else {
          movieTimescale = buf.readUInt32BE(p + 12);
          movieDuration = buf.readUInt32BE(p + 16);
        }
        break;
      case 'mehd':
        fragmentDuration =
          version === 1
            ? Number(buf.readBigUInt64BE(p + 4))
            : buf.readUInt32BE(p + 4);
        break;
      case 'tkhd': {
        if (!current) break;
        current.id = buf.readUInt32BE(p + (version === 1 ? 20 : 12));
        const wOff = end - 8; // width, height are the box's last 8 bytes (16.16)
        current.width = buf.readUInt32BE(wOff) >>> 16;
        current.height = buf.readUInt32BE(wOff + 4) >>> 16;
        break;
      }
      case 'mdhd':
        if (current)
          current.timescale = buf.readUInt32BE(p + (version === 1 ? 20 : 12));
        break;
      case 'hdlr': {
        if (!current) break;
        const h = buf.toString('latin1', p + 8, p + 12);
        current.kind =
          h === 'vide' ? 'video' : h === 'soun' ? 'audio' : 'other';
        break;
      }
      case 'stsd':
        // full box (4) + entry count (4) + first entry: size (4) + format (4)
        if (current && end - p >= 16)
          current.codec = buf.toString('latin1', p + 12, p + 16);
        break;
      case 'trex': {
        const id = buf.readUInt32BE(p + 4);
        const t = tracks.find((x) => x.id === id);
        if (t) t.defaultDuration = buf.readUInt32BE(p + 12);
        break;
      }
      case 'tfhd': {
        const flags = buf.readUIntBE(p + 1, 3);
        fragTrackId = buf.readUInt32BE(p + 4);
        let o = p + 8;
        if (flags & 0x1) o += 8;
        if (flags & 0x2) o += 4;
        const t = tracks.find((x) => x.id === fragTrackId);
        fragDefault =
          flags & 0x8 ? buf.readUInt32BE(o) : (t?.defaultDuration ?? 0);
        fragBase = fragEnd.get(fragTrackId) ?? 0;
        break;
      }
      case 'tfdt':
        fragBase =
          version === 1
            ? Number(buf.readBigUInt64BE(p + 4))
            : buf.readUInt32BE(p + 4);
        break;
      case 'trun': {
        const flags = buf.readUIntBE(p + 1, 3);
        const count = buf.readUInt32BE(p + 4);
        if (count > MAX_ELEMENTS) throw new ProbeError('MP4 trun too large');
        let o = p + 8;
        if (flags & 0x1) o += 4;
        if (flags & 0x4) o += 4;
        let total = 0;
        for (let i = 0; i < count; i++) {
          let d = fragDefault;
          if (flags & 0x100) {
            if (o + 4 > end) throw new ProbeError('MP4 trun truncated');
            d = buf.readUInt32BE(o);
            o += 4;
          }
          if (flags & 0x200) o += 4;
          if (flags & 0x400) o += 4;
          if (flags & 0x800) o += 4;
          total += d;
        }
        fragBase += total;
        fragEnd.set(
          fragTrackId,
          Math.max(fragEnd.get(fragTrackId) ?? 0, fragBase),
        );
        break;
      }
      default:
        break;
    }
  };

  walk(0, buf.length, 0);

  let durationMs: number | null = null;
  if (movieTimescale > 0 && movieDuration > 0) {
    durationMs = Math.round((movieDuration / movieTimescale) * 1000);
  } else if (movieTimescale > 0 && fragmentDuration > 0) {
    durationMs = Math.round((fragmentDuration / movieTimescale) * 1000);
  } else {
    for (const t of tracks) {
      const e = fragEnd.get(t.id);
      if (e && t.timescale > 0)
        durationMs = Math.max(
          durationMs ?? 0,
          Math.round((e / t.timescale) * 1000),
        );
    }
  }
  return {
    container: 'mp4',
    durationMs,
    tracks: tracks.map((t) => ({
      kind: t.kind,
      codec: t.codec,
      ...(t.kind === 'video' ? { width: t.width, height: t.height } : {}),
    })),
  };
}

// ------------------------------------------------------------------
// WebM (EBML)

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
};
const MASTERS = new Set([
  ID.Segment,
  ID.Info,
  ID.Tracks,
  ID.TrackEntry,
  ID.Video,
  ID.Cluster,
  ID.BlockGroup,
]);

function readVint(buf: Buffer, pos: number, keepMarker: boolean) {
  if (pos >= buf.length) throw new ProbeError('EBML truncated');
  const first = buf[pos];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) {
    len++;
    mask >>= 1;
  }
  if (len > 8) throw new ProbeError('EBML invalid length');
  if (pos + len > buf.length) throw new ProbeError('EBML truncated');
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function readUInt(buf: Buffer, p: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[p + i];
  return v;
}

export function probeWebm(buf: Buffer): VideoProbe {
  if (buf.length < 4 || buf.readUInt32BE(0) !== ID.EBML) {
    throw new ProbeError('not an EBML file');
  }
  // EBML header: find DocType.
  const headerSize = readVint(buf, 4, false);
  const headerEnd = 4 + headerSize.len + headerSize.value;
  let docType = '';
  for (let p = 4 + headerSize.len; p < headerEnd;) {
    const id = readVint(buf, p, true);
    const size = readVint(buf, p + id.len, false);
    const body = p + id.len + size.len;
    if (id.value === ID.DocType)
      docType = buf
        .toString('latin1', body, body + size.value)
        .replace(/\0+$/, '');
    p = body + size.value;
  }
  if (docType !== 'webm')
    throw new ProbeError(`EBML DocType is "${docType}", not webm`);

  let timecodeScale = 1_000_000; // ns per tick (Matroska default)
  let duration: number | null = null;
  const tracks: (ProbeTrack & { number: number })[] = [];
  let track: (typeof tracks)[number] | null = null;
  let clusterTime = 0;
  let maxTick = -1;
  let elements = 0;

  let pos = headerEnd;
  while (pos < buf.length) {
    if (++elements > MAX_ELEMENTS)
      throw new ProbeError('WebM has too many elements');
    const id = readVint(buf, pos, true);
    const size = readVint(buf, pos + id.len, false);
    const body = pos + id.len + size.len;
    if (MASTERS.has(id.value)) {
      if (id.value === ID.TrackEntry) {
        track = { kind: 'other', codec: '', number: 0 };
        tracks.push(track);
      }
      pos = body; // descend (also handles unknown sizes)
      continue;
    }
    if (size.unknown) throw new ProbeError('WebM leaf element of unknown size');
    const end = body + size.value;
    if (end > buf.length) {
      // A recording cut short: tolerate only a trailing partial block.
      if (id.value === ID.SimpleBlock || id.value === ID.Block) break;
      throw new ProbeError('WebM element overruns the file');
    }
    switch (id.value) {
      case ID.TimecodeScale:
        timecodeScale = readUInt(buf, body, size.value);
        break;
      case ID.Duration:
        duration =
          size.value === 4 ? buf.readFloatBE(body) : buf.readDoubleBE(body);
        break;
      case ID.TrackNumber:
        if (track) track.number = readUInt(buf, body, size.value);
        break;
      case ID.TrackType:
        if (track) {
          const v = readUInt(buf, body, size.value);
          track.kind = v === 1 ? 'video' : v === 2 ? 'audio' : 'other';
        }
        break;
      case ID.CodecID:
        if (track)
          track.codec = buf.toString('latin1', body, end).replace(/\0+$/, '');
        break;
      case ID.PixelWidth:
        if (track) track.width = readUInt(buf, body, size.value);
        break;
      case ID.PixelHeight:
        if (track) track.height = readUInt(buf, body, size.value);
        break;
      case ID.Timecode:
        clusterTime = readUInt(buf, body, size.value);
        break;
      case ID.SimpleBlock:
      case ID.Block: {
        const tn = readVint(buf, body, false);
        const rel = buf.readInt16BE(body + tn.len);
        maxTick = Math.max(maxTick, clusterTime + rel);
        break;
      }
      default:
        break;
    }
    pos = end;
  }

  let durationMs: number | null = null;
  if (duration !== null && duration > 0) {
    durationMs = Math.round((duration * timecodeScale) / 1_000_000);
  } else if (maxTick >= 0) {
    durationMs = Math.round((maxTick * timecodeScale) / 1_000_000);
  }
  return {
    container: 'webm',
    durationMs,
    tracks: tracks.map((t) => ({
      kind: t.kind,
      codec: t.codec,
      ...(t.kind === 'video' ? { width: t.width, height: t.height } : {}),
    })),
  };
}
