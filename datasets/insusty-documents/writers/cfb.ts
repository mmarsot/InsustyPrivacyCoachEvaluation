/**
 * A minimal Compound File Binary (OLE2) writer: what a password-protected
 * Word, Excel or PowerPoint file is (an `EncryptionInfo` and an
 * `EncryptedPackage` stream), and what a legacy `.doc` is. Version 3, 512-byte
 * sectors; every stream is padded to at least 4,096 bytes so no mini stream is
 * needed. The content is filler: the bench only checks how the file is
 * classified, never decrypts it.
 */
import { concat } from "./zip.ts";

/** Sector size of a version 3 compound file. */
const SECTOR = 512;
/** FAT entry ending a sector chain (ENDOFCHAIN). */
const END = 0xfffffffe;
/** FAT entry of an unused sector (FREESECT). */
const FREE = 0xffffffff;
/** FAT entry of a sector that holds the FAT itself (FATSECT). */
const FATSECT = 0xfffffffd;

/** A compound file holding `streams` at its root, in order. */
export function writeCfb(
  streams: Array<{ name: string; data: Uint8Array }>,
): Uint8Array {
  const padded = streams.map((s) => {
    const size = Math.max(4096, Math.ceil(s.data.length / SECTOR) * SECTOR);
    const data = new Uint8Array(size);
    data.set(s.data);
    return { name: s.name, data, size: Math.max(4096, s.data.length) };
  });
  const streamSectors = padded.map((s) => s.data.length / SECTOR);
  const total = 2 + streamSectors.reduce((a, b) => a + b, 0);
  if (total > SECTOR / 4)
    throw new Error("writeCfb: streams too large for one FAT sector");
  const fat = new Uint32Array(SECTOR / 4).fill(FREE);
  fat[0] = FATSECT;
  fat[1] = END;
  let next = 2;
  const starts: number[] = [];
  for (const count of streamSectors) {
    starts.push(next);
    for (let i = 0; i < count; i++)
      fat[next + i] = i === count - 1 ? END : next + i + 1;
    next += count;
  }
  const header = new Uint8Array(SECTOR);
  const h = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  h.setUint16(24, 0x3e, true);
  h.setUint16(26, 3, true);
  h.setUint16(28, 0xfffe, true);
  h.setUint16(30, 9, true);
  h.setUint16(32, 6, true);
  h.setUint32(44, 1, true); // FAT sectors
  h.setUint32(48, 1, true); // first directory sector
  h.setUint32(56, 4096, true); // mini stream cutoff
  h.setUint32(60, END, true); // first mini FAT sector
  h.setUint32(64, 0, true);
  h.setUint32(68, END, true); // first DIFAT sector
  h.setUint32(72, 0, true);
  h.setUint32(76, 0, true); // DIFAT[0] = sector 0
  for (let i = 1; i < 109; i++) h.setUint32(76 + i * 4, FREE, true);
  const dir = new Uint8Array(SECTOR);
  const entry = (
    index: number,
    name: string,
    type: number,
    child: number,
    right: number,
    start: number,
    size: number,
  ) => {
    const at = index * 128;
    const v = new DataView(dir.buffer, at, 128);
    for (let i = 0; i < name.length; i++)
      v.setUint16(i * 2, name.charCodeAt(i), true);
    v.setUint16(64, (name.length + 1) * 2, true);
    dir[at + 66] = type;
    dir[at + 67] = 1; // black
    v.setUint32(68, FREE, true); // left
    v.setUint32(72, right, true);
    v.setUint32(76, child, true);
    v.setUint32(116, start, true);
    v.setUint32(120, size, true);
  };
  entry(0, "Root Entry", 5, padded.length ? 1 : FREE, FREE, END, 0);
  padded.forEach((s, i) =>
    entry(
      i + 1,
      s.name,
      2,
      FREE,
      i + 1 < padded.length ? i + 2 : FREE,
      starts[i]!,
      s.size,
    ),
  );
  for (let i = padded.length + 1; i < 4; i++) {
    const v = new DataView(dir.buffer, i * 128, 128);
    v.setUint32(68, FREE, true);
    v.setUint32(72, FREE, true);
    v.setUint32(76, FREE, true);
  }
  return concat([
    header,
    new Uint8Array(fat.buffer),
    dir,
    ...padded.map((s) => s.data),
  ]);
}

/** Deterministic filler bytes that look encrypted. */
export function noise(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

/** A password-protected Office file as Office saves it: an OLE2 container with the encrypted package. */
export const writeEncryptedOffice = (seed: number) =>
  writeCfb([
    {
      name: "EncryptionInfo",
      data: concat([
        Uint8Array.from([4, 0, 4, 0, 0x40, 0, 0, 0]),
        new TextEncoder().encode(
          '<?xml version="1.0" encoding="UTF-8"?><encryption xmlns="http://schemas.microsoft.com/office/2006/encryption"/>',
        ),
      ]),
    },
    { name: "EncryptedPackage", data: noise(12_000, seed) },
  ]);

/** A legacy binary Word document (`.doc`): not read by the extension. */
export const writeLegacyDoc = (seed: number) =>
  writeCfb([
    { name: "WordDocument", data: noise(6_000, seed) },
    { name: "1Table", data: noise(4_096, seed + 1) },
  ]);
