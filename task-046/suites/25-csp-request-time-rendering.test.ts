/**
 * CH-024 — CSP REQUEST-TIME RENDERING RATCHET (INV-050, BUG-34).
 *
 * The SEC-17 middleware stamps EVERY response with a fresh per-request
 * `script-src 'nonce-…' 'strict-dynamic'` and forwards the nonce on the request
 * so Next nonces the scripts it renders. That mechanism only works for pages
 * rendered AT REQUEST TIME: statically prerendered HTML is frozen at build time,
 * before any nonce exists, so its script tags can never match the response's
 * CSP header and the browser blocks every _next/static chunk — no hydration, no
 * live prequal calc, no demo login (BUG-34, first seen as the public repo's CI
 * e2e failures, run 33910740894).
 *
 * The defect class is structurally invisible under `next dev` (dev renders every
 * page dynamically), which is how 87/87 dev-mode E2E specs, two Exercise passes
 * and every Lens walk shipped it. So this suite ratchets the PRODUCTION BUILD:
 *
 *   Test 1  Source guard (offline). The single root-level mechanism INV-050
 *           names — `export const dynamic = "force-dynamic"` in
 *           src/app/layout.tsx — is present, and no route segment opts back
 *           into static rendering (`force-static`, `dynamic = "error"`,
 *           `generateStaticParams`). Goes red the moment the export is deleted,
 *           no rebuild needed.
 *   Test 2  Build-output ratchet. Against the completed `next build` in .next/:
 *           zero statically prerendered HTML page routes — no text/html entry
 *           in prerender-manifest.json, no generateStaticParams-driven
 *           dynamicRoutes, no prerendered notFoundRoutes, and zero .html files
 *           under .next/server/app. (.next/server/pages/500.html is Next's
 *           internal last-resort error shell for requests that crash before
 *           rendering — not an app HTML route, carries no app JS, and exists in
 *           every Next build regardless of rendering mode; it is outside
 *           INV-050's "routes that serve HTML" scope.)
 *   Test 3  Live nonce coherence. Against the serving instance (BASE_URL):
 *           GET /pre-qualify and assert every executable <script> tag in the
 *           served HTML carries exactly the nonce declared in that response's
 *           Content-Security-Policy script-src — the precise signature BUG-34
 *           broke.
 *
 * FT-121 revert-simulation (proven once at introduction, CH-024): with the
 * layout.tsx export deleted, Test 1 fails immediately, and after a rebuild
 * Test 2 fails on the prerendered (public) pages. Restore the line and both
 * go green.
 *
 * Environment: Tests 1–2 need no server and no DB — only the repo and a
 * completed `next build`. Test 2 asserts about the LAST completed build in
 * .next/ (a dev-server-only .next fails it honestly with a "run next build"
 * message rather than passing vacuously). Test 3 needs the app serving; the
 * designed environment is production mode:
 *
 *   npm run build
 *   npx next start -p 3084          # scratch DB, per the CH-024 plan
 *   TEST_BASE_URL=http://localhost:3084 \
 *     npx tsx --env-file=.env --test task-046/suites/25-csp-request-time-rendering.test.ts
 *
 * (Under `next dev` Test 3 also passes — dev renders dynamically and nonces
 * correctly; production mode is where the ratchet has teeth.)
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BASE_URL } from "../helpers/http.js";

const ROOT = process.cwd();
const ROOT_LAYOUT = join(ROOT, "src", "app", "layout.tsx");
const NEXT_DIR = join(ROOT, ".next");

/** Recursively collect files under `dir` matching `keep`. */
function collectFiles(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}

describe("INV-050 — request-time rendering under the nonce CSP (CH-024/BUG-34)", () => {
  test("source guard: root layout forces dynamic rendering and no segment opts back into static", () => {
    const layout = readFileSync(ROOT_LAYOUT, "utf8");
    assert.match(
      layout,
      /export\s+const\s+dynamic\s*=\s*"force-dynamic"/,
      "src/app/layout.tsx must export `const dynamic = \"force-dynamic\"` — the single " +
        "root-level mechanism INV-050 names. Without it, any page that happens to be " +
        "statically prerenderable ships build-time HTML whose script tags cannot carry " +
        "the per-request CSP nonce (BUG-34).",
    );

    // No route segment may locally opt back into static rendering while the
    // nonce CSP stands. `force-static` and `dynamic = "error"` are the two
    // segment-config spellings of "prerender me"; generateStaticParams drives
    // build-time prerendering of dynamic routes.
    const sources = collectFiles(join(ROOT, "src", "app"), (name) =>
      /\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(name),
    );
    assert.ok(sources.length > 0, "src/app yielded no source files — scan is broken");

    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      if (
        /['"]force-static['"]/.test(text) ||
        /\bdynamic\s*=\s*['"]error['"]/.test(text) ||
        /\bgenerateStaticParams\b/.test(text)
      ) {
        offenders.push(relative(ROOT, file).split(sep).join("/"));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Route segments opting back into static rendering (forbidden by INV-050 while the ` +
        `per-request nonce CSP stands): ${offenders.join(", ")}`,
    );
  });

  test("build ratchet: the production build emits zero statically prerendered HTML page routes", () => {
    // Guard against asserting into the void: these files exist only after a
    // completed `next build`. A dev-only .next must FAIL, not pass vacuously —
    // dev mode is exactly where BUG-34 hid.
    const buildIdPath = join(NEXT_DIR, "BUILD_ID");
    const manifestPath = join(NEXT_DIR, "prerender-manifest.json");
    for (const required of [buildIdPath, manifestPath]) {
      assert.ok(
        existsSync(required),
        `${relative(ROOT, required)} not found — this ratchet asserts about a completed ` +
          `production build; run \`next build\` first.`,
      );
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      routes: Record<string, { initialHeaders?: Record<string, string> }>;
      dynamicRoutes: Record<string, unknown>;
      notFoundRoutes: string[];
    };

    // Anti-vacuity: the build must actually contain the app's page routes
    // (app-path-routes-manifest maps every built segment); an empty or foreign
    // .next directory is a failure of THIS suite, not a green.
    const appPaths = JSON.parse(
      readFileSync(join(NEXT_DIR, "app-path-routes-manifest.json"), "utf8"),
    ) as Record<string, string>;
    const pageCount = Object.keys(appPaths).filter((k) => k.endsWith("/page")).length;
    assert.ok(pageCount > 0, "the build contains no app page routes — wrong or empty .next");

    // (1) Nothing in the prerender manifest may serve HTML. Non-HTML static
    // routes (metadata assets like /icon.svg, content-type image/svg+xml) are
    // legitimately prerendered — they carry no scripts, so the nonce CSP does
    // not constrain them.
    const htmlRoutes = Object.entries(manifest.routes)
      .filter(([, entry]) => {
        const contentType = entry.initialHeaders?.["content-type"];
        // A prerendered page route has no content-type override (it serves the
        // build-time HTML) — treat "missing" as HTML, the unsafe direction.
        return contentType === undefined || contentType.includes("text/html");
      })
      .map(([route]) => route);
    assert.deepEqual(
      htmlRoutes,
      [],
      `Statically prerendered HTML routes in prerender-manifest.json — their build-time ` +
        `script tags can never match the per-request CSP nonce (BUG-34): ${htmlRoutes.join(", ")}`,
    );

    // (2) No generateStaticParams-driven prerendering of dynamic routes.
    assert.deepEqual(
      Object.keys(manifest.dynamicRoutes),
      [],
      "prerender-manifest.json dynamicRoutes must be empty — a generateStaticParams-driven " +
        "prerender is static HTML by another door.",
    );

    // (3) The not-found route serves HTML too; INV-050 covers it explicitly.
    assert.deepEqual(
      manifest.notFoundRoutes,
      [],
      "prerender-manifest.json notFoundRoutes must be empty — the not-found route is an " +
        "HTML route and must render at request time.",
    );

    // (4) Belt and braces on the physical artifact: prerendering an app-router
    // page writes its frozen HTML to .next/server/app/**.html.
    const frozenHtml = collectFiles(join(NEXT_DIR, "server", "app"), (name) =>
      name.endsWith(".html"),
    ).map((f) => relative(ROOT, f).split(sep).join("/"));
    assert.deepEqual(
      frozenHtml,
      [],
      `Build-time HTML emitted under .next/server/app (each is a page frozen before its ` +
        `nonce existed): ${frozenHtml.join(", ")}`,
    );
  });

  test("live coherence: every script tag on /pre-qualify carries the response's CSP nonce", async () => {
    // Page-route GET only — an HTML route, no API traffic (contracts §B posture).
    const response = await fetch(`${BASE_URL}/pre-qualify`);
    assert.equal(response.status, 200, `GET /pre-qualify returned ${response.status}`);

    const csp = response.headers.get("content-security-policy");
    assert.ok(csp, "response carries no Content-Security-Policy header (SEC-17)");
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "));
    assert.ok(scriptSrc, `CSP has no script-src directive: ${csp}`);
    const nonceMatch = scriptSrc.match(/'nonce-([A-Za-z0-9+/=]+)'/);
    assert.ok(nonceMatch, `script-src carries no nonce: ${scriptSrc}`);
    const nonce = nonceMatch[1];

    const html = await response.text();
    const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
    // Anti-vacuity: a page with no scripts at all would "cohere" trivially.
    // /pre-qualify is a hydrated client calculator — it always ships scripts.
    assert.ok(scriptTags.length > 0, "served HTML contains no <script> tags — wrong page?");

    // Non-executing script types (JSON data islands) are not subject to
    // script-src and legitimately carry no nonce.
    const executable = scriptTags.filter(
      (tag) => !/\btype\s*=\s*["'](?:application\/(?:ld\+)?json)["']/i.test(tag),
    );
    assert.ok(executable.length > 0, "no executable <script> tags found");

    const unnonced = executable.filter((tag) => !tag.includes(`nonce="${nonce}"`));
    assert.deepEqual(
      unnonced,
      [],
      `script tags whose nonce does not match the response's CSP nonce '${nonce}' — the ` +
        `browser blocks these under SEC-17 (the exact BUG-34 signature): ${unnonced.join(" | ")}`,
    );
  });
});
