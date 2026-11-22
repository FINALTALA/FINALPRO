import { deflateRawSync } from 'zlib';

/**
 * A tiny ZIP writer for tests (images in bulk, 2026-11-18): full control
 * over what a real archiver would never write on purpose - unsafe paths,
 * undeclared name encodings, symbolic links, the encryption flag, bombs.
 */
export interface ZipItem {
  /** A string (UTF-8) or the raw bytes of the name. */
  name: string | Buffer;
  data: Buffer;
  /** Sets the UTF-8 flag (bit 11); default: when a string name is not ASCII. */
  utf8?: boolean;
  deflate?: boolean;
  /** Sets the traditional encryption flag (the data is left as it is). */
  encrypted?: boolean;
  /** A Unix mode in the external attributes (e.g. 0o120777: a symbolic link). */
  unixMode?: number;
}

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const it of items) {
    const name = Buffer.isBuffer(it.name)
      ? it.name
      : Buffer.from(it.name, 'utf8');
    const utf8 =
      it.utf8 ??
      (!Buffer.isBuffer(it.name) && /[^\u0000-\u007f]/.test(it.name));
    const method = it.deflate ? 8 : 0;
    const packed = it.deflate ? deflateRawSync(it.data) : it.data;
    // a traditionally encrypted entry carries a 12-byte encryption header
    const body = it.encrypted
      ? Buffer.concat([Buffer.alloc(12), packed])
      : packed;
    const flag = (utf8 ? 0x800 : 0) | (it.encrypted ? 0x1 : 0);
    const crc = crc32(it.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flag, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(it.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(it.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flag, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(it.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((it.unixMode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
