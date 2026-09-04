// Minimal hand-rolled PDF writer (task-041, pure — node:zlib only, no deps).
//
// Same closed-allowlist discipline as src/lib/pure/png.ts: this module emits a
// structurally valid PDF 1.4 document from scratch — header, numbered objects,
// FlateDecode content streams, an xref table with correct byte offsets, a
// trailer, `startxref`, and `%%EOF` — so the URLA export (§4.9.3, REQ-075)
// opens in standard viewers without any PDF library.
//
// Text model: standard-14 Helvetica family (Type1, WinAnsiEncoding). Characters
// outside WinAnsi are NEVER emitted as mojibake — `encodeWinAnsi` substitutes a
// visible "?" marker and reports the replacement count so callers can surface
// the (documented) fallback. INV-036/INV-037: hostile names survive encoding
// without corrupting the file.
//
// Image model: raw 8-bit DeviceGray/DeviceRGB samples wrapped as FlateDecode
// Image XObjects (the signature PNG embed path — see pdf-png.ts for decoding).

import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// WinAnsi encoding
// ---------------------------------------------------------------------------

/** cp1252 specials living at bytes 0x80-0x9F (the non-Latin-1 WinAnsi block). */
const CP1252_SPECIALS: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

/** The visible substitution marker for characters WinAnsi cannot represent. */
export const WINANSI_FALLBACK_CHAR = "?";
const FALLBACK_BYTE = 0x3f; // "?"

export interface WinAnsiEncoded {
  /** One WinAnsi byte per input character. */
  bytes: number[];
  /** How many characters were outside WinAnsi and replaced with "?". */
  replacedCount: number;
}

/**
 * Map a string to WinAnsi bytes. ASCII and Latin-1 (0xA0-0xFF) pass through;
 * cp1252 specials map into 0x80-0x9F; everything else (e.g. CJK) becomes a
 * visible "?" — the documented safe fallback, never mojibake.
 */
export function encodeWinAnsi(text: string): WinAnsiEncoded {
  const bytes: number[] = [];
  let replacedCount = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) {
      bytes.push(cp);
    } else if (CP1252_SPECIALS[cp] !== undefined) {
      bytes.push(CP1252_SPECIALS[cp]!);
    } else {
      bytes.push(FALLBACK_BYTE);
      replacedCount += 1;
    }
  }
  return { bytes, replacedCount };
}

// ---------------------------------------------------------------------------
// Helvetica metrics (standard-14 AFM widths, 1000-unit em) — layout math only;
// viewers use their own built-in metrics for the standard fonts.
// ---------------------------------------------------------------------------

/** Font resource names: F1 Helvetica, F2 Helvetica-Bold, F3 Helvetica-Oblique. */
export type PdfFont = "F1" | "F2" | "F3";

// Widths for chars 32..126 (95 entries).
const HELV_WIDTHS: number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD_WIDTHS: number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

function charWidthUnits(ch: string, bold: boolean): number {
  const table = bold ? HELV_BOLD_WIDTHS : HELV_WIDTHS;
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x20 && cp <= 0x7e) return table[cp - 0x20]!;
  // Accented Latin: measure as the NFD base character when it is ASCII.
  const base = ch.normalize("NFD")[0];
  if (base) {
    const bcp = base.codePointAt(0)!;
    if (bcp >= 0x20 && bcp <= 0x7e) return table[bcp - 0x20]!;
  }
  return bold ? 611 : 556; // typical letter width fallback
}

/** Approximate rendered width of `text` at `size` points. */
export function textWidth(text: string, font: PdfFont, size: number): number {
  const bold = font === "F2";
  let units = 0;
  for (const ch of text) units += charWidthUnits(ch, bold);
  return (units / 1000) * size;
}

// ---------------------------------------------------------------------------
// Page content builder
// ---------------------------------------------------------------------------

export const PAGE_WIDTH = 612; // US Letter, points
export const PAGE_HEIGHT = 792;

export interface TextOptions {
  /** 0 = black .. 1 = white (DeviceGray fill). Default 0. */
  gray?: number;
}

export class PdfPage {
  /** Content-stream fragments, latin1 (WinAnsi bytes appear verbatim). */
  private readonly ops: string[] = [];
  /** Image resource names referenced by this page. */
  readonly imageNames = new Set<string>();
  /** Characters replaced with the WinAnsi fallback marker on this page. */
  replacedCount = 0;

  /** Show `text` with its baseline at (x, y). Returns the encoded width. */
  text(x: number, y: number, font: PdfFont, size: number, value: string, options: TextOptions = {}): void {
    const { bytes, replacedCount } = encodeWinAnsi(value);
    this.replacedCount += replacedCount;
    let literal = "";
    for (const b of bytes) {
      if (b === 0x28 || b === 0x29 || b === 0x5c) literal += `\\${String.fromCharCode(b)}`;
      else literal += String.fromCharCode(b);
    }
    const gray = options.gray ?? 0;
    this.ops.push(
      `BT ${fmt(gray)} g /${font} ${fmt(size)} Tf ${fmt(x)} ${fmt(y)} Td (${literal}) Tj ET`,
    );
  }

  /** Filled rectangle (x, y = lower-left corner). */
  rect(x: number, y: number, w: number, h: number, gray: number): void {
    this.ops.push(`${fmt(gray)} g ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f`);
  }

  /** Horizontal/vertical/any stroked line. */
  line(x1: number, y1: number, x2: number, y2: number, gray: number, width = 0.5): void {
    this.ops.push(
      `${fmt(gray)} G ${fmt(width)} w ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S`,
    );
  }

  /** Paint a registered image XObject into the rectangle (x, y, w, h). */
  drawImage(name: string, x: number, y: number, w: number, h: number): void {
    this.imageNames.add(name);
    this.ops.push(`q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(y)} cm /${name} Do Q`);
  }

  /** The page's raw (uncompressed) content stream bytes. */
  contentBytes(): Buffer {
    return Buffer.from(this.ops.join("\n"), "latin1");
  }
}

function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

// ---------------------------------------------------------------------------
// Document assembly — objects, xref, trailer
// ---------------------------------------------------------------------------

export interface PdfRawImage {
  /** Pixel dimensions. */
  width: number;
  height: number;
  colorSpace: "DeviceGray" | "DeviceRGB";
  /** Raw 8-bit samples, row-major, width*height*(1|3) bytes. */
  samples: Buffer;
}

interface RegisteredImage extends PdfRawImage {
  name: string;
}

export class PdfDoc {
  private readonly pages: PdfPage[] = [];
  private readonly images: RegisteredImage[] = [];
  /** Total fallback-substituted characters across the document. */
  get replacedCount(): number {
    return this.pages.reduce((n, p) => n + p.replacedCount, 0);
  }

  addPage(): PdfPage {
    const page = new PdfPage();
    this.pages.push(page);
    return page;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Register raw image samples as an Image XObject; returns its resource name. */
  addImage(image: PdfRawImage): string {
    const expected = image.width * image.height * (image.colorSpace === "DeviceRGB" ? 3 : 1);
    if (image.samples.length !== expected) {
      throw new Error(`PdfDoc.addImage: sample length ${image.samples.length} != ${expected}`);
    }
    const name = `Im${this.images.length + 1}`;
    this.images.push({ ...image, name });
    return name;
  }

  /**
   * Serialize the document: %PDF header, numbered objects, xref table with
   * correct byte offsets, trailer, startxref, %%EOF.
   */
  render(): Buffer {
    if (this.pages.length === 0) throw new Error("PdfDoc.render: no pages");
    const chunks: Buffer[] = [];
    let offset = 0;
    const push = (piece: Buffer | string): void => {
      const buf = typeof piece === "string" ? Buffer.from(piece, "latin1") : piece;
      chunks.push(buf);
      offset += buf.length;
    };

    // Object numbering: 1 Catalog, 2 Pages, 3-5 fonts, then images, then
    // (page, contents) pairs.
    const fontObjs = 3;
    const firstImageObj = fontObjs + 3; // 6
    const firstPageObj = firstImageObj + this.images.length;
    const totalObjs = firstPageObj - 1 + this.pages.length * 2;
    const offsets: number[] = new Array(totalObjs + 1).fill(0);

    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    const beginObj = (num: number): void => {
      offsets[num] = offset;
      push(`${num} 0 obj\n`);
    };
    const endObj = (): void => push("endobj\n");

    // 1: Catalog
    beginObj(1);
    push("<< /Type /Catalog /Pages 2 0 R >>\n");
    endObj();

    // 2: Pages
    const kids = this.pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(" ");
    beginObj(2);
    push(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>\n`);
    endObj();

    // 3-5: Fonts
    const fonts: [number, string][] = [
      [3, "Helvetica"],
      [4, "Helvetica-Bold"],
      [5, "Helvetica-Oblique"],
    ];
    for (const [num, base] of fonts) {
      beginObj(num);
      push(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>\n`);
      endObj();
    }

    // Images
    this.images.forEach((img, i) => {
      const data = deflateSync(img.samples);
      beginObj(firstImageObj + i);
      push(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /${img.colorSpace} /BitsPerComponent 8 /Filter /FlateDecode ` +
          `/Length ${data.length} >>\nstream\n`,
      );
      push(data);
      push("\nendstream\n");
      endObj();
    });

    // Pages + content streams
    const imageDict =
      this.images.length > 0
        ? ` /XObject << ${this.images.map((img, i) => `/${img.name} ${firstImageObj + i} 0 R`).join(" ")} >>`
        : "";
    this.pages.forEach((page, i) => {
      const pageObj = firstPageObj + i * 2;
      const contentObj = pageObj + 1;
      beginObj(pageObj);
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>${imageDict} >> ` +
          `/Contents ${contentObj} 0 R >>\n`,
      );
      endObj();
      const stream = deflateSync(page.contentBytes());
      beginObj(contentObj);
      push(`<< /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`);
      push(stream);
      push("\nendstream\n");
      endObj();
    });

    // xref
    const xrefOffset = offset;
    push(`xref\n0 ${totalObjs + 1}\n`);
    push("0000000000 65535 f \n");
    for (let num = 1; num <= totalObjs; num += 1) {
      push(`${String(offsets[num]).padStart(10, "0")} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return Buffer.concat(chunks);
  }
}
