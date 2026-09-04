// Minimal deterministic PNG toolkit (task-012, pure — node:zlib only, no deps).
//
// Why this exists: §4.2.8 stores BOTH signature modes as real PNG image data —
// drawn signatures arrive as a client-rendered PNG data URL, but typed-mode
// (and the demo placeholder) images are produced SERVER-SIDE. The dependency
// allowlist is closed, so this module implements the two things needed:
//   - `encodePng` — a genuinely decodable 8-bit grayscale PNG encoder
//     (IHDR/IDAT/IEND, zlib via node:zlib, standard CRC-32),
//   - `renderTextPng` — deterministic rasterization of a typed name with an
//     embedded 5x7 bitmap font, sheared for a script-like slant.
// Plus `isPngBytes`, the magic-byte sniffer VR-075 uses to reject non-PNG
// payloads masquerading as PNG data URLs.
//
// The stored image is later embedded in the URLA PDF export (§4.9.3), so the
// output must be a spec-valid PNG, not a stub.

import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// CRC-32 (standard PNG polynomial 0xEDB88320)
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

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Encoder — 8-bit grayscale (color type 0), filter 0 scanlines
// ---------------------------------------------------------------------------

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

/**
 * Encode an 8-bit grayscale raster (`pixels` row-major, length width*height,
 * 0 = black .. 255 = white) as a complete, decodable PNG.
 */
export function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng: invalid dimensions ${width}x${height}`);
  }
  if (pixels.length !== width * height) {
    throw new Error(`encodePng: pixel buffer length ${pixels.length} != ${width}x${height}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  // Scanlines: leading filter byte 0 (None) per row.
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1);
    raw[rowStart] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), rowStart + 1);
  }
  // level 9 for a deterministic, compact stream.
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** VR-075 sniffer: true when bytes start with the PNG signature AND an IHDR chunk. */
export function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 24) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  // First chunk must be IHDR (offset 12..15 spells "IHDR").
  return bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font — each glyph is 7 rows of 5 bits (MSB = leftmost column)
// ---------------------------------------------------------------------------

const FONT_5X7: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  "3": [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  " ": [0, 0, 0, 0, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ",": [0, 0, 0, 0, 0, 0x0c, 0x04],
  "-": [0, 0, 0, 0x1f, 0, 0, 0],
  "'": [0x0c, 0x04, 0x08, 0, 0, 0, 0],
};

/** Unsupported characters render as this hollow-box glyph (never rejected). */
const FALLBACK_GLYPH = [0x1f, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1f];

const GLYPH_ROWS = 7;
const GLYPH_COLS = 5;
const CELL_WIDTH = GLYPH_COLS + 1; // 1px inter-glyph spacing
/** Horizontal shear (glyph pixels) applied per row for the script-style slant. */
function slantOffset(row: number): number {
  return Math.floor((GLYPH_ROWS - 1 - row) / 2);
}
const MAX_SLANT = slantOffset(0);

export interface RenderTextOptions {
  /** Integer pixel scale per glyph pixel. Default 4. */
  scale?: number;
  /** White border around the text, in output pixels. Default 12. */
  padding?: number;
}

/** Hard input bound so a hostile typedName cannot allocate an absurd raster. */
export const RENDER_TEXT_MAX_CHARS = 200;

/**
 * Render `text` deterministically as a grayscale PNG (dark ink on white),
 * slanted for a script-style look. Same input ⇒ byte-identical output.
 */
export function renderTextPng(text: string, options: RenderTextOptions = {}): Buffer {
  const scale = options.scale ?? 4;
  const padding = options.padding ?? 12;
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) {
    throw new Error(`renderTextPng: scale out of range: ${scale}`);
  }
  const chars = [...text];
  if (chars.length === 0) throw new Error("renderTextPng: text must be non-empty");
  if (chars.length > RENDER_TEXT_MAX_CHARS) {
    throw new Error(`renderTextPng: text exceeds ${RENDER_TEXT_MAX_CHARS} characters`);
  }

  const width = padding * 2 + (chars.length * CELL_WIDTH + MAX_SLANT) * scale;
  const height = padding * 2 + GLYPH_ROWS * scale;
  const pixels = new Uint8Array(width * height).fill(0xff); // white

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const glyph = FONT_5X7[ch] ?? FONT_5X7[ch.toUpperCase()] ?? FALLBACK_GLYPH;
    for (let row = 0; row < GLYPH_ROWS; row++) {
      const bits = glyph[row]!;
      for (let col = 0; col < GLYPH_COLS; col++) {
        if ((bits & (1 << (GLYPH_COLS - 1 - col))) === 0) continue;
        const gx = i * CELL_WIDTH + col + slantOffset(row);
        // Scale the glyph pixel to a scale x scale ink block.
        for (let dy = 0; dy < scale; dy++) {
          const py = padding + row * scale + dy;
          const rowBase = py * width + padding + gx * scale;
          pixels.fill(0x20, rowBase, rowBase + scale); // near-black ink
        }
      }
    }
  }

  return encodePng(width, height, pixels);
}
