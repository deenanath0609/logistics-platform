import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { z } from "zod";

/**
 * One response envelope for the whole partner API.
 *
 * Every response — success, validation failure, rate limit, crash —
 * carries a request id, in the body and in the header. When a partner
 * writes "your API returned an error at 14:32", that id is the difference
 * between a five-minute answer and an afternoon in the logs.
 */

export const REQUEST_ID_HEADER = "X-Request-Id";

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  // Distinct from `forbidden` on purpose. "Your key may not do that" is
  // something the partner can fix by asking for a wider key; "the carrier
  // does not buy this any more" is not, and a partner who cannot tell the
  // two apart spends a day on the wrong one.
  | "not_on_plan"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "conflict"
  | "server_error";

const STATUS_FOR: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_on_plan: 403,
  not_found: 404,
  invalid_request: 422,
  rate_limited: 429,
  conflict: 409,
  server_error: 500,
};

/** Uses the caller's id when they sent one, so their logs and ours agree. */
export function requestIdFrom(request: Request): string {
  const supplied = request.headers.get(REQUEST_ID_HEADER)?.trim();
  if (supplied && supplied.length <= 128) return supplied;
  return randomUUID();
}

export function ok<T>(
  data: T,
  requestId: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse {
  return NextResponse.json(
    { data, requestId },
    {
      status: init.status ?? 200,
      headers: { ...init.headers, [REQUEST_ID_HEADER]: requestId },
    },
  );
}

export function fail(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  extra: {
    status?: number;
    field?: string;
    fields?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(extra.field ? { field: extra.field } : {}),
        ...(extra.fields ? { fields: extra.fields } : {}),
      },
      requestId,
    },
    {
      status: extra.status ?? STATUS_FOR[code],
      headers: { ...extra.headers, [REQUEST_ID_HEADER]: requestId },
    },
  );
}

/** Zod issues, flattened to one message per field path. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Reads a JSON body, refusing anything that is not JSON rather than
 * letting `undefined` flow into a Zod schema and produce a confusing
 * "expected object, received undefined".
 */
export async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { ok: false, message: "Send `Content-Type: application/json`." };
  }

  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, message: "The request body is not valid JSON." };
  }
}
