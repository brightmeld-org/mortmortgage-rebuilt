/**
 * SystemConfig access through the contracted supervisor endpoints
 * (GET/PUT /api/admin/config). Suites that probe a configurable boundary flip the
 * threshold here and restore it in after().
 */
import { GET, PUT, expectOk, type Session } from "./http.js";

export interface ConfigSetting {
  key: string;
  value: string;
  description?: string;
  updatedByName?: string;
  updatedAt?: string;
}

interface SystemConfigResponse {
  settings: ConfigSetting[];
}

export async function readConfig(supervisor: Session): Promise<Map<string, string>> {
  const result = await GET<SystemConfigResponse>("/api/admin/config", { session: supervisor });
  const body = expectOk(result, "GET /api/admin/config", 200);
  return new Map(body.settings.map((setting) => [setting.key, setting.value]));
}

export async function readSetting(supervisor: Session, key: string): Promise<string> {
  const settings = await readConfig(supervisor);
  const value = settings.get(key);
  if (value === undefined) throw new Error(`SystemConfig key not present: ${key}`);
  return value;
}

/** `value` is the JSON-encoded setting value per ConfigSetting/VR-125. */
export async function writeSetting(supervisor: Session, key: string, value: string): Promise<void> {
  const result = await PUT("/api/admin/config", { session: supervisor, body: { key, value } });
  expectOk(result, `PUT /api/admin/config ${key}`, 200);
}

/** Contract-documented §4.6.11 default for the auth attempt cap. */
export const DEFAULT_AUTH_ATTEMPTS = "10";

/** Headroom used while suites register their fixture accounts. */
export const HEADROOM_ATTEMPTS = "400";

/**
 * Raises the auth rate-limit cap so fixture registration/verification/demo-login does
 * not trip the 10-per-15-minute production limit while suites build their data.
 *
 * Deliberately NOT restored per file: the cap is global, the files run serially, and
 * restoring between files would make the next file's very first demo-login race the
 * shared bucket. The documented default is restored once, at the end of the run, by
 * `zzz-rate-limit-and-config-restore.test.ts` — which is also where the limit itself
 * (and its persistence across restart, REQ-018/SEC-11) is exercised.
 */
export async function ensureAuthHeadroom(supervisor: Session): Promise<void> {
  const current = await readSetting(supervisor, "rateLimit.authAttempts");
  if (current !== HEADROOM_ATTEMPTS) {
    await writeSetting(supervisor, "rateLimit.authAttempts", HEADROOM_ATTEMPTS);
  }
}
