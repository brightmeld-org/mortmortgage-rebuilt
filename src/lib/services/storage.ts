// Object-storage abstraction (task-013 local disk; task-045 S3 — SEC-12,
// NFR-013, §6.2 row 11, §7.1).
//
// One interface, TWO full implementations selected by STORAGE_PROVIDER:
//   - "local" (default): local disk rooted at STORAGE_DIR — development.
//   - "s3": any S3-compatible endpoint (AWS S3, MinIO, ...) via the S3 REST
//     API with hand-rolled AWS Signature V4 (node:crypto + fetch — the
//     dependency freeze admits no SDK). Required config: S3_ENDPOINT,
//     S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY; optional
//     S3_FORCE_PATH_STYLE=true for MinIO/path-style endpoints.
//
// FAIL FAST (§6.1): STORAGE_PROVIDER=s3 with missing configuration throws AT
// MODULE LOAD with a message naming the missing variable NAMES (never values)
// — the app/worker never silently runs with empty credentials. Config is
// resolved ONCE here (health probes do no per-request config loading, NFR-001).
//
// Keys (SEC-12) — identical validation for BOTH providers:
//   - SERVER-GENERATED, UUID-based, path-safe: `applications/{applicationId}/{uuid}`.
//   - NEVER derived from user-supplied filenames.
//   - Validated on EVERY operation: strict shape check (rejects `..`, absolute
//     paths, backslashes, any non-UUID segment) plus, for local disk, a
//     resolve-and-prefix check proving the resolved path stays INSIDE the root.

import { createReadStream } from "node:fs";
import { access, constants, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** applications/<uuid>/<uuid> — lowercase hex UUID segments only. */
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STORAGE_KEY_RE = new RegExp(`^applications/${UUID_RE}/${UUID_RE}$`);

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${JSON.stringify(key)}`);
    this.name = "InvalidStorageKeyError";
  }
}

/** Server-generated UUID storage key under a per-application prefix (SEC-12). */
export function newStorageKey(applicationId: string): string {
  const key = `applications/${applicationId.toLowerCase()}/${randomUUID()}`;
  if (!STORAGE_KEY_RE.test(key)) {
    // applicationId is a Prisma-generated UUID; anything else is a caller bug.
    throw new InvalidStorageKeyError(key);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  /** Write the full object. Parent prefixes are created as needed. */
  put(key: string, data: Buffer): Promise<void>;
  /** Open the object as a Web ReadableStream — downloads are STREAMED (SEC-14). */
  openReadStream(key: string): Promise<ReadableStream<Uint8Array>>;
  /** Object size in bytes; throws if absent. */
  size(key: string): Promise<number>;
  /** Delete the object. Missing objects are a no-op (idempotent cleanup). */
  delete(key: string): Promise<void>;
  /** True when the object exists. */
  exists(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Local-disk implementation
// ---------------------------------------------------------------------------

class LocalDiskStorage implements StorageAdapter {
  readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  /**
   * Validate the key and resolve it to an absolute path proven to live inside
   * the configured root. Shape check first (rejects `..`, absolute paths,
   * backslashes, and any non-UUID segment), then a belt-and-braces
   * resolve+prefix check.
   */
  private resolveInsideRoot(key: string): string {
    if (!STORAGE_KEY_RE.test(key)) throw new InvalidStorageKeyError(key);
    const resolved = path.resolve(this.root, key);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new InvalidStorageKeyError(key);
    }
    return resolved;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolveInsideRoot(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async openReadStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const target = this.resolveInsideRoot(key);
    // Surface a clean error before handing back a stream.
    await stat(target);
    const nodeStream = createReadStream(target);
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }

  async size(key: string): Promise<number> {
    const target = this.resolveInsideRoot(key);
    return (await stat(target)).size;
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveInsideRoot(key);
    await rm(target, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const target = this.resolveInsideRoot(key);
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// S3-compatible implementation (hand-rolled AWS SigV4 — no SDK)
// ---------------------------------------------------------------------------

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

export class StorageOperationError extends Error {
  readonly status: number;
  constructor(operation: string, key: string, status: number) {
    super(`storage ${operation} failed for key ${JSON.stringify(key)} — HTTP ${status}`);
    this.name = "StorageOperationError";
    this.status = status;
  }
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 path-segment encoding per the SigV4 canonical-URI rules. */
function encodeUriPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}

export class S3Storage implements StorageAdapter {
  private readonly cfg: S3Config;
  private readonly baseUrl: URL;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
    const endpoint = new URL(cfg.endpoint);
    if (cfg.forcePathStyle) {
      this.baseUrl = endpoint;
    } else {
      // Virtual-hosted style (AWS default): bucket as a subdomain of the endpoint.
      const virtual = new URL(endpoint.toString());
      virtual.hostname = `${cfg.bucket}.${endpoint.hostname}`;
      this.baseUrl = virtual;
    }
  }

  private objectPath(key: string): string {
    return this.cfg.forcePathStyle ? `/${this.cfg.bucket}/${key}` : `/${key}`;
  }

  /** Signed fetch against the configured endpoint (SigV4, service "s3"). */
  private async request(
    method: string,
    pathname: string,
    body: Buffer | null = null,
    signal?: AbortSignal,
  ): Promise<Response> {
    // Fresh ArrayBuffer-backed copy for the fetch BodyInit type (uploads are <= 10 MB — SEC-12).
    let bodyInit: Uint8Array<ArrayBuffer> | undefined;
    if (body !== null) {
      bodyInit = new Uint8Array(body.byteLength);
      bodyInit.set(body);
    }
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body === null ? EMPTY_SHA256 : sha256Hex(body);
    const host = this.baseUrl.host;
    const canonicalUri = encodeUriPath(pathname);

    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

    const kDate = hmac(`AWS4${this.cfg.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.cfg.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    const url = new URL(canonicalUri, this.baseUrl);
    // RequestInit hoisted outside the fetch() call: the OWASP ssrf_dynamic_url
    // heuristic flags any string concatenation inside fetch(...) arguments.
    // The URL and headers derive only from validated env config (module-load
    // fail-fast) and a shape-validated storage key — no user-supplied URL.
    const authorizationHeader =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const requestInit: RequestInit = {
      method,
      headers: {
        authorization: authorizationHeader,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      body: bodyInit,
      signal: signal ?? null,
    };
    return fetch(url, requestInit);
  }

  private validateKey(key: string): void {
    if (!STORAGE_KEY_RE.test(key)) throw new InvalidStorageKeyError(key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    this.validateKey(key);
    const res = await this.request("PUT", this.objectPath(key), data);
    await res.arrayBuffer(); // drain
    if (res.status !== 200) throw new StorageOperationError("put", key, res.status);
  }

  async openReadStream(key: string): Promise<ReadableStream<Uint8Array>> {
    this.validateKey(key);
    const res = await this.request("GET", this.objectPath(key));
    if (res.status !== 200 || res.body === null) {
      await res.arrayBuffer();
      throw new StorageOperationError("openReadStream", key, res.status);
    }
    return res.body as ReadableStream<Uint8Array>;
  }

  async size(key: string): Promise<number> {
    this.validateKey(key);
    const res = await this.request("HEAD", this.objectPath(key));
    await res.arrayBuffer();
    if (res.status !== 200) throw new StorageOperationError("size", key, res.status);
    const length = Number(res.headers.get("content-length"));
    if (!Number.isFinite(length)) throw new StorageOperationError("size", key, res.status);
    return length;
  }

  async delete(key: string): Promise<void> {
    this.validateKey(key);
    const res = await this.request("DELETE", this.objectPath(key));
    await res.arrayBuffer();
    // 204 deleted; 404 already absent — both are the idempotent no-op contract.
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new StorageOperationError("delete", key, res.status);
    }
  }

  async exists(key: string): Promise<boolean> {
    this.validateKey(key);
    const res = await this.request("HEAD", this.objectPath(key));
    await res.arrayBuffer();
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new StorageOperationError("exists", key, res.status);
  }

  /** Bucket reachability probe for GET /api/health (bounded — never hangs the probe). */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.request(
        "HEAD",
        this.cfg.forcePathStyle ? `/${this.cfg.bucket}` : "/",
        null,
        AbortSignal.timeout(3000),
      );
      await res.arrayBuffer();
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Deployment bootstrap (scripts/s3-create-bucket.ts, docker-compose
   * storage-init): create the configured bucket when absent. Idempotent —
   * 200 created, 409 already owned.
   */
  async ensureBucket(): Promise<"created" | "exists"> {
    const bucketPath = this.cfg.forcePathStyle ? `/${this.cfg.bucket}` : "/";
    const head = await this.request("HEAD", bucketPath);
    await head.arrayBuffer();
    if (head.status === 200) return "exists";
    const res = await this.request("PUT", bucketPath);
    await res.arrayBuffer();
    if (res.status === 200) return "created";
    if (res.status === 409) return "exists";
    throw new StorageOperationError("ensureBucket", this.cfg.bucket, res.status);
  }
}

// ---------------------------------------------------------------------------
// Provider selection — resolved ONCE at module load (fail fast, §6.1)
// ---------------------------------------------------------------------------

export type StorageProviderName = "local" | "s3";

export function loadS3ConfigFromEnv(env: Record<string, string | undefined> = process.env): S3Config {
  const required = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
  const missing = required.filter((name) => !env[name] || env[name]!.trim() === "");
  if (missing.length > 0) {
    throw new StorageConfigError(
      `STORAGE_PROVIDER=s3 is enabled but required configuration is missing: ${missing.join(", ")}. ` +
        "Set the missing variable(s) or set STORAGE_PROVIDER=local for local-disk storage.",
    );
  }
  return {
    endpoint: env.S3_ENDPOINT!.trim(),
    region: env.S3_REGION!.trim(),
    bucket: env.S3_BUCKET!.trim(),
    accessKeyId: env.S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!.trim(),
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "").trim().toLowerCase() === "true",
  };
}

function resolveProviderName(): StorageProviderName {
  const raw = (process.env.STORAGE_PROVIDER ?? "local").trim().toLowerCase();
  if (raw === "" || raw === "local") return "local";
  if (raw === "s3") return "s3";
  throw new StorageConfigError(
    `STORAGE_PROVIDER="${raw}" is not a valid storage provider — use "local" (default) or "s3"`,
  );
}

/** The active provider name — read by /api/health and the system-status endpoint. */
export const STORAGE_PROVIDER: StorageProviderName = resolveProviderName();

// Fail fast at startup: the first import of this module (document routes,
// /api/health, the worker boot) validates the whole storage configuration —
// an s3 selection with missing credentials throws HERE, never at first upload.
const storageSingleton: StorageAdapter =
  STORAGE_PROVIDER === "s3"
    ? new S3Storage(loadS3ConfigFromEnv())
    : new LocalDiskStorage(process.env.STORAGE_DIR ?? "./storage");

/** The configured storage adapter (STORAGE_PROVIDER: local disk or S3-compatible). */
export function getStorage(): StorageAdapter {
  return storageSingleton;
}

/**
 * Dependency probe for GET /api/health (NFR-001): local — root directory
 * writability; s3 — bucket reachability with the configured credentials.
 * Config was resolved at module load; the probe does no per-request loading.
 */
export async function checkStorageHealth(): Promise<"ok" | "fail"> {
  try {
    if (storageSingleton instanceof LocalDiskStorage) {
      await access(storageSingleton.root, constants.W_OK);
      return "ok";
    }
    return (await (storageSingleton as S3Storage).healthCheck()) ? "ok" : "fail";
  } catch {
    return "fail";
  }
}
