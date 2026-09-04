// PUT /api/profile/notification-preferences — contracts §B:
// NotificationPreferencesRequest -> UserProfile 200 (roleGate ["borrower"];
// errors: validation error, 403). REQ-041, VR-029/VR-030.

import { logged } from "@/lib/log";
import { guard } from "@/lib/guard";
import { parseBody } from "@/lib/http/validation";
import { requestIdFrom, validationError } from "@/lib/http/errors";
import { requestMeta } from "@/lib/http/client-ip";
import { notificationPreferencesRequestSchema } from "@/lib/schemas/auth";
import { updateNotificationPreferences } from "@/lib/services/profile";

async function PUT_impl(request: Request): Promise<Response> {
  const guarded = await guard(request, { roleGate: ["borrower"] });
  if (!guarded.ok) return guarded.response;
  const { user } = guarded.ctx;

  const parsed = await parseBody(request, notificationPreferencesRequestSchema);
  if (!parsed.ok) return parsed.response;

  const result = await updateNotificationPreferences(
    { userId: user.userId, role: user.role },
    parsed.data,
    requestMeta(request),
  );
  if (!result.ok) return validationError(result.details, requestIdFrom(request)); // VR-030
  return Response.json(result.profile);
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const PUT = logged(PUT_impl);
