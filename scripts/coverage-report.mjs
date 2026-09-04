// coverage-report.mjs — render server-side V8 coverage (NODE_V8_COVERAGE) to
// src/-scoped lcov + a printed summary. Dependency-free (node builtins only).
//
// See docs/coverage.md for what this does and does not prove.
//
// Usage:
//   node scripts/coverage-report.mjs --in coverage/server-v8 --out coverage/src-lcov.info
//   (flags optional; defaults shown above, resolved from the project root)
//
// Mechanism: the §7.7 suites are BLACK-BOX (drive the running app over HTTP),
// so in-process --experimental-test-coverage only sees the test harness. Real
// application (src/) coverage is captured in the SERVER process via
// NODE_V8_COVERAGE, which writes raw V8 ScriptCoverage JSON. Each file whose
// modules carry source maps also gets a `source-map-cache[url]` entry
// ({ lineLengths, data }). This script:
//   1. reads every coverage-*.json in --in,
//   2. keeps only scripts whose source map resolves into src/ (*.ts/*.tsx),
//   3. converts V8 byte-offset block ranges -> generated (line,col) using
//      lineLengths, then remaps to ORIGINAL src/ (line,col) via the v3 source
//      map (VLQ-decoded here — no dependency),
//   4. emits lcov (src/-relative paths) + prints a line/function summary.
//
// Line-coverage model (documented, deliberately simple): a source line is
// executable if any source-map mapping lands on it; it is HIT if the innermost
// V8 range covering that mapping's generated offset has count > 0. Per line we
// keep the max count across mappings and across coverage files. Function
// coverage uses V8's per-function entry counts, summed across files. This is a
// faithful "covered-or-not" line model; it is not statement/branch-accurate
// like istanbul. That limitation is stated in docs/coverage.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { in: "coverage/server-v8", out: "coverage/src-lcov.info", root: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") out.in = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--root") out.root = argv[++i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// VLQ base64 source-map decoding
// ---------------------------------------------------------------------------
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64MAP = (() => {
  const m = new Map();
  for (let i = 0; i < B64.length; i++) m.set(B64[i], i);
  return m;
})();

function decodeVlq(str) {
  // returns array of integers for one comma-separated segment
  const result = [];
  let shift = 0;
  let value = 0;
  for (const ch of str) {
    const digit = B64MAP.get(ch);
    if (digit === undefined) throw new Error(`bad base64 VLQ char: ${ch}`);
    const cont = digit & 32;
    value += (digit & 31) << shift;
    if (cont) {
      shift += 5;
    } else {
      const negative = value & 1;
      value >>= 1;
      result.push(negative ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return result;
}

/**
 * Decode a v3 `mappings` string into an array of segments:
 *   { genLine, genCol, srcIdx, origLine, origCol }  (all 0-based)
 * Segments without a source reference (1-length) are skipped — they anchor no
 * original line.
 */
function decodeMappings(mappings) {
  const segments = [];
  let genLine = 0;
  let srcIdx = 0;
  let origLine = 0;
  let origCol = 0;
  const lines = mappings.split(";");
  for (let gl = 0; gl < lines.length; gl++) {
    genLine = gl;
    let genCol = 0;
    const line = lines[gl];
    if (line.length === 0) continue;
    for (const seg of line.split(",")) {
      if (seg.length === 0) continue;
      const fields = decodeVlq(seg);
      genCol += fields[0];
      if (fields.length >= 4) {
        srcIdx += fields[1];
        origLine += fields[2];
        origCol += fields[3];
        segments.push({ genLine, genCol, srcIdx, origLine, origCol });
      }
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// generated (line,col) -> absolute byte offset, via lineLengths
// convention (matches Node's source-map-cache / v8-to-istanbul):
//   lineStart[0] = 0; lineStart[i] = lineStart[i-1] + lineLengths[i-1] + 1
// (+1 for the newline that terminates each generated line)
// ---------------------------------------------------------------------------
function buildLineStarts(lineLengths) {
  const starts = new Array(lineLengths.length + 1);
  starts[0] = 0;
  for (let i = 0; i < lineLengths.length; i++) {
    starts[i + 1] = starts[i] + lineLengths[i] + 1;
  }
  return starts;
}

// ---------------------------------------------------------------------------
// innermost-range count lookup for a generated byte offset
// V8 block coverage nests ranges; the innermost (narrowest) range that contains
// the offset carries the effective execution count.
// ---------------------------------------------------------------------------
function makeCountLookup(ranges) {
  // sort by start asc, then by end desc so that scanning yields outer-before-inner
  const sorted = ranges.slice().sort((a, b) => a.start - b.start || b.end - a.end);
  return function countAt(offset) {
    let count = null;
    let bestWidth = Infinity;
    for (const r of sorted) {
      if (r.start > offset) break;
      if (offset < r.end) {
        const width = r.end - r.start;
        if (width <= bestWidth) {
          bestWidth = width;
          count = r.count;
        }
      }
    }
    return count; // null => offset in no range => not executable per V8
  };
}

function isSrcSourceUrl(u) {
  if (!u) return false;
  // normalize to forward slashes
  const s = u.replace(/\\/g, "/");
  if (!/\/src\//.test(s)) return false;
  if (/\/node_modules\//.test(s)) return false;
  if (!/\.(ts|tsx|mts|cts)$/.test(s)) return false;
  return true;
}

// original source URL -> repo-relative "src/..." path
function toRepoRelative(sourceUrl, root) {
  let p = sourceUrl;
  try {
    if (p.startsWith("file://")) p = fileURLToPath(p);
  } catch {
    /* leave as-is */
  }
  p = p.replace(/\\/g, "/");
  const idx = p.lastIndexOf("/src/");
  if (idx >= 0) return p.slice(idx + 1); // drop leading slash -> "src/..."
  const rel = path.relative(root, p).replace(/\\/g, "/");
  return rel;
}

// ---------------------------------------------------------------------------
// main accumulation
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv);
  const inDir = path.resolve(args.root, args.in);
  const outFile = path.resolve(args.root, args.out);

  if (!fs.existsSync(inDir)) {
    console.error(`[coverage-report] input dir not found: ${inDir}`);
    console.error(`[coverage-report] nothing to render — was the server started with NODE_V8_COVERAGE=${args.in}?`);
    process.exit(2);
  }

  const files = fs.readdirSync(inDir).filter((f) => f.startsWith("coverage-") && f.endsWith(".json"));
  if (files.length === 0) {
    console.error(`[coverage-report] no coverage-*.json in ${inDir}`);
    process.exit(2);
  }

  // per repo-relative source file:
  //   lineHits: Map<lineNo(1-based), maxCount>
  //   fns: Map<name#origLine, { line, name, count }>
  const perFile = new Map();
  function getFileRec(rel) {
    let rec = perFile.get(rel);
    if (!rec) {
      rec = { lineHits: new Map(), fns: new Map() };
      perFile.set(rel, rec);
    }
    return rec;
  }

  let scriptsConsidered = 0;
  let scriptsWithSrc = 0;

  for (const f of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(path.join(inDir, f), "utf8"));
    } catch (e) {
      console.error(`[coverage-report] skipping unparseable ${f}: ${e.message}`);
      continue;
    }
    const smc = json["source-map-cache"] || {};
    for (const entry of json.result || []) {
      scriptsConsidered++;
      const url = entry.url;
      if (!url) continue;
      const cache = smc[url];
      if (!cache || !cache.data || !cache.lineLengths) {
        // No source map for this script. If the raw url itself is a src/ .ts we
        // could still measure it, but under tsx everything carries a map; skip
        // maps-less scripts (framework/node internals) rather than guess.
        continue;
      }
      const map = cache.data;
      const sources = (map.sources || []).map((s) => {
        // resolve relative sources against sourceRoot for the src/ test
        if (/^(file:|[a-zA-Z]:|\/)/.test(s)) return s;
        const root = map.sourceRoot || "";
        return root ? `${root.replace(/\/$/, "")}/${s}` : s;
      });
      const anySrc = sources.some((s) => isSrcSourceUrl(s));
      if (!anySrc) continue;
      scriptsWithSrc++;

      const lineStarts = buildLineStarts(cache.lineLengths);
      const flatRanges = [];
      for (const fn of entry.functions || []) {
        for (const r of fn.ranges || []) {
          flatRanges.push({ start: r.startOffset, end: r.endOffset, count: r.count });
        }
      }
      const countAt = makeCountLookup(flatRanges);
      const segments = decodeMappings(map.mappings || "");

      // ---- line coverage from mappings ----
      for (const seg of segments) {
        const srcUrl = sources[seg.srcIdx];
        if (!isSrcSourceUrl(srcUrl)) continue;
        const rel = toRepoRelative(srcUrl, args.root);
        const genLine = seg.genLine;
        if (genLine >= lineStarts.length - 1) continue;
        const genOffset = lineStarts[genLine] + seg.genCol;
        const count = countAt(genOffset);
        if (count === null) continue; // not executable
        const rec = getFileRec(rel);
        const lineNo = seg.origLine + 1; // lcov is 1-based
        const prev = rec.lineHits.get(lineNo);
        rec.lineHits.set(lineNo, prev === undefined ? count : Math.max(prev, count));
      }

      // ---- function coverage from V8 named functions ----
      for (const fn of entry.functions || []) {
        const name = fn.functionName;
        if (!name) continue; // anonymous — omit from FN listing
        const r0 = (fn.ranges || [])[0];
        if (!r0) continue;
        // map the function's start offset to an original position via the
        // nearest mapping at/just-before it
        const startOffset = r0.startOffset;
        // find generated line/col of startOffset
        let gl = 0;
        while (gl < lineStarts.length - 1 && lineStarts[gl + 1] <= startOffset) gl++;
        const gc = startOffset - lineStarts[gl];
        // nearest preceding segment on same generated line mapping into src
        let best = null;
        for (const seg of segments) {
          if (seg.genLine !== gl) continue;
          if (seg.genCol > gc) continue;
          if (!isSrcSourceUrl(sources[seg.srcIdx])) continue;
          if (!best || seg.genCol > best.genCol) best = seg;
        }
        if (!best) continue;
        const rel = toRepoRelative(sources[best.srcIdx], args.root);
        const rec = getFileRec(rel);
        const fnLine = best.origLine + 1;
        const width = r0.endOffset - r0.startOffset;
        // Dedupe by name. esbuild emits tiny export-binding arrows (`() => fn`)
        // that V8 names identically to the real function and maps to line 1;
        // keep the occurrence with the WIDEST generated range (the real body)
        // and the MAX execution count observed, so those wrappers don't inflate
        // the function count or misplace the definition line.
        const prev = rec.fns.get(name);
        if (prev) {
          if (width > prev.width) {
            // A wider range is the real function body (the earlier one was a
            // transpile-emitted export-binding arrow). Adopt its line AND its
            // OWN count — never the wrapper's — so a getter that ran during
            // import can't masquerade as the real function executing.
            prev.width = width;
            prev.line = fnLine;
            prev.count = r0.count;
          } else if (width === prev.width) {
            // Same body seen in another process dump — sum invocations.
            prev.count += r0.count;
          }
          // narrower => export-binding wrapper => ignore its count entirely
        } else {
          rec.fns.set(name, { line: fnLine, name, count: r0.count, width });
        }
      }
    }
  }

  if (perFile.size === 0) {
    console.error("[coverage-report] no src/ coverage found in the V8 profile.");
    console.error("[coverage-report] scripts considered:", scriptsConsidered, "with src map:", scriptsWithSrc);
    console.error("[coverage-report] (a server profile with zero src/ execution, or a maps-less build)");
    process.exit(3);
  }

  // ---- emit lcov ----
  const lcovLines = [];
  const rels = [...perFile.keys()].sort();
  let totLF = 0;
  let totLH = 0;
  let totFNF = 0;
  let totFNH = 0;
  const summaryRows = [];
  for (const rel of rels) {
    const rec = perFile.get(rel);
    lcovLines.push("TN:");
    lcovLines.push(`SF:${rel}`);
    // functions
    const fns = [...rec.fns.values()].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    for (const fn of fns) lcovLines.push(`FN:${fn.line},${fn.name}`);
    for (const fn of fns) lcovLines.push(`FNDA:${fn.count},${fn.name}`);
    const fnf = fns.length;
    const fnh = fns.filter((f) => f.count > 0).length;
    lcovLines.push(`FNF:${fnf}`);
    lcovLines.push(`FNH:${fnh}`);
    // lines
    const lineNos = [...rec.lineHits.keys()].sort((a, b) => a - b);
    for (const ln of lineNos) lcovLines.push(`DA:${ln},${rec.lineHits.get(ln)}`);
    const lf = lineNos.length;
    const lh = lineNos.filter((ln) => rec.lineHits.get(ln) > 0).length;
    lcovLines.push(`LF:${lf}`);
    lcovLines.push(`LH:${lh}`);
    lcovLines.push("end_of_record");
    totLF += lf;
    totLH += lh;
    totFNF += fnf;
    totFNH += fnh;
    summaryRows.push({ rel, lf, lh, fnf, fnh });
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, lcovLines.join("\n") + "\n", "utf8");

  // ---- print summary ----
  const pct = (h, f) => (f === 0 ? "n/a" : `${((100 * h) / f).toFixed(2)}%`);
  console.log("");
  console.log("src/ coverage (server-side V8, rendered from NODE_V8_COVERAGE)");
  console.log("-".repeat(72));
  for (const r of summaryRows) {
    console.log(
      `${r.rel.padEnd(48)} lines ${String(r.lh).padStart(5)}/${String(r.lf).padStart(5)} ${pct(r.lh, r.lf).padStart(7)}  fns ${r.fnh}/${r.fnf}`,
    );
  }
  console.log("-".repeat(72));
  console.log(
    `${"TOTAL".padEnd(48)} lines ${String(totLH).padStart(5)}/${String(totLF).padStart(5)} ${pct(totLH, totLF).padStart(7)}  fns ${totFNH}/${totFNF}`,
  );
  console.log("");
  console.log(`files: ${summaryRows.length}   lcov written: ${path.relative(args.root, outFile).replace(/\\/g, "/")}`);
}

main();
