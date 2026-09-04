// Hand-rolled streaming ZIP writer (task-042, REQ-077 / SEC-14 — no new
// packages, node built-ins only, same discipline as the task-012 PNG encoder).
//
// Produces a fully spec-conformant ZIP as an async byte-chunk generator so the
// warehouse export can stream table CSVs without ever holding a full table (or
// the archive) in memory:
//   - one local file header per entry (general-purpose flags: bit 3 = sizes/CRC
//     in a trailing data descriptor, bit 11 = UTF-8 names),
//   - entry data STORED (method 0). Deliberate interpretation (documented):
//     builder-common allows "deflateRawSync per chunk or store"; per-chunk
//     deflateRawSync emits one *complete* raw-deflate stream per chunk (each
//     with a final block), and concatenating those is NOT a single valid
//     deflate stream — extractors stop at the first final block and fail the
//     CRC. Store keeps the writer truly chunk-streaming with an incremental
//     CRC and is losslessly extractable by any reader (Python stdlib zipfile
//     is the evidence check).
//   - a data descriptor (with signature) after each entry,
//   - central directory + end-of-central-directory records.
//
// CRC-32: the archive needs a *running* CRC across many chunks; the existing
// single-shot `crc32(bytes)` in src/lib/pure/png.ts cannot be seeded, so this
// module carries the identical table/polynomial (0xEDB88320, init 0xFFFFFFFF,
// final xor) split into init/update/final. Equivalence with png.ts crc32 is
// asserted in the task-042 evidence suite.

// ---------------------------------------------------------------------------
// Incremental CRC-32 (identical polynomial/table to src/lib/pure/png.ts)
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Initial running-CRC state (feed to crc32Update). */
export const CRC32_INIT = 0xffffffff;

/** Advance a running CRC-32 state over one chunk. */
export function crc32Update(state: number, chunk: Uint8Array): number {
  let c = state >>> 0;
  for (let i = 0; i < chunk.length; i++) {
    c = CRC_TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
  }
  return c >>> 0;
}

/** Finalize a running CRC-32 state to the standard CRC value. */
export function crc32Final(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

/** Single-shot convenience (byte-identical to src/lib/pure/png.ts crc32). */
export function crc32Once(bytes: Uint8Array): number {
  return crc32Final(crc32Update(CRC32_INIT, bytes));
}

// ---------------------------------------------------------------------------
// ZIP structures
// ---------------------------------------------------------------------------

/** One archive member: a forward-slash-separated name + its data chunks. */
export interface ZipEntry {
  name: string;
  data: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

interface CentralDirectoryRecord {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

/** General-purpose bit flags: bit 3 (data descriptor) + bit 11 (UTF-8 names). */
const GP_FLAGS = 0x0808;
/** "Version needed to extract" 2.0 — store + data descriptors. */
const VERSION = 20;
/** Compression method 0 = stored (see module header for why not deflate). */
const METHOD_STORE = 0;

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  return { dosTime, dosDate };
}

function u16(value: number): [number, number] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): [number, number, number, number] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function bytesOf(...parts: (number | readonly number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = [];
  for (const part of parts) {
    if (typeof part === "number") flat.push(part & 0xff);
    else for (const b of part) flat.push(b & 0xff);
  }
  return Uint8Array.from(flat);
}

function localFileHeader(nameBytes: Uint8Array, dosTime: number, dosDate: number): Uint8Array {
  return bytesOf(
    u32(0x04034b50),
    u16(VERSION),
    u16(GP_FLAGS),
    u16(METHOD_STORE),
    u16(dosTime),
    u16(dosDate),
    u32(0), // crc — in the data descriptor
    u32(0), // compressed size — in the data descriptor
    u32(0), // uncompressed size — in the data descriptor
    u16(nameBytes.length),
    u16(0), // extra length
    nameBytes,
  );
}

function dataDescriptor(crc: number, size: number): Uint8Array {
  // Stored entries: compressed size === uncompressed size.
  return bytesOf(u32(0x08074b50), u32(crc), u32(size), u32(size));
}

function centralDirectoryHeader(rec: CentralDirectoryRecord): Uint8Array {
  return bytesOf(
    u32(0x02014b50),
    u16(VERSION), // version made by
    u16(VERSION), // version needed
    u16(GP_FLAGS),
    u16(METHOD_STORE),
    u16(rec.dosTime),
    u16(rec.dosDate),
    u32(rec.crc),
    u32(rec.size), // compressed (stored)
    u32(rec.size), // uncompressed
    u16(rec.nameBytes.length),
    u16(0), // extra length
    u16(0), // comment length
    u16(0), // disk number start
    u16(0), // internal attributes
    u32(0), // external attributes
    u32(rec.offset),
    rec.nameBytes,
  );
}

function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Uint8Array {
  return bytesOf(
    u32(0x06054b50),
    u16(0), // this disk
    u16(0), // cd start disk
    u16(count),
    u16(count),
    u32(cdSize),
    u32(cdOffset),
    u16(0), // comment length
  );
}

/**
 * Stream a ZIP archive: consumes entries (each with lazily produced data
 * chunks) and yields archive bytes chunk-by-chunk. Memory stays bounded by a
 * single data chunk plus one small central-directory record per entry.
 */
export async function* createZipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const central: CentralDirectoryRecord[] = [];
  const now = new Date();
  const { dosTime, dosDate } = dosDateTime(now);
  let offset = 0;

  for await (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const entryOffset = offset;
    const header = localFileHeader(nameBytes, dosTime, dosDate);
    offset += header.length;
    yield header;

    let crcState = CRC32_INIT;
    let size = 0;
    for await (const chunk of entry.data) {
      if (chunk.length === 0) continue;
      crcState = crc32Update(crcState, chunk);
      size += chunk.length;
      offset += chunk.length;
      yield chunk;
    }
    const crc = crc32Final(crcState);
    const descriptor = dataDescriptor(crc, size);
    offset += descriptor.length;
    yield descriptor;

    central.push({ nameBytes, crc, size, offset: entryOffset, dosTime, dosDate });
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const rec of central) {
    const cdh = centralDirectoryHeader(rec);
    cdSize += cdh.length;
    yield cdh;
  }
  yield endOfCentralDirectory(central.length, cdSize, cdOffset);
}

/** Wrap an async byte generator as a web ReadableStream (route response body). */
export function iterableToReadableStream(
  iterable: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}
