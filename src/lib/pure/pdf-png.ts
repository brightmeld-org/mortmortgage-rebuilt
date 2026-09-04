// PNG → raw PDF image samples (task-041, pure — node:zlib only, no deps).
//
// The URLA PDF embeds Signature.imageData (PNG Bytes) as an Image XObject.
// Two producers exist:
//   - typed/demo signatures: our own src/lib/pure/png.ts encoder — 8-bit
//     grayscale (color type 0), filter 0 scanlines, single IDAT;
//   - drawn signatures: a client-rendered PNG (VR-075 sniffs the magic bytes
//     only), typically 8-bit RGBA with arbitrary per-row filters.
// This decoder therefore handles the general non-interlaced 8-bit case:
// color types 0 (gray), 2 (RGB), 3 (palette + optional tRNS), 4 (gray+alpha),
// 6 (RGBA); scanline filters 0-4 (None/Sub/Up/Average/Paeth). Alpha is
// FLATTENED ONTO WHITE (signature ink on a white form page — no SMask object
// needed). Anything else (interlaced, 16-bit) throws; the caller falls back to
// a text placeholder rather than corrupting the document.

import { inflateSync } from "node:zlib";
import type { PdfRawImage } from "./pdf";
import { PNG_SIGNATURE } from "./png";

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG into flattened raw samples for a PDF Image XObject.
 * Throws on unsupported variants (caller handles the fallback).
 */
export function decodePngForPdf(bytes: Uint8Array): PdfRawImage {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== PNG_SIGNATURE[i]) throw new Error("decodePngForPdf: not a PNG");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idatParts: Buffer[] = [];

  let pos = 8;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      const interlace = data[12]!;
      if (bitDepth !== 8) throw new Error(`decodePngForPdf: unsupported bit depth ${bitDepth}`);
      if (CHANNELS[colorType] === undefined) {
        throw new Error(`decodePngForPdf: unsupported color type ${colorType}`);
      }
      if (interlace !== 0) throw new Error("decodePngForPdf: interlaced PNG not supported");
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      trns = Buffer.from(data);
    } else if (type === "IDAT") {
      idatParts.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length; // length + type + data + crc
  }
  if (width <= 0 || height <= 0) throw new Error("decodePngForPdf: missing IHDR");
  if (idatParts.length === 0) throw new Error("decodePngForPdf: missing IDAT");
  if (colorType === 3 && !palette) throw new Error("decodePngForPdf: palette PNG missing PLTE");

  const channels = CHANNELS[colorType]!;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatParts));
  if (raw.length < height * (stride + 1)) {
    throw new Error("decodePngForPdf: truncated pixel data");
  }

  // Unfilter scanlines (filters 0-4) into `pixels`.
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const rowIn = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const rowOut = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? rowOut[x - channels]! : 0; // left
      const b = prev ? prev[x]! : 0; // up
      const c = prev && x >= channels ? prev[x - channels]! : 0; // up-left
      const v = rowIn[x]!;
      let out: number;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + Math.floor((a + b) / 2); break;
        case 4: out = v + paeth(a, b, c); break;
        default: throw new Error(`decodePngForPdf: unknown filter ${filter}`);
      }
      rowOut[x] = out & 0xff;
    }
  }

  // Convert to flattened DeviceGray / DeviceRGB samples.
  const over = (value: number, alpha: number): number =>
    Math.round((value * alpha + 255 * (255 - alpha)) / 255) & 0xff;

  if (colorType === 0) {
    return { width, height, colorSpace: "DeviceGray", samples: pixels };
  }
  if (colorType === 2) {
    return { width, height, colorSpace: "DeviceRGB", samples: pixels };
  }
  if (colorType === 4) {
    const out = Buffer.alloc(width * height);
    for (let i = 0; i < width * height; i += 1) {
      out[i] = over(pixels[i * 2]!, pixels[i * 2 + 1]!);
    }
    return { width, height, colorSpace: "DeviceGray", samples: out };
  }
  if (colorType === 6) {
    const out = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      const a = pixels[i * 4 + 3]!;
      out[i * 3] = over(pixels[i * 4]!, a);
      out[i * 3 + 1] = over(pixels[i * 4 + 1]!, a);
      out[i * 3 + 2] = over(pixels[i * 4 + 2]!, a);
    }
    return { width, height, colorSpace: "DeviceRGB", samples: out };
  }
  // colorType === 3: palette (+ optional tRNS alpha)
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const idx = pixels[i]!;
    const r = palette![idx * 3] ?? 0;
    const g = palette![idx * 3 + 1] ?? 0;
    const b = palette![idx * 3 + 2] ?? 0;
    const a = trns && idx < trns.length ? trns[idx]! : 255;
    out[i * 3] = over(r, a);
    out[i * 3 + 1] = over(g, a);
    out[i * 3 + 2] = over(b, a);
  }
  return { width, height, colorSpace: "DeviceRGB", samples: out };
}
