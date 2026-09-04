// GET/PUT /api/admin/config (contracts §B, task-004, REQ-065).
//
// roleGate ["supervisor"] via the shared guard FIRST — 401/403 before any body
// parsing (SEC-19); PUT additionally requires the session-bound CSRF token.
// Admin endpoints use the exact same guard/audit/error paths as everything else
// (admin-endpoint invariant).
//
// GET → SystemConfigResponse (200; 401/403)
// PUT ConfigUpdateRequest → SystemConfigResponse (200; validation error, 403)

import { logged } from "@/lib/log";
import { z } from "zod";
import { guard } from "@/lib/guard";
import { requestMeta } from "@/lib/http/client-ip";
import { parseBody, strictSchema } from "@/lib/http/validation";
import { validationError } from "@/lib/http/errors";
import {
  CONFIG_VALUE_MAX_ENCODED_LENGTH,
  ConfigValidationError,
  getSystemConfigResponse,
  updateSetting,
} from "@/lib/services/config";

async function GET_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["supervisor"] });
  if (!guarded.ok) return guarded.response;

  return Response.json(await getSystemConfigResponse());
}

/** contracts.json ConfigUpdateRequest — exact field names; unknown fields rejected. */
const configUpdateRequestSchema = strictSchema({
  key: z.string().min(1, "key is required (VR-124)"),
  value: z
    .string()
    .min(1, "value is required (VR-125)")
    .max(
      CONFIG_VALUE_MAX_ENCODED_LENGTH,
      `JSON-encoded value exceeds ${CONFIG_VALUE_MAX_ENCODED_LENGTH} characters (VR-125)`,
    ),
});

async function PUT_impl(request: Request): Promise<Response> {
  // Guard FIRST — auth + role + CSRF before the body is touched (SEC-19).
  const guarded = await guard(request, { roleGate: ["supervisor"], csrf: true });
  if (!guarded.ok) return guarded.response;
  const { user, requestId } = guarded.ctx;

  const parsed = await parseBody(request, configUpdateRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    // INV-042: the audit `ip` comes from the ONE sanctioned resolver
    // (src/lib/http/client-ip.ts), which honours the TRUST_PROXY gate and indexes
    // X-Forwarded-For from the RIGHT. Reading the header here — and especially its
    // leftmost, caller-written entry — would let any caller forge the IP on this
    // config-change AuditLogEntry and poison the SEC-8 forensic record.
    await updateSetting(user, parsed.data.key, parsed.data.value, {
      ip: requestMeta(request).ip,
      requestId: requestId ?? null,
    });
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return validationError(error.details, requestId);
    }
    throw error;
  }

  return Response.json(await getSystemConfigResponse());
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
export const PUT = logged(PUT_impl);
