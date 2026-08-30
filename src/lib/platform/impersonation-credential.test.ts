import { describe, expect, it } from "vitest";

// `getEnv()` reads these lazily, inside the functions under test, so it is
// enough to set them before the first call. The credential is signed over
// `AUTH_SECRET`; nothing here touches a database.
process.env.AUTH_SECRET ??= "test-secret-for-impersonation-credentials";
process.env.DATABASE_URL ??= "postgres://unused/unused";

import {
  HANDOFF_AUDIENCE,
  SESSION_AUDIENCE,
  credentialExpiry,
  grantIsUsable,
  grantMayWrite,
  grantSubject,
  impersonationContext,
  readGrantSubject,
  readGrantToken,
  signGrantToken,
  type GrantFacts,
  type GrantOrg,
} from "@/lib/platform/impersonation-credential";
import {
  TenantReadOnlyError,
  assertTenantWritable,
  runWithTenant,
} from "@/lib/tenant/context";

const NOW = new Date("2026-08-28T10:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const ACME: GrantOrg = {
  id: "org_acme",
  slug: "acme",
  subdomain: "acme",
  status: "ACTIVE",
};

const BRAVO: GrantOrg = { ...ACME, id: "org_bravo", slug: "bravo", subdomain: "bravo" };

/**
 * A grant that is alive right now, on the real clock.
 *
 * `signGrantToken` takes an injectable `now`, but `readGrantToken` verifies
 * against the actual system time — a JWT's expiry is not something the
 * caller gets to fake. So any test that signs *and then reads* has to use
 * real time; a fixed date would pass on the day it was written and start
 * failing a few hours later, which is exactly what happened.
 *
 * Tests that only exercise the pure rules keep the fixed `NOW`, because
 * those take `now` as an argument and determinism is worth more there.
 */
function liveGrant(overrides: Partial<GrantFacts> = {}): GrantFacts {
  return grant({ expiresAt: new Date(Date.now() + 30 * 60_000), ...overrides });
}

function grant(overrides: Partial<GrantFacts> = {}): GrantFacts {
  return {
    id: "grant_1",
    orgId: ACME.id,
    platformAdminId: "admin_1",
    asUserId: "user_1",
    allowWrites: false,
    expiresAt: minutes(30),
    endedAt: null,
    ...overrides,
  };
}

describe("the grant subject", () => {
  it("round-trips a grant id", () => {
    expect(readGrantSubject(grantSubject("grant_1"))).toBe("grant_1");
  });

  it("refuses every other subject space", () => {
    // A staff subject is a bare cuid, and the other two populations are
    // namespaced. None of them may be read as a support credential.
    expect(readGrantSubject("clx0000000000000000000000")).toBeNull();
    expect(readGrantSubject("platform:admin_1")).toBeNull();
    expect(readGrantSubject("customer:cust_1")).toBeNull();
    expect(readGrantSubject("grant:")).toBeNull();
    expect(readGrantSubject(null)).toBeNull();
  });
});

describe("the credential's lifetime", () => {
  it("never outlives the grant, however long the ttl asks for", () => {
    const expiry = credentialExpiry(grant({ expiresAt: minutes(5) }), 3600, NOW);
    expect(expiry).toEqual(minutes(5));
  });

  it("is shortened by the ttl when the grant runs longer", () => {
    const expiry = credentialExpiry(grant({ expiresAt: minutes(240) }), 60, NOW);
    expect(expiry).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it("round-trips a token back to its grant id", async () => {
    const token = await signGrantToken(liveGrant(), SESSION_AUDIENCE, 900);
    expect(token).not.toBeNull();
    expect(await readGrantToken(token, SESSION_AUDIENCE)).toBe("grant_1");
  });

  it("refuses to mint a token for a grant that has already expired", async () => {
    const dead = grant({ expiresAt: minutes(-1) });
    expect(await signGrantToken(dead, SESSION_AUDIENCE, 900, NOW)).toBeNull();
  });

  it("rejects a token whose own expiry has passed", async () => {
    // Minted two minutes ago against a grant that died one minute ago:
    // signing succeeded at the time, and verification must not now.
    const past = new Date(Date.now() - 120_000);
    const token = await signGrantToken(
      { id: "grant_1", expiresAt: new Date(Date.now() - 60_000) },
      SESSION_AUDIENCE,
      900,
      past,
    );
    expect(token).not.toBeNull();
    expect(await readGrantToken(token, SESSION_AUDIENCE)).toBeNull();
  });

  it("keeps the hand-off and the session token apart", async () => {
    const handoff = await signGrantToken(liveGrant(), HANDOFF_AUDIENCE, 60);
    // A link token must not be usable as a session cookie, and the reverse
    // must not be replayable through the enter route.
    expect(await readGrantToken(handoff, SESSION_AUDIENCE)).toBeNull();
    expect(await readGrantToken(handoff, HANDOFF_AUDIENCE)).toBe("grant_1");
  });

  it("rejects a tampered or foreign signature", async () => {
    const token = await signGrantToken(grant(), SESSION_AUDIENCE, 900, NOW);
    expect(await readGrantToken(`${token}x`, SESSION_AUDIENCE)).toBeNull();
    expect(await readGrantToken("not-a-token", SESSION_AUDIENCE)).toBeNull();
    expect(await readGrantToken(null, SESSION_AUDIENCE)).toBeNull();
  });
});

describe("whether a grant may still be used", () => {
  it("accepts a live grant on its own tenant's host", () => {
    expect(grantIsUsable(grant(), ACME.id, NOW)).toBe(true);
  });

  it("rejects an expired grant", () => {
    expect(grantIsUsable(grant({ expiresAt: minutes(-1) }), ACME.id, NOW)).toBe(
      false,
    );
  });

  it("rejects a grant that was ended early", () => {
    expect(
      grantIsUsable(grant({ endedAt: minutes(-5) }), ACME.id, NOW),
    ).toBe(false);
  });

  it("rejects a grant belonging to another organisation", () => {
    expect(grantIsUsable(grant(), BRAVO.id, NOW)).toBe(false);
  });
});

describe("the tenant context a grant produces", () => {
  it("labels the session and names the operator", () => {
    const ctx = impersonationContext(ACME, grant(), NOW);
    expect(ctx).toMatchObject({
      orgId: ACME.id,
      source: "impersonation",
      impersonation: { grantId: "grant_1", platformAdminId: "admin_1" },
    });
  });

  it("is read-only unless writes were deliberately asked for", () => {
    expect(impersonationContext(ACME, grant(), NOW)?.readOnly).toBe(true);
    expect(
      impersonationContext(ACME, grant({ allowWrites: true }), NOW)?.readOnly,
    ).toBe(false);
  });

  it("stays read-only when there is nobody to attribute a write to", () => {
    // `AuditLog.userId` is a foreign key into the carrier's staff table, so
    // a tenant-wide grant has no actor a write could name.
    const tenantWide = grant({ allowWrites: true, asUserId: null });
    expect(grantMayWrite(tenantWide)).toBe(false);
    expect(impersonationContext(ACME, tenantWide, NOW)?.readOnly).toBe(true);
  });

  it("keeps a suspended carrier read-only whatever the grant asked for", () => {
    const ctx = impersonationContext(
      { ...ACME, status: "SUSPENDED" },
      grant({ allowWrites: true }),
      NOW,
    );
    expect(ctx?.readOnly).toBe(true);
  });

  it("produces nothing for a closed carrier", () => {
    expect(
      impersonationContext({ ...ACME, status: "CLOSED" }, grant(), NOW),
    ).toBeNull();
  });

  it("ignores a grant opened against a different organisation entirely", () => {
    // Not downgraded to a read-only Bravo session — ignored. Honouring it
    // in any form would make the credential, not the host, the boundary.
    expect(impersonationContext(BRAVO, grant(), NOW)).toBeNull();
  });

  it("produces nothing once the grant is ended or expired", () => {
    expect(
      impersonationContext(ACME, grant({ endedAt: minutes(-1) }), NOW),
    ).toBeNull();
    expect(
      impersonationContext(ACME, grant({ expiresAt: minutes(-1) }), NOW),
    ).toBeNull();
  });
});

describe("a read-only support session at the write guard", () => {
  // The same guard the Prisma extension calls on every mutating operation,
  // so this is the refusal a forgotten check would still hit.
  it("refuses a write", () => {
    const ctx = impersonationContext(ACME, grant(), NOW);
    expect(ctx).not.toBeNull();
    expect(() => runWithTenant(ctx!, assertTenantWritable)).toThrow(
      TenantReadOnlyError,
    );
  });

  it("refuses a write for a tenant-wide grant that asked for one", () => {
    const ctx = impersonationContext(
      ACME,
      grant({ allowWrites: true, asUserId: null }),
      NOW,
    );
    expect(() => runWithTenant(ctx!, assertTenantWritable)).toThrow(
      TenantReadOnlyError,
    );
  });

  it("allows a write when the grant named a user and asked for writes", () => {
    const ctx = impersonationContext(ACME, grant({ allowWrites: true }), NOW);
    expect(() => runWithTenant(ctx!, assertTenantWritable)).not.toThrow();
  });
});

describe("the audiences", () => {
  // Guarded because they are the whole reason a console cookie cannot be
  // presented as a support session, or vice versa.
  it("are distinct from each other and from the console's", () => {
    expect(SESSION_AUDIENCE).not.toBe(HANDOFF_AUDIENCE);
    expect(SESSION_AUDIENCE).not.toBe("platform-console");
    expect(HANDOFF_AUDIENCE).not.toBe("platform-console");
  });
});
