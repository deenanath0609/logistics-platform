import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { DataScope } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import {
  clientAddress,
  keyPrefixOf,
  parseApiKeyHeader,
  verifyApiKey,
  type ApiKeyRecord,
} from "@/lib/webhooks/api-key";
import { consumeApiQuota, DEFAULT_RATE_LIMIT } from "@/lib/webhooks/rate-limit";
import { startWebhookDispatch } from "@/lib/webhooks/dispatch";
import { fail, ok, requestIdFrom } from "./respond";

/**
 * The gate every v1 endpoint passes through.
 *
 * Key → verify → rate limit → actor. The actor step is the one worth
 * explaining: a key is not a user, but everything downstream — booking,
 * event append, branch scoping, the audit trail — is written in terms of
 * one. So the key acts *as the staff member who issued it*, with its
 * permissions narrowed to the key's own scopes. A key can therefore never
 * do more than its owner could, and an audited row names a real person
 * rather than an anonymous integration.
 */

export type ApiContext = {
  requestId: string;
  key: ApiKeyRecord & { customerId: string | null };
  actor: SessionUser;
  address: string | null;
};

const SCOPE_RANK: Record<DataScope, number> = {
  OWN: 0,
  BRANCH: 1,
  BRANCH_SET: 2,
  NETWORK: 3,
};

/**
 * Builds the acting user for a key.
 *
 * Returns null when the key has no usable owner — deactivated, deleted, or
 * never set. Refusing is the only safe reading: a key whose owner has left
 * the company must stop working the moment their account does.
 */
async function actorForKey(
  key: ApiKeyRecord & { createdById: string | null },
): Promise<SessionUser | null> {
  if (!key.createdById) return null;

  const user = await prisma.user.findUnique({
    where: { id: key.createdById },
    select: {
      id: true,
      orgId: true,
      name: true,
      mobile: true,
      email: true,
      status: true,
      isFieldUser: true,
      mustChangePassword: true,
      deletedAt: true,
      primaryBranch: { select: { id: true, code: true, name: true } },
      branchScopes: { select: { branchId: true } },
      roles: {
        select: {
          role: {
            select: {
              code: true,
              name: true,
              scope: true,
              isActive: true,
              permissions: { select: { permission: { select: { code: true } } } },
            },
          },
        },
      },
    },
  });

  if (!user || user.deletedAt || user.status !== "ACTIVE") return null;

  const activeRoles = user.roles.map((r) => r.role).filter((role) => role.isActive);

  const held = new Set<string>();
  for (const role of activeRoles) {
    for (const rp of role.permissions) held.add(rp.permission.code);
  }

  // The narrowing that makes a scoped key meaningful.
  const permissions = new Set(key.scopes.filter((scope) => held.has(scope)));

  const scope = activeRoles.reduce<DataScope>(
    (widest, role) => (SCOPE_RANK[role.scope] > SCOPE_RANK[widest] ? role.scope : widest),
    "OWN",
  );

  let branchIds: string[] | null;
  if (scope === "NETWORK") {
    branchIds = null;
  } else if (scope === "BRANCH_SET") {
    branchIds = [
      ...new Set(
        [user.primaryBranch?.id, ...user.branchScopes.map((s) => s.branchId)].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
  } else {
    branchIds = user.primaryBranch ? [user.primaryBranch.id] : [];
  }

  return {
    id: user.id,
    orgId: user.orgId,
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    isFieldUser: user.isFieldUser,
    mustChangePassword: user.mustChangePassword,
    primaryBranch: user.primaryBranch,
    roles: activeRoles.map((r) => ({ code: r.code, name: r.name, scope: r.scope })),
    permissions,
    scope,
    branchIds,
  };
}

/**
 * Wraps a handler with authentication, scope check and rate limiting.
 *
 * `requiredScope` is a permission code from the catalogue, not a new
 * vocabulary: what a key may do is expressed in exactly the terms a role
 * already is.
 */
export async function withApiKey(
  request: Request,
  requiredScope: string,
  handler: (context: ApiContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const requestId = requestIdFrom(request);

  // Every entry point arms the webhook fan-out and its delivery timer,
  // because there is no single startup hook all of them pass through yet.
  // Both are idempotent and the timer is unref'd, so this is cheap.
  startWebhookDispatch();

  const presented = parseApiKeyHeader(
    request.headers.get("authorization"),
    request.headers.get("x-api-key"),
  );

  const address = clientAddress(
    request.headers.get("x-forwarded-for"),
    request.headers.get("x-real-ip"),
  );

  const prefix = presented ? keyPrefixOf(presented) : null;

  const record = prefix
    ? await prisma.apiKey.findFirst({
        where: { keyPrefix: prefix },
        select: {
          id: true,
          orgId: true,
          name: true,
          keyHash: true,
          keyPrefix: true,
          scopes: true,
          ipAllowlist: true,
          customerId: true,
          expiresAt: true,
          revokedAt: true,
          createdById: true,
        },
      })
    : null;

  const verdict = verifyApiKey({
    presented,
    record,
    requiredScope,
    address,
  });

  if (!verdict.ok) {
    return fail(
      verdict.status === 403 ? "forbidden" : "unauthorized",
      verdict.message,
      requestId,
      { status: verdict.status },
    );
  }

  const quota = consumeApiQuota(verdict.key.id, DEFAULT_RATE_LIMIT);
  const rateHeaders = {
    "X-RateLimit-Limit": String(quota.limit),
    "X-RateLimit-Remaining": String(quota.remaining),
    "X-RateLimit-Reset": String(Math.ceil(quota.resetAt / 1000)),
  };

  if (!quota.allowed) {
    return fail("rate_limited", "Too many requests on this key.", requestId, {
      headers: { ...rateHeaders, "Retry-After": String(quota.retryAfterSeconds) },
    });
  }

  const actor = await actorForKey({
    ...verdict.key,
    createdById: record?.createdById ?? null,
  });

  if (!actor) {
    return fail(
      "forbidden",
      "That API key has no active owner. Ask an administrator to reissue it.",
      requestId,
      { headers: rateHeaders },
    );
  }

  // Best-effort: a partner's request must not fail because we could not
  // write a timestamp.
  void prisma.apiKey
    .update({ where: { id: verdict.key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  try {
    const response = await handler({
      requestId,
      key: { ...verdict.key, customerId: record?.customerId ?? null },
      actor,
      address,
    });

    for (const [header, value] of Object.entries(rateHeaders)) {
      response.headers.set(header, value);
    }
    return response;
  } catch (error) {
    console.error(`[api/v1] ${requestId}`, error);
    return fail(
      "server_error",
      "Something went wrong at our end. Quote the request id.",
      requestId,
      { headers: rateHeaders },
    );
  }
}

export { ok, fail };
