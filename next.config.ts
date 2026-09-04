import type { NextConfig } from "next";

// Minimal config for increment 1. Security headers, CSP, and related hardening
// are owned by task-005 — do not add them here.
const nextConfig: NextConfig = {
  typedRoutes: true,
  // task-045 (§7.1 Docker): container image builds set NEXT_OUTPUT_STANDALONE=1
  // to produce the self-contained .next/standalone server (Dockerfile runner
  // stage runs `node server.js`). Unset for host workflows so `next dev` /
  // `next start` behave exactly as before.
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // Multi-instance seam (task-008, SEC-11 verification): a SECOND app instance on
  // the same working copy needs its own build dir or the two dev servers clobber
  // each other's .next artifacts. Defaults to the standard .next; production
  // deployments (one instance per container) never set this.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  experimental: {
    // INV-024 / INV-037 (task-046 fix): with middleware configured, Next clones
    // mutating request bodies with a default 10 MB cap and silently TRUNCATES
    // anything larger — which turned a legal exactly-10 MB multipart upload
    // (10,485,760-byte file + multipart envelope) into a broken formData()
    // parse (400) before the handler ever ran. Raise the cap to the configured
    // documents.maxFileSizeMb (default 10 MB) + 1 MB slack so the full request
    // reaches the handler; the app-level checks stay authoritative (413 via
    // the Content-Length fast path and the per-file size check in
    // src/lib/services/document*.ts). OPERATOR NOTE: if the
    // documents.maxFileSizeMb SystemConfig setting is raised above 10, this
    // value must be raised to match (configured MB + 1 MB slack).
    middlewareClientMaxBodySize: 11 * 1024 * 1024,
  },
  // Dev-watcher exclusions (task-047 fix). The app writes into its own project
  // directory at RUNTIME: the local storage adapter (STORAGE_DIR, default
  // ./storage) drops every uploaded document there, and operators redirect the
  // server's stdout to a log file beside package.json. Both paths sit inside
  // the webpack dev watcher's scope, so each upload / log line invalidated the
  // module graph and forced a full recompile. Under load that turned into a
  // recompile-per-request loop: page routes slowed from ~150ms to seconds and
  // intermittently 500'd with `SyntaxError: Unexpected end of JSON input` as a
  // render read a build manifest another compile was mid-way through writing.
  // watchOptions apply to `next dev` only — production builds are unaffected.
  webpack: (config, { dev }) => {
    if (dev) {
      // webpack's schema accepts only non-empty glob strings here, so the
      // inherited default (a RegExp) is restated as globs rather than spread.
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/.git/**",
          "**/node_modules/**",
          "**/.next*/**",
          // Runtime-written: uploaded document bytes (STORAGE_DIR).
          "**/storage/**",
          // Operator/CI logs redirected into the project directory.
          "**/*.log",
          // Test-harness output (Playwright artifacts, storage states, run state).
          "**/task-047/**",
          "**/verification/**",
        ],
      };
    }
    return config;
  },
};

export default nextConfig;

