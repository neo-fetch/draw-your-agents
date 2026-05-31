/**
 * `.zip` bundler — closes the codegen pipeline (ARCHITECTURE.md §5 / ADR-0003):
 * turns the `GeneratedProject` map into a downloadable archive whose root
 * folder is the project name. The output is a STORE-only (compression method
 * 0) ZIP. No DEFLATE, no `node:zlib`, no `CompressionStream` — only
 * `Uint8Array`, `DataView`, and `TextEncoder`, all present in both Node and
 * browser standard libs.
 *
 * Why STORE-only (ADR-0020): the same module needs to run in `apps/web`'s live
 * preview (ADR-0003: "Generation runs client-side (TS)") and in the headless
 * CLI. STORE is deterministic byte-for-byte (no runtime DEFLATE quirks) so the
 * round-trip golden tests are stable. Generated projects are a handful of
 * small `.py` files where compression buys very little.
 *
 * `unzipStore` is the inverse, used by `bundle.test.ts` and co-located so the
 * format is self-documenting. It only handles archives produced by
 * `bundleZip` — minimal STORE-only readers are not general-purpose.
 */
import type { GeneratedProject } from "./project.ts";

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
// MS-DOS time/date for 1980-01-01 00:00:00 — fixed so output is deterministic.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // year 1980, month 1, day 1
const UTF8_FLAG = 0x0800; // general-purpose bit 11 — filenames are UTF-8
const VERSION = 20; // PKZIP 2.0 — minimum for STORE with this header layout

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let crcTable: Uint32Array | undefined;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

function crc32(bytes: Uint8Array): number {
  const t = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  readonly nameBytes: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly localOffset: number;
}

/**
 * Bundle `project` into a ZIP archive. Every entry is stored under
 * `${rootDir}/` so the archive expands into a single named folder. The map's
 * insertion order is preserved in the central directory.
 */
export function bundleZip(project: GeneratedProject, rootDir: string): Uint8Array {
  // 1. Build local file headers + payloads, recording each entry's offset.
  const localChunks: Uint8Array[] = [];
  const entries: Entry[] = [];
  let offset = 0;

  for (const [path, content] of project) {
    const fullName = `${rootDir}/${path}`;
    const nameBytes = textEncoder.encode(fullName);
    const data = textEncoder.encode(content);
    const crc = crc32(data);

    const header = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, LOCAL_FILE_HEADER_SIG, true);
    dv.setUint16(4, VERSION, true);
    dv.setUint16(6, UTF8_FLAG, true);
    dv.setUint16(8, 0, true); // STORE
    dv.setUint16(10, DOS_TIME, true);
    dv.setUint16(12, DOS_DATE, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true); // compressed size
    dv.setUint32(22, data.length, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra field length
    header.set(nameBytes, 30);

    entries.push({ nameBytes, data, crc, localOffset: offset });
    localChunks.push(header, data);
    offset += header.length + data.length;
  }

  const localTotal = offset;

  // 2. Build central directory.
  const cdChunks: Uint8Array[] = [];
  let cdSize = 0;
  for (const e of entries) {
    const entry = new Uint8Array(46 + e.nameBytes.length);
    const dv = new DataView(entry.buffer);
    dv.setUint32(0, CENTRAL_DIR_HEADER_SIG, true);
    dv.setUint16(4, VERSION, true); // version made by
    dv.setUint16(6, VERSION, true); // version needed
    dv.setUint16(8, UTF8_FLAG, true);
    dv.setUint16(10, 0, true); // STORE
    dv.setUint16(12, DOS_TIME, true);
    dv.setUint16(14, DOS_DATE, true);
    dv.setUint32(16, e.crc, true);
    dv.setUint32(20, e.data.length, true);
    dv.setUint32(24, e.data.length, true);
    dv.setUint16(28, e.nameBytes.length, true);
    dv.setUint16(30, 0, true); // extra
    dv.setUint16(32, 0, true); // comment
    dv.setUint16(34, 0, true); // disk
    dv.setUint16(36, 0, true); // internal attrs
    dv.setUint32(38, 0, true); // external attrs
    dv.setUint32(42, e.localOffset, true);
    entry.set(e.nameBytes, 46);
    cdChunks.push(entry);
    cdSize += entry.length;
  }

  // 3. End of central directory record.
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, EOCD_SIG, true);
  dv.setUint16(4, 0, true); // disk number
  dv.setUint16(6, 0, true); // disk with CD
  dv.setUint16(8, entries.length, true);
  dv.setUint16(10, entries.length, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, localTotal, true); // CD offset
  dv.setUint16(20, 0, true); // comment length

  const out = new Uint8Array(localTotal + cdSize + eocd.length);
  let cursor = 0;
  for (const c of localChunks) {
    out.set(c, cursor);
    cursor += c.length;
  }
  for (const c of cdChunks) {
    out.set(c, cursor);
    cursor += c.length;
  }
  out.set(eocd, cursor);
  return out;
}

/**
 * Inverse of `bundleZip` for STORE-only archives — used by `bundle.test.ts` to
 * pin the round-trip. Returns `{ path: content }` with paths exactly as they
 * appear in the archive (i.e. with the `rootDir/` prefix).
 */
export function unzipStore(bytes: Uint8Array): Map<string, string> {
  // Locate EOCD by scanning backwards for its signature (variable-length
  // comment means it isn't at a fixed offset; here the comment is always 0).
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("unzipStore: EOCD not found");

  const entryCount = dv.getUint16(eocdOffset + 10, true);
  const cdOffset = dv.getUint32(eocdOffset + 16, true);

  const out = new Map<string, string>();
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (dv.getUint32(p, true) !== CENTRAL_DIR_HEADER_SIG) {
      throw new Error(`unzipStore: bad central directory signature at ${p}`);
    }
    const method = dv.getUint16(p + 10, true);
    if (method !== 0) throw new Error(`unzipStore: unsupported method ${method}`);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = textDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (dv.getUint32(localOffset, true) !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`unzipStore: bad local header signature at ${localOffset}`);
    }
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    out.set(name, textDecoder.decode(data));
  }
  return out;
}
