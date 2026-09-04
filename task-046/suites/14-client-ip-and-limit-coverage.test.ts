/**
 * §7.7 — INV-042 / REQ-018 MECHANISM-COVERAGE GUARD (source scan, no server needed).
 *
 * Both LENS-002 and LENS-003 were the same failure shape: one mechanism, several
 * call sites, one omission. LENS-003 was a surviving leftmost-X-Forwarded-For read
 * in src/app/api/admin/config/route.ts that the CH-006 fix missed; LENS-002 was the
 * one contracted 429 endpoint (document upload) that never got an enforceRateLimit
 * call when the limiter moved out of middleware in task-008.
 *
 * A one-line fix to each would leave the NEXT omission just as invisible, so this
 * file makes the omission itself impossible to add silently. It is a SOURCE SCAN,
 * deliberately: an HTTP test can only observe the call sites it already knows about,
 * whereas the defect is always the call site nobody thought of. It runs offline and
 * needs neither the dev server nor the database.
 *
 * Three assertions:
 *
 *   1. CLIENT-IP HEADERS ARE READ IN EXACTLY ONE PLACE. No server-side source file
 *      outside src/lib/http/client-ip.ts may read x-forwarded-for, x-real-ip,
 *      cf-connecting-ip, true-client-ip, the RFC 7239 `forwarded` header, or
 *      socket.remoteAddress. That single module is the only thing that honours the
 *      TRUST_PROXY gate and indexes X-Forwarded-For from the RIGHT; every other
 *      reader is a bypass by construction. Comments and strings are stripped before
 *      scanning, so the modules that *document* the rule are not flagged for doing so.
 *
 *   2. EVERY AUDIT / SESSION `ip:` VALUE TRACES BACK TO THAT RESOLVER. Each `ip:`
 *      property in src/ must be null, a type declaration, a member of a passed-in
 *      request-meta bundle, or a direct requestMeta()/clientIpFrom() call. Anything
 *      else — a header read, a body field, a client-supplied value — fails here with
 *      its file:line.
 *
 *   3. EVERY CONTRACTED 429 ENDPOINT ACTUALLY CALLS enforceRateLimit. The endpoint
 *      list comes from contracts.json, not from a hand-maintained array, so adding a
 *      429 to the contract without wiring the limiter fails this test — which is
 *      exactly what LENS-002 was.
 *
 *   4. THE LIMITER FAILS CLOSED WHEN NO DIMENSION RESOLVES (LENS-016, INV-042/CH-019).
 *      Presence of an enforceRateLimit call is not enough: consumeRateLimit used to
 *      return allowed:true unconditionally when neither an account nor a client IP
 *      resolved, so under the shipped TRUST_PROXY=false the six token-only/anonymous
 *      contracted-429 endpoints could never fire (70 unthrottled requests against a
 *      60/min limit, live-proven). This asserts, BEHAVIOURALLY, that an unkeyed
 *      request is counted against a scope-global bucket and refused over its limit —
 *      never allowed for lack of anything to key on — plus a source guard that the
 *      fail-closed fallback is present. This is the one assertion group here that
 *      touches the database (the fail-open is a runtime property, not a source shape).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { endpoints } from "../helpers/contract.js";
import { consumeRateLimit } from "@/lib/services/rate-limit";
import { prisma } from "@/lib/prisma";

const ROOT = process.cwd();

/** Server-side source trees. Test harnesses are excluded on purpose: a test CLIENT
 *  legitimately SETS x-forwarded-for on an outgoing request (that is how the
 *  limiter's IP dimension is exercised); only server code must never READ it. */
const SCAN_ROOTS = ["src", "prisma", "scripts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".js", ".jsx"]);

/** The ONE sanctioned client-IP resolver. */
const RESOLVER = join("src", "lib", "http", "client-ip.ts");

interface SourceFile {
  /** Repo-relative, OS-native separators. */
  path: string;
  /** Repo-relative with forward slashes, for stable messages. */
  display: string;
  /** Original text, split into 1-indexed-able lines. */
  lines: string[];
  /** Text with comments and string/template literals blanked out, same line count. */
  scrubbedLines: string[];
}

function listSourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".next" || entry === "migrations") continue;
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) {
        visit(full);
        continue;
      }
      const dot = entry.lastIndexOf(".");
      if (dot < 0 || !SOURCE_EXTENSIONS.has(entry.slice(dot))) continue;
      const text = readFileSync(full, "utf8");
      const rel = relative(ROOT, full);
      out.push({
        path: rel,
        display: rel.split(sep).join("/"),
        lines: text.split("\n"),
        scrubbedLines: scrub(text).split("\n"),
      });
    }
  };
  for (const root of SCAN_ROOTS) visit(join(ROOT, root));
  return out;
}

/**
 * Blank out COMMENTS ONLY, preserving every newline so line numbers stay exact.
 *
 * String literals are deliberately KEPT: a header read is spelled
 * `headers.get("x-forwarded-for")`, so blanking string contents would make the very
 * defect this file exists to catch invisible — that is not hypothetical, it is what
 * the first draft of this scanner did. Strings are still PARSED (not just ignored)
 * so that a `//` inside a literal is never mistaken for the start of a comment.
 * Blanking comments is what keeps the modules that DOCUMENT the rule in prose from
 * being flagged for describing it.
 */
function scrub(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  const keep = (ch: string): void => {
    out += ch === "\n" ? "\n" : " ";
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") keep(text[i++]);
      continue;
    }
    if (ch === "/" && next === "*") {
      keep(text[i++]);
      keep(text[i++]);
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) keep(text[i++]);
      if (i < n) {
        keep(text[i++]);
        keep(text[i++]);
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (text[i] === "\\") {
          out += text[i];
          if (i + 1 < n) out += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        out += text[i];
        i += 1;
      }
      if (i < n) {
        out += text[i];
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

interface Hit {
  display: string;
  line: number;
  text: string;
}

function scanLines(files: SourceFile[], pattern: RegExp, onlyScrubbed = true): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const source = onlyScrubbed ? file.scrubbedLines : file.lines;
    source.forEach((line, index) => {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        hits.push({ display: file.display, line: index + 1, text: file.lines[index]!.trim() });
      }
    });
  }
  return hits;
}

const report = (hits: Hit[]): string =>
  hits.map((hit) => `  ${hit.display}:${hit.line}  ${hit.text.slice(0, 160)}`).join("\n");

const files = listSourceFiles();

describe("INV-042 the client-IP header is read in exactly one module", () => {
  test("the sanctioned resolver is present and is the module we think it is", () => {
    const resolver = files.find((file) => file.path === RESOLVER);
    assert.ok(resolver, `${RESOLVER.split(sep).join("/")} must exist — it is the only sanctioned client-IP resolver`);
    const text = resolver.lines.join("\n");
    assert.match(text, /export function clientIpFrom\(/, "clientIpFrom must live in the resolver");
    assert.match(text, /export function requestMeta\(/, "requestMeta must live in the resolver");
    assert.match(text, /trustProxyEnabled\(\)/, "the resolver must consult the TRUST_PROXY gate");
  });

  test("no other server-side file reads a client-IP header", () => {
    // Any of the forgeable client-IP carriers, plus the socket peer address.
    const header =
      /\b(x-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip|x-client-ip|x-cluster-client-ip|fastly-client-ip|forwarded-for)\b|\bheaders\s*(\.get\s*\(|\[)\s*$|socket\s*(\?\.)?\s*\.\s*remoteAddress|\bheaders\.get\(\s*["'`]forwarded["'`]\s*\)/i;
    const offenders = scanLines(
      files.filter((file) => file.path !== RESOLVER),
      header,
    ).filter((hit) => !/\bheaders\s*(\.get\s*\(|\[)\s*$/.test(hit.text));

    assert.deepEqual(
      offenders.map((hit) => `${hit.display}:${hit.line}`),
      [],
      "client-IP headers may ONLY be read by src/lib/http/client-ip.ts, which honours TRUST_PROXY and " +
        "indexes X-Forwarded-For from the RIGHT (INV-042). Route these through requestMeta(request):\n" +
        report(offenders),
    );
  });

  test("the leftmost-entry pattern appears nowhere, including in the resolver", () => {
    // The exact CH-006 defect shape: split the header and take element 0.
    const leftmost = /\.split\(\s*","\s*\)\s*(\[\s*0\s*\]|\?\.\[\s*0\s*\])/;
    const offenders = scanLines(files, leftmost).filter((hit) =>
      /forward|xff|clientIp|\bip\b/i.test(hit.text),
    );
    assert.deepEqual(
      offenders.map((hit) => `${hit.display}:${hit.line}`),
      [],
      "the leftmost X-Forwarded-For entry is caller-controlled — index from the RIGHT (INV-042):\n" +
        report(offenders),
    );
  });
});

describe("INV-042 every recorded ip value traces to the sanctioned resolver", () => {
  /**
   * Provenance shapes an `ip:` value is allowed to have. Everything here is either a
   * type declaration, a null, or a value that entered the process through
   * requestMeta()/clientIpFrom() — the resolver — and was passed down by parameter.
   */
  const ALLOWED: RegExp[] = [
    /^string \| null$/, //                                                  type declaration
    /^null$/, //                                                            explicit absence
    /^requestMeta\( ?\w+ ?\)\.ip$/, //                                      direct resolver call
    /^clientIpFrom\( ?\w+ ?\)( \?\? null)?$/, //                            direct resolver call
    // A member of a request-meta bundle threaded in as a parameter. The bundle can
    // only have been built by requestMeta() — assertion group 1 guarantees no other
    // code in the tree can produce an IP at all.
    /^\w+\??\.ip( \?\? null)?$/,
    /^\w+\??\.meta\??\.ip( \?\? null)?$/,
  ];

  /**
   * Values that are NOT request-derived and are correct as literals. Each needs a
   * reason; an unexplained literal IP anywhere else still fails.
   */
  const LITERAL_ALLOWLIST: Record<string, string> = {
    "src/lib/services/demo-seed/dataset.ts":
      "REQ-066 §4.6.12 demo dataset — synthetic RFC 5737 TEST-NET-3 addresses baked into seeded audit/session rows. " +
      "These are seed DATA written by the seeder, never derived from an inbound request, so the resolver has no role here.",
  };

  test("no ip: value is built from anything but the resolver", () => {
    const bad: Hit[] = [];
    for (const file of files) {
      file.scrubbedLines.forEach((scrubbed, index) => {
        // Read the KEY from the scrubbed line so an `ip:` written in a comment is not
        // mistaken for a call site; the VALUE is read from the original line.
        if (!/(^|[\s({[,])ip\s*:/.test(scrubbed)) return;
        const raw = file.lines[index]!.trim();
        // Value = everything up to the property separator / end of the object literal.
        const value = (/\bip\s*:\s*([^,;}]*)/.exec(raw)?.[1] ?? "").replace(/\s+/g, " ").trim();
        if (ALLOWED.some((rule) => rule.test(value))) return;
        if (LITERAL_ALLOWLIST[file.display] && /^["'`]/.test(value)) return;
        bad.push({ display: file.display, line: index + 1, text: raw });
      });
    }
    assert.deepEqual(
      bad.map((hit) => `${hit.display}:${hit.line}`),
      [],
      "every audit/session ip value must come from requestMeta(request) or a request-meta bundle passed down " +
        "from it — never from a header, a body field or any other caller-supplied source (INV-042):\n" +
        report(bad),
    );
  });

  test("each allowlisted literal-IP file still carries its justification", () => {
    for (const [path, reason] of Object.entries(LITERAL_ALLOWLIST)) {
      assert.ok(
        files.some((file) => file.display === path),
        `allowlisted file no longer exists — delete the entry: ${path}`,
      );
      assert.ok(reason.length > 60, `allowlist entry ${path} needs a contract-derived justification`);
    }
  });
});

describe("REQ-018 every contracted 429 endpoint enforces the limit", () => {
  /** contracts.json path -> the App Router file that implements it. */
  function routeFileFor(path: string): string {
    const segments = path
      .replace(/^\//, "")
      .split("/")
      .map((segment) => (segment.startsWith(":") ? `[${segment.slice(1)}]` : segment));
    return ["src", "app", ...segments, "route.ts"].join("/");
  }

  const limited = endpoints.filter((endpoint) => endpoint.errorCodes.some((code) => String(code) === "429"));

  test("the contract still declares a 429 endpoint set to check", () => {
    assert.ok(limited.length >= 16, `expected the §4.1.9 429 set, found ${limited.length}`);
  });

  test("each one calls enforceRateLimit in its own route handler", () => {
    const gaps: string[] = [];
    for (const endpoint of limited) {
      const display = routeFileFor(endpoint.path);
      const file = files.find((candidate) => candidate.display === display);
      if (!file) {
        gaps.push(`${endpoint.method} ${endpoint.path} -> ${display} (route file not found)`);
        continue;
      }
      const body = file.scrubbedLines.join("\n");
      if (!/\benforceRateLimit\s*\(/.test(body)) {
        gaps.push(`${endpoint.method} ${endpoint.path} -> ${display} (no enforceRateLimit call)`);
      }
    }
    assert.deepEqual(
      gaps,
      [],
      "contracts.json declares 429 on these endpoints but no limiter is wired in the handler " +
        "(the limiter left middleware in task-008 — enforcement is per-route now):\n  " +
        gaps.join("\n  "),
    );
  });

  test("the limiter enforces BEFORE the request body or upload is parsed", () => {
    // Ordering matters as much as presence: an over-budget caller must not reach the
    // multipart parse, the storage write or the OCR enqueue.
    const offenders: string[] = [];
    for (const endpoint of limited) {
      const display = routeFileFor(endpoint.path);
      const file = files.find((candidate) => candidate.display === display);
      if (!file) continue;
      const body = file.scrubbedLines.join("\n");
      const limit = body.indexOf("enforceRateLimit(");
      const upload = body.indexOf("parseUploadForm(");
      if (limit >= 0 && upload >= 0 && upload < limit) {
        offenders.push(`${display}: parseUploadForm runs before enforceRateLimit`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });
});

describe("LENS-016 the limiter fails CLOSED when no dimension resolves (INV-042/CH-019)", () => {
  // A synthetic scope-global bucket no HTTP suite exercises, so this cannot poison
  // another suite's anonymous public-calculator traffic. Purged before and after.
  const PROBE_GLOBAL_KEY = "sms-verification|global";
  async function purge(): Promise<void> {
    try {
      await prisma.rateLimitBucket.deleteMany({ where: { key: PROBE_GLOBAL_KEY } });
    } catch {
      // best-effort — a purge failure must not mask the assertion
    }
  }
  before(purge);
  after(purge);

  test("source guard: consumeRateLimit carries the scope-global fail-closed fallback", () => {
    const rl = files.find((f) => f.display === "src/lib/services/rate-limit.ts");
    assert.ok(rl, "rate-limit.ts must exist");
    const scrubbed = rl.scrubbedLines.join("\n");
    // Strings are preserved by scrub(), so the fallback key literal is visible.
    assert.match(
      scrubbed,
      /\|global/,
      "the fail-closed scope-global fallback (`${scope}|global`) must be present in consumeRateLimit — " +
        "LENS-016 returned allowed:true when keys.length === 0 instead",
    );
    // The old fail-open shape: an empty-keys branch returning an allow verdict.
    const emptyKeys = scrubbed.indexOf("length === 0");
    if (emptyKeys >= 0) {
      const window = scrubbed.slice(emptyKeys, emptyKeys + 160);
      assert.ok(
        !/allowed:\s*true/.test(window),
        "consumeRateLimit must NOT return allowed:true on a zero-dimension request (fail-open, LENS-016)",
      );
    }
  });

  test("behavioural: an unkeyed request is refused over its limit, never unconditionally allowed", { timeout: 120000 }, async () => {
    await purge();
    // First call establishes the live configured limit (auth policy default 10/15min).
    const first = await consumeRateLimit("sms-verification", "auth", null, null);
    assert.ok(first.count >= 1, "a zero-dimension request must be COUNTED — LENS-016 counted nothing (count:0)");
    const limit = first.limit;
    // Drive 2*limit+4 more. Any fixed-window boundary split of the total leaves at
    // least one window above `limit`, so a refusal is guaranteed regardless of the
    // configured limit or when in the window the run starts.
    let allowed = 1; // the first call
    let refused = first.allowed ? 0 : 1;
    for (let i = 0; i < 2 * limit + 4; i++) {
      const v = await consumeRateLimit("sms-verification", "auth", null, null);
      if (v.allowed) allowed++;
      else refused++;
    }
    assert.ok(
      refused > 0,
      `a zero-dimension request must FAIL CLOSED: ${allowed} allowed / ${refused} refused across ${2 * limit + 5} calls ` +
        `(limit ${limit}). LENS-016 allowed every one.`,
    );
    // The scope-global bucket row must actually exist in the store.
    const rows = await prisma.rateLimitBucket.findMany({ where: { key: PROBE_GLOBAL_KEY } });
    assert.ok(
      rows.length > 0,
      "a scope-global bucket row must be written for an unkeyed request (LENS-016 wrote no bucket at all)",
    );
  });
});
