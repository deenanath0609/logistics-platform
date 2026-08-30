import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { DataScope } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";
import { clientIpFrom, ipBucketKey, type ClientIp } from "@/lib/net/client-ip";
import type { SessionUser } from "@/lib/auth/session";
import {
  effectiveScopes,
  keyPrefixOf,
  parseApiKeyHeader,
  verifyApiKey,
  type ApiKeyRecord,
} from "@/lib/webhooks/api-key";
import {
  checkAuthFailures,
  claimAuthFailureReport,
  consumeApiQuota,
  DEFAULT_RATE_LIMIT,
  noteAuthFailure,
} from "@/lib/webhooks/rate-limit";
import { requireTenantOrgId, resolveTenant } from "@/lib/tenant";
import { fail, ok, requestIdFrom } from "./respond";

/**
 * The gate every v1 endpoint passes through.
 *
 * Failure brake → key → verify → rate limit → actor → scope. The actor step
 * is the one worth explaining: a key is not a user, but everything
 * downstream — booking, event append, branch scoping, the audit trail — is
 * written in terms of one. So the key acts *as the staff member who issued
 * it*, with its permissions narrowed to the key's own scopes. A key can
 * therefore never do more than its owner could, and an audited row names a
 * real person rather than an anonymous integration.
 *
 * The brake at the front is new, and it is deliberately the very first
 * thing. Every failure used to return before any limit was counted, so a
 * caller guessing keys paid nothing and was throttled by nothing, while
 * each guess cost this process a tenant resolution, a key lookup on an
 * unindexed column, a SHA-256 and a body parse. Only failures spend that
 * budget, and it is peeked rather than consumed, so a partner holding a
 * good key is never delayed by whatever else shares its address.
 */

export type ApiContext = {
  requestId: string;
  key: ApiKeyRecord & { customerId: string | null };
  /**
   * `actor.orgId` is redundant as a *filter* now — the extension scopes every
   * read and stamps every create from the host — but it is kept rather than
   * dropped: `SessionUser` is shared with the signed-in UI path, and handlers
   * still want the id as a value (stamping a row they build by hand, naming
   * the tenant in a log line). Redundant with the extension is not the same
   * as unused, and removing it would only push the same lookup elsewhere.
   */
  actor: SessionUser;
  /**
   * Only ever set when a configured trusted proxy vouched for it. Null
   * where the deployment cannot establish the caller — which is honest
   * rather than convenient, because this value reaches the audit trail.
   */
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

  // Scoped to the host's tenant by the extension, like every other user
  // lookup. The key was found in that same tenant a moment ago, so its owner
  // is necessarily there too — the filter here is a backstop against a key
  // whose `createdById` points somewhere it should not, not the real check.
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

  // The narrowing that makes a scoped key meaningful. Computed here and —
  // until this was fixed — checked nowhere, so `withApiKey` admitted a
  // request on the strength of the key's own `scopes` column alone and the
  // narrowed set only ever reached handlers that happened to consult it.
  const permissions = effectiveScopes(key.scopes, held);

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
 * Charges a failed authentication to the calling address, and leaves a
 * trace of it.
 *
 * Two records, for two different readers, because the volume of the two is
 * wildly different:
 *
 *  - A log line for every failure. Cheap, unconditional, and the thing an
 *    engineer greps when a partner says "it stopped working at 14:32". It
 *    names the key *prefix*, never the presented key: the prefix is a
 *    lookup handle and not a secret, and writing the whole key into a log
 *    would create the credential leak the hashing exists to prevent.
 *  - A `LoginActivity` row once per address per window, written only when
 *    the budget is actually exhausted. That is the row an operations team
 *    reads in the tenant's own activity report, and it is the reason
 *    brute-force volume is no longer invisible. Once per window, not once
 *    per request, because a row per bogus request would turn a guessing
 *    attack into a write amplifier — the failure path would cost more than
 *    the success path.
 *
 * Neither may fail the response. A caller must not learn from a 500 that
 * they broke the recorder.
 */
async function recordAuthFailure(input: {
  requestId: string;
  code: string;
  prefix: string | null;
  ip: ClientIp;
  failureBucket: string;
}): Promise<void> {
  const spent = await noteAuthFailure(input.failureBucket);

  console.warn(
    "[api/v1] auth failure",
    JSON.stringify({
      requestId: input.requestId,
      reason: input.code,
      keyPrefix: input.prefix,
      address: input.ip.value,
      addressTrusted: input.ip.trusted,
      remaining: spent.remaining,
    }),
  );

  if (spent.ok) return;

  const first = await claimAuthFailureReport(input.failureBucket);
  if (!first.ok) return;

  try {
    await prisma.loginActivity.create({
      data: {
        orgId: await requireTenantOrgId(),
        identifier: input.prefix ?? "unknown-api-key",
        outcome: "BAD_CREDENTIALS",
        ipAddress: input.ip.trusted ? input.ip.value : null,
      },
    });
  } catch (error) {
    console.error("[api/v1] could not record the auth-failure burst", error);
  }
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

  // This used to arm the webhook fan-out and its delivery timer, because
  // there was no single startup hook every entry point passed through.
  // There is one now — `workers/index.ts` — and starting a dispatcher from
  // inside a request would put a second one on every web instance, racing
  // the worker for the same deliveries.

  const ip = clientIpFrom(request.headers, getEnv().TRUSTED_PROXY_HOPS);
  const failureBucket = ipBucketKey("api-auth", ip);

  // Before the tenant is resolved, before the key row is read, before the
  // digest is computed. A caller who has already spent the failure budget
  // is answered from a counter and costs nothing else.
  const brake = await checkAuthFailures(failureBucket);
  if (!brake.ok) {
    return fail(
      "rate_limited",
      "Too many failed authentications from this address.",
      requestId,
      { headers: { "Retry-After": String(brake.retryAfterSeconds) } },
    );
  }

  // No carrier on this host, so there is no partner API here.
  //
  // The key lookup below is tenant-scoped by the extension, which is the
  // whole of the isolation story on this route — and on the bare platform
  // domain, where the operator console lives, there is no tenant for it to
  // scope to. The extension threw, nothing caught it, and a valid key
  // presented against the console answered 500 with a request id: an
  // internal error standing in for "this endpoint is not served here".
  //
  // 404 rather than 401, deliberately. A caller on the wrong host learns
  // that the route does not exist there, and nothing about whether the key
  // they hold is real — the same answer a stranger gets.
  if (!(await resolveTenant())) {
    return fail(
      "not_found",
      "The partner API is served on a carrier's own subdomain.",
      requestId,
    );
  }

  const presented = parseApiKeyHeader(
    request.headers.get("authorization"),
    request.headers.get("x-api-key"),
  );

  const prefix = presented ? keyPrefixOf(presented) : null;

  // Already tenant-scoped, without a line of code here saying so. The
  // partner API is served on the tenant's own subdomain, so the extension
  // pins this lookup to that tenant: a key issued by one carrier and
  // presented against another carrier's host matches nothing and is refused
  // as an unknown key. Nothing more is needed — an explicit orgId comparison
  // would only restate the filter that already ran, and `keyPrefix` is not
  // unique on its own, so `findFirst` remains correct.
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
    address: ip.value,
    addressTrusted: ip.trusted,
  });

  if (!verdict.ok) {
    await recordAuthFailure({ requestId, code: verdict.code, prefix, ip, failureBucket });
    return fail(
      verdict.status === 403 ? "forbidden" : "unauthorized",
      verdict.message,
      requestId,
      { status: verdict.status },
    );
  }

  const quota = await consumeApiQuota(verdict.key.id, DEFAULT_RATE_LIMIT);
  const rateHeaders = {
    "X-RateLimit-Limit": String(quota.limit),
    "X-RateLimit-Remaining": String(quota.remaining),
    "X-RateLimit-Reset": String(Math.ceil(quota.resetAt / 1000)),
  };

  if (!quota.ok) {
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

  // The check the doc comment above has always described. `verifyApiKey`
  // asked whether the key *carries* the scope; this asks whether its owner
  // still *holds* it. They differ the moment a role is revoked — which is
  // exactly the moment the answer has to change, and until now did not:
  // the key went on working with whatever it was minted with.
  if (!actor.permissions.has(requiredScope)) {
    return fail(
      "forbidden",
      `That API key carries \`${requiredScope}\`, but the account that issued it no longer holds that permission. Reissue the key, or restore the role.`,
      requestId,
      { headers: rateHeaders },
    );
  }

  // Best-effort: a partner's request must not fail because we could not
  // write a timestamp — which now includes a suspended tenant, where the
  // extension refuses the write outright and the swallowed rejection is the
  // right answer rather than a 500 on an otherwise readable request.
  void prisma.apiKey
    .update({ where: { id: verdict.key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  try {
    const response = await handler({
      requestId,
      key: { ...verdict.key, customerId: record?.customerId ?? null },
      actor,
      address: ip.trusted ? ip.value : null,
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
