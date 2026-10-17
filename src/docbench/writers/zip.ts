/**
 * A small deterministic zip writer for the document bench: every entry has
 * the same fixed timestamp, so the same inputs always give the same bytes.
 * It writes stored or deflated entries, traditional PKWARE ("ZipCrypto")
 * encryption, and raw local extra fields (to mark an entry AES-encrypted).
 * Independent of the extension's `src/zip-reader.ts` on purpose: the bench
 * must not test the reader with its own writer.
 */
import { deflateRawSync } from "node:zlib";

export interface ZipInput {
  name: string;
  data: Uint8Array | string;
  /** 0 stored, 8 deflated (default). */
  method?: 0 | 8;
  /** Encrypt with traditional PKWARE encryption under this password. */
  password?: string;
  /** Extra general-purpose flag bits (0x40 strong encryption...). */
  flags?: number;
  /** Raw extra field for the local and central headers. */
  extra?: Uint8Array;
  /** Pre-compressed data with its uncompressed size and CRC (zip bombs that are never inflated here). */
  raw?: { compressed: Uint8Array; size: number; crc: number };
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** DOS time and date of 2026-01-02 10:00:00, for every entry. */
const DOS_TIME = (10 << 11) | (0 << 5) | 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 2;

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Traditional PKWARE encryption (APPNOTE 6.1), with a deterministic 12-byte header. */
function zipCrypto(
  data: Uint8Array,
  password: string,
  crc: number,
): Uint8Array {
  let k0 = 0x12345678;
  let k1 = 0x23456789;
  let k2 = 0x34567890;
  const update = (byte: number) => {
    k0 = (CRC_TABLE[(k0 ^ byte) & 0xff]! ^ (k0 >>> 8)) >>> 0;
    k1 = (k1 + (k0 & 0xff)) >>> 0;
    k1 = (Math.imul(k1, 134775813) + 1) >>> 0;
    k2 = (CRC_TABLE[(k2 ^ (k1 >>> 24)) & 0xff]! ^ (k2 >>> 8)) >>> 0;
  };
  for (const b of utf8(password)) update(b);
  const header = new Uint8Array(12);
  for (let i = 0; i < 11; i++) header[i] = (i * 37 + 11) & 0xff;
  header[11] = (crc >>> 24) & 0xff;
  const out = new Uint8Array(12 + data.length);
  const plain = new Uint8Array(12 + data.length);
  plain.set(header);
  plain.set(data, 12);
  for (let i = 0; i < plain.length; i++) {
    const temp = (k2 | 2) & 0xffff;
    const key = (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
    out[i] = plain[i]! ^ key;
    update(plain[i]!);
  }
  return out;
}

/** Writes a zip archive of `entries`, in order. */
export function writeZip(entries: ZipInput[], comment = ""): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = utf8(e.name);
    const data = typeof e.data === "string" ? utf8(e.data) : e.data;
    const method = e.raw ? 8 : (e.method ?? 8);
    const crc = e.raw ? e.raw.crc : crc32(data);
    const size = e.raw ? e.raw.size : data.length;
    let body = e.raw
      ? e.raw.compressed
      : method === 8
        ? new Uint8Array(deflateRawSync(data, { level: 6 }))
        : data;
    let flags = 0x0800 | (e.flags ?? 0);
    if (e.password) {
      body = zipCrypto(body, e.password, crc);
      flags |= 0x1;
    }
    const extra = e.extra ?? new Uint8Array(0);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, extra.length, true);
    chunks.push(new Uint8Array(local.buffer), name, extra, body);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, flags, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, DOS_TIME, true);
    dir.setUint16(14, DOS_DATE, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, size, true);
    dir.setUint16(28, name.length, true);
    dir.setUint16(30, extra.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name, extra);
    offset += 30 + name.length + extra.length + body.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const commentBytes = utf8(comment);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, commentBytes.length, true);
  return concat([
    ...chunks,
    ...central,
    new Uint8Array(end.buffer),
    commentBytes,
  ]);
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A deflated entry of `size` zero bytes (a zip bomb's payload: ~1,000:1). */
export function zeroBomb(size: number): {
  compressed: Uint8Array;
  size: number;
  crc: number;
} {
  const zeros = new Uint8Array(size);
  return {
    compressed: new Uint8Array(deflateRawSync(zeros, { level: 9 })),
    size,
    crc: crc32(zeros),
  };
}
