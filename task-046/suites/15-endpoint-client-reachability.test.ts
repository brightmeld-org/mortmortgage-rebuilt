/**
 * §7.7 — CONTRACTED-BUT-UNREACHABLE GUARD (source scan, no server needed).
 *
 * FIVE defects in this build were the same failure shape, not five different bugs:
 * a capability that is CONTRACTED, IMPLEMENTED server-side, covered by the API
 * test suite — and reachable by no client code at all.
 *
 *   BUG-14  the invitation link had no one-click affordance
 *   BUG-24  document replacement had no rendered control
 *   BUG-26  POST /api/profile/verify-new-email had no caller AND no page route,
 *           so the borrower email-change flow could not be completed by anybody
 *   BUG-28  DELETE /api/applications/:id/bank-links/:linkId had no control
 *   BUG-33  DELETE /api/documents/:id had no control
 *
 * Every one of them passed the API suites, because an API suite calls the endpoint
 * directly — it can never notice that nothing else does. Fixing the five call sites
 * would leave the SIXTH just as invisible, so this file makes the omission itself
 * impossible to add silently.
 *
 * It is a SOURCE SCAN, deliberately, for the same reason suite 14 is: the defect is
 * always the wiring nobody thought of, and an HTTP test can only observe wiring it
 * already knows about. It runs offline and needs neither the dev server nor the
 * database.
 *
 * THE RULE: every endpoint in contracts.json is either reachable from client-side
 * code, or listed in BACKEND_ONLY with a contract-derived reason. The endpoint list
 * comes from contracts.json, never from a hand-maintained array — so adding an
 * endpoint to the contract without wiring a client path fails this test, which is
 * exactly what BUG-26/28/33 were.
 *
 * THE ALLOWLIST IS TWO-WAY. An entry is not a permanent excuse: assertion 4 fails if
 * an allowlisted endpoint ACQUIRES a client caller, so the list can never quietly
 * accumulate entries that stopped being true. Assertion 3 fails if an entry names an
 * endpoint the contract no longer has.
 *
 * WHAT THIS GUARD DOES NOT CLAIM. A string match proves a call site EXISTS; it cannot
 * prove the control that reaches it is rendered, enabled, or keyboard-operable. That
 * is the Exercise pass's job. This guard closes the specific hole those five bugs came
 * through — an endpoint with no client path whatsoever — and nothing wider.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { endpointKey, endpoints } from "../helpers/contract.js";

const ROOT = process.cwd();

/**
 * CLIENT-side source. `src` minus the server-only trees:
 *   src/app/api      — the route handlers themselves. Including them would make
 *                      every endpoint trivially "reachable" from its own handler.
 *   src/lib/services — server services. They name endpoint paths in header comments
 *                      and in outbound-message bodies; neither is a client path.
 *   src/worker       — the background job runner.
 * Everything else under src/ — pages, layouts, client components, the api helper
 * modules — is somewhere a browser-driven path can originate.
 */
const SCAN_ROOTS = ["src"];
const EXCLUDED_TREES = ["src/app/api", "src/lib/services", "src/worker"];
/**
 * src/middleware.ts runs on the edge, never in a browser, so it is not a client
 * path — but it DOES name endpoint paths as string literals (it rewrites
 * /api/auth/demo-login and /api/test/fixtures to an absent route when their
 * demo-mode gates are shut). Counting those as callers would let a genuinely
 * unreachable endpoint look wired purely because middleware gates it, which is
 * exactly the blindness this file exists to remove.
 */
const EXCLUDED_FILES = ["src/middleware.ts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".js", ".jsx"]);

/**
 * Endpoints with no client path BY DESIGN. Each needs a contract-derived reason —
 * "nothing calls it" is the defect this file exists to catch, so it is never the
 * justification for an entry here.
 */
const BACKEND_ONLY: Record<string, string> = {
  "GET /api/health":
    "NFR-001 / NFR-027 / AC-53 dependency probe. Its consumers are machines, not people: the " +
    "Dockerfile HEALTHCHECK, tools/smoke-start.js readiness polling, and whatever orchestrator runs " +
    "the container. It returns 200/503 over a HealthStatus body with no user-facing surface anywhere " +
    "in the contract — no requirement asks for a status page, and inventing one would be UI the " +
    "contract does not call for.",
  "POST /api/test/fixtures":
    "NFR-016 sanctioned TEST-ONLY seam (task-046/test-fixtures-contract.md). Explicitly NOT a product " +
    "surface: it ages existing rows and flips demo-gated runtime toggles so time-dependent §7.7 states " +
    "become reachable, and it is consumed exclusively by task-046/suites/zz-seam-*.test.ts. The route " +
    "calls notFound() and src/middleware.ts rewrites the path unless NODE_ENV !== production AND " +
    "DEMO_MODE === true, so it cannot exist in a production build at all. A client caller would be a " +
    "defect, not a fix.",
};

interface SourceFile {
  /** Repo-relative with forward slashes, for stable messages. */
  display: string;
  /** Original text, split into lines. */
  lines: string[];
  /** Text with comments blanked out, same line count. */
  scrubbedLines: string[];
}

/**
 * Blank out COMMENTS ONLY, preserving every newline so line numbers stay exact.
 * String literals are KEPT — an endpoint path IS a string literal, so blanking string
 * contents would erase the very evidence this file looks for. Strings are still PARSED
 * so a `//` inside a literal never starts a comment. Blanking comments is what stops a
 * file that merely DOCUMENTS an endpoint ("// Data: GET /api/queue/unassigned") from
 * counting as a caller — several service and component headers do exactly that, and
 * treating them as wiring would hide the next BUG-26.
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

function listClientFiles(): SourceFile[] {
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
      const rel = relative(ROOT, full).split(sep).join("/");
      const info = statSync(full);
      if (info.isDirectory()) {
        if (EXCLUDED_TREES.includes(rel)) continue;
        visit(full);
        continue;
      }
      const dot = entry.lastIndexOf(".");
      if (dot < 0 || !SOURCE_EXTENSIONS.has(entry.slice(dot))) continue;
      if (EXCLUDED_FILES.includes(rel)) continue;
      const text = readFileSync(full, "utf8");
      out.push({ display: rel, lines: text.split("\n"), scrubbedLines: scrub(text).split("\n") });
    }
  };
  for (const root of SCAN_ROOTS) visit(join(ROOT, root));
  return out;
}

/**
 * The verb-carrying helpers in this codebase's client api modules
 * (src/components/{auth,borrower,wizard,staff/detail}/api.ts). A path literal passed
 * to one of these IS a call with that method.
 */
const METHOD_HELPERS: Array<[RegExp, string]> = [
  [/\bgetJson\s*(<[^>]*>)?\s*\(/, "GET"],
  [/\bpostJsonWithCsrf\s*(<[^>]*>)?\s*\(/, "POST"],
  [/\bpostMultipartWithCsrf\s*(<[^>]*>)?\s*\(/, "POST"],
  [/\bpostWithCsrf\s*(<[^>]*>)?\s*\(/, "POST"],
  [/\bpostJson\s*(<[^>]*>)?\s*\(/, "POST"],
  [/\bputWithCsrf\s*(<[^>]*>)?\s*\(/, "PUT"],
  [/\bdeleteWithCsrf\s*(<[^>]*>)?\s*\(/, "DELETE"],
  [/\bpatchWithCsrf\s*(<[^>]*>)?\s*\(/, "PATCH"],
];
const EXPLICIT_METHOD = /(?:sendJson\s*(?:<[^>]*>)?\s*\(\s*|method\s*:\s*)["'`](GET|POST|PUT|PATCH|DELETE)["'`]/;

interface CallSite {
  method: string;
  /** The literal as written, query string stripped. */
  path: string;
  display: string;
  line: number;
  text: string;
}

/**
 * Method resolution, most specific evidence first: an explicit method on the SAME line
 * beats a helper name on the same line, which beats either one anywhere in a +/-6-line
 * window (helpers routinely wrap the path across a line break). A bare `fetch(path)`
 * with no method option is a GET, which is the web's default and this codebase's.
 *
 * The same-line-first ordering is load-bearing: src/components/wizard/api.ts declares
 * PUT, POST and DELETE co-borrower calls within six lines of each other, and a
 * window-first reader mislabels the DELETE as a PUT — which would have reported the
 * co-borrower DELETE as unreachable when it is wired correctly.
 */
function resolveMethod(line: string, windowText: string): string {
  const sameLine = EXPLICIT_METHOD.exec(line);
  if (sameLine) return sameLine[1]!;
  for (const [pattern, method] of METHOD_HELPERS) if (pattern.test(line)) return method;
  const inWindow = EXPLICIT_METHOD.exec(windowText);
  if (inWindow) return inWindow[1]!;
  for (const [pattern, method] of METHOD_HELPERS) if (pattern.test(windowText)) return method;
  return "GET";
}

function collectCallSites(files: SourceFile[]): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of files) {
    file.scrubbedLines.forEach((scrubbed, index) => {
      const literal = /["'`](\/api\/[^"'`\s]*)["'`]/g;
      let match: RegExpExecArray | null;
      while ((match = literal.exec(scrubbed)) !== null) {
        const windowText = file.scrubbedLines.slice(Math.max(0, index - 6), index + 7).join("\n");
        const bare = match[1]!.split("?")[0]!.replace(/\/+$/, "") || match[1]!;
        sites.push({
          method: resolveMethod(scrubbed, windowText),
          path: bare,
          display: file.display,
          line: index + 1,
          text: file.lines[index]!.trim(),
        });
      }
    });
  }
  return sites;
}

/**
 * Segment-wise path match. A contract ":param" matches any client segment; a client
 * segment containing a "${…}" template expression matches any contract segment —
 * `/api/queue/${tab}` really does reach both /api/queue/unassigned and /api/queue/mine,
 * and `/api/applications/${id}/exports/${key}` really does reach all three exports.
 * Both directions are needed; matching only the first would report six wired endpoints
 * as unreachable.
 */
function pathMatches(contractPath: string, clientPath: string): boolean {
  const contractSegments = contractPath.split("/");
  const clientSegments = clientPath.split("/");
  if (contractSegments.length !== clientSegments.length) return false;
  for (let i = 0; i < contractSegments.length; i += 1) {
    const expected = contractSegments[i]!;
    const actual = clientSegments[i]!;
    if (expected.startsWith(":")) continue;
    if (actual.includes("${")) continue;
    if (expected !== actual) return false;
  }
  return true;
}

const files = listClientFiles();
const callSites = collectCallSites(files);

/** endpointKey -> the client call sites that reach it. */
const reachability = new Map<string, CallSite[]>(
  endpoints.map((endpoint) => [
    endpointKey(endpoint),
    callSites.filter((site) => site.method === endpoint.method && pathMatches(endpoint.path, site.path)),
  ]),
);

const where = (sites: CallSite[]): string => sites.map((s) => `${s.display}:${s.line}`).join(", ");

describe("§7.7 the scanner itself still sees the codebase", () => {
  // A scanner that silently stops finding anything would turn this whole file green
  // while guarding nothing — the classic way a source-scan guard rots.
  test("client source files and call sites were found", () => {
    assert.ok(files.length > 60, `expected the client tree, scanned only ${files.length} files`);
    assert.ok(callSites.length > 100, `expected the api call sites, found only ${callSites.length}`);
  });

  test("the excluded server trees and files really are excluded", () => {
    const leaked = files.filter(
      (file) =>
        EXCLUDED_TREES.some((tree) => file.display.startsWith(`${tree}/`)) ||
        EXCLUDED_FILES.includes(file.display),
    );
    assert.deepEqual(leaked.map((f) => f.display), [], "server-only trees and files must not be scanned as client code");
    // The exclusions must name things that still exist, or they are silently doing nothing.
    for (const path of EXCLUDED_FILES) {
      assert.ok(existsSync(join(ROOT, path)), `excluded file no longer exists — delete the entry: ${path}`);
    }
  });

  test("known-good wiring is detected — the scanner's own positive control", () => {
    // If these three stop resolving, the scanner has broken, not the app. They cover
    // all three matching modes: a plain literal, a contract :param, and a client-side
    // template expression standing in for a literal contract segment.
    for (const key of ["POST /api/auth/sign-in", "GET /api/applications/:id", "GET /api/queue/mine"]) {
      assert.ok((reachability.get(key) ?? []).length > 0, `scanner regression: ${key} should resolve to a caller`);
    }
  });
});

describe("§7.7 every contracted endpoint is reachable from the client", () => {
  test("no endpoint is contracted, implemented, and callable by nothing", () => {
    const unreachable = endpoints
      .map((endpoint) => endpointKey(endpoint))
      .filter((key) => (reachability.get(key) ?? []).length === 0)
      .filter((key) => !(key in BACKEND_ONLY));

    assert.deepEqual(
      unreachable,
      [],
      "these endpoints are in contracts.json with no client-side call path — the BUG-26/28/33 shape. " +
        "Either wire a client path to them, or add them to BACKEND_ONLY in this file with a " +
        "contract-derived reason:\n  " +
        unreachable.join("\n  "),
    );
  });
});

describe("§7.7 the backend-only allowlist stays honest", () => {
  test("every allowlisted key is still an endpoint in the contract", () => {
    const contracted = new Set(endpoints.map((endpoint) => endpointKey(endpoint)));
    const stale = Object.keys(BACKEND_ONLY).filter((key) => !contracted.has(key));
    assert.deepEqual(stale, [], `allowlist names endpoints the contract no longer has — delete them:\n  ${stale.join("\n  ")}`);
  });

  test("every allowlist entry carries a substantive reason", () => {
    for (const [key, reason] of Object.entries(BACKEND_ONLY)) {
      assert.ok(reason.length > 120, `allowlist entry ${key} needs a contract-derived justification, not a note`);
      assert.match(
        reason,
        /\b(REQ|NFR|INT|AC|DATA|SEC|WF)-\d+/,
        `allowlist entry ${key} must cite the requirement that makes it machine-only`,
      );
    }
  });

  test("no allowlisted endpoint has quietly acquired a client caller", () => {
    // The allowlist is an assertion about the app, not a permanent waiver. If someone
    // wires a client path to one of these, the entry is now false and must be removed.
    const nowReachable = Object.keys(BACKEND_ONLY)
      .map((key) => ({ key, sites: reachability.get(key) ?? [] }))
      .filter((entry) => entry.sites.length > 0);
    assert.deepEqual(
      nowReachable.map((entry) => `${entry.key} <- ${where(entry.sites)}`),
      [],
      "these endpoints are allowlisted as backend-only but now HAVE a client caller — remove the " +
        "BACKEND_ONLY entry (or the caller, if calling it is the mistake)",
    );
  });
});
