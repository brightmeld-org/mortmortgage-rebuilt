// Strict request-schema conventions (SEC-18, AC-56, NFR-019).
//
// Every request-body schema in this build is a STRICT zod object — unknown fields
// are rejected with the contract's "validation error" shape (400 ErrorResponse with
// details[] listing field errors). Routes call the shared guard FIRST
// (src/lib/guard.ts — auth before body parsing, SEC-19), then parseBody.
//
// Conventions:
//   - Build schemas with `strictSchema({...shape})`, or wrap an existing object
//     schema with `strict(schema)`. Never use bare z.object() for request bodies.
//   - Field names/enum literals mirror contracts.json exactly — schemas are the
//     serialization contract, not an approximation.

import { z } from "zod";
import { requestIdFrom, validationError } from "@/lib/http/errors";

/** Build a strict zod object schema — unknown fields rejected (AC-56 / SEC-18). */
export function strictSchema<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

/** Enforce .strict() on an existing object schema (for composed/extended schemas). */
export function strict<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.strict();
}

/** Flatten zod issues into the contract's details[] strings ("path: message"). */
export function zodIssuesToDetails(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(body)";
    return `${path}: ${issue.message}`;
  });
}

export type ParseBodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

/**
 * Parse and validate a JSON request body against a schema. Failures — malformed
 * JSON, missing fields, wrong types, UNKNOWN FIELDS — return the contract's 400
 * ErrorResponse with details[] (never throws).
 */
export async function parseBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<ParseBodyResult<z.infer<S>>> {
  const requestId = requestIdFrom(request);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: validationError(["(body): request body must be valid JSON"], requestId),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: validationError(zodIssuesToDetails(parsed.error), requestId) };
  }
  return { ok: true, data: parsed.data };
}
