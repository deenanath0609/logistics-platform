import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithTenant, type TenantContext } from "@/lib/tenant/context";

/**
 * Whose account did that message actually leave on?
 *
 * `carrier.test.ts` proves a message goes out under the right carrier's
 * *name*. This file proves it goes out through the right carrier's
 * *account* — a distinction with no user-visible difference and three
 * operational ones: whose bill it lands on, whose rate limit it shares, and
 * who else stops sending when a key is revoked.
 *
 * The two tests that matter most are the ones that look least dramatic.
 * "Neither carrier's value appears in the other's" is the leak; and "with
 * nothing anywhere, the send is refused" is the one that keeps a message
 * from being logged as sent and never delivered.
 */

const env = vi.hoisted(() => ({
  current: {
    APP_NAME: "City Logistics",
    APP_URL: "http://localhost:3010",
    APP_ROOT_DOMAIN: "localhost",
    SMS_SENDER_ID: "",
    SMTP_FROM: "",
    GPS_PROVIDER: "mock",
    CREDENTIALS_KEY: Buffer.alloc(32, 0x7c).toString("base64url"),
  } as Record<string, unknown>,
}));

/**
 * The credential rows, keyed the way the unique index is. The mocked
 * `findFirst` reads `orgId` off the tenant context rather than off the
 * query, exactly as the tenant extension would inject it.
 */
const store = vi.hoisted(() => ({
  orgs: new Map<string, Record<string, unknown>>(),
  credentials: new Map<
    string,
    { secret: string | null; settings: unknown; updatedAt: Date }
  >(),
  /** The org the mocked client should answer as. Set by `asCarrier`. */
  acting: null as string | null,
}));

vi.mock("@/lib/env", () => ({ getEnv: () => env.current }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantCredential: {
      findFirst: async ({ where }: { where: { kind: string } }) =>
        store.credentials.get(`${store.acting}:${where.kind}`) ?? null,
    },
    organization: {
      findUnique: async () => (store.acting ? store.orgs.get(store.acting) : null),
    },
  },
}));

const { encryptSecret } = await import("./secrets");
const { credentialFor, contextFor, resetCredentialCache } = await import(
  "./credentials"
);
const { resetCarrierCache } = await import("@/lib/notifications/carrier");
const { resolveSenderId } = await import("@/lib/notifications/channels/sms");

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

const ACME = "org_acme";
const BHARAT = "org_bharat";

function tenant(orgId: string): TenantContext {
  return {
    orgId,
    slug: orgId,
    subdomain: orgId,
    status: "ACTIVE",
    source: "job",
    readOnly: false,
  };
}

/** Runs `fn` as one carrier, the way the outbox drain does. */
async function asCarrier<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  store.acting = orgId;
  try {
    return await runWithTenant(tenant(orgId), fn);
  } finally {
    store.acting = null;
    // Both caches are keyed on the org, so this is belt and braces — but a
    // test that passed only because of a cache hit from the previous test
    // would be a test asserting nothing.
    resetCredentialCache();
    resetCarrierCache();
  }
}

function organization(orgId: string, overrides: Record<string, unknown> = {}) {
  store.orgs.set(orgId, {
    name: orgId,
    supportPhone: null,
    supportEmail: null,
    subdomain: orgId,
    customDomain: null,
    dltSenderId: null,
    smtpFrom: null,
    whatsappNumber: null,
    ...overrides,
  });
}

/** Gives a carrier their own account, encrypted the way the console does. */
function ownAccount(
  orgId: string,
  kind: "SMS" | "SMTP" | "WHATSAPP" | "GPS",
  secret: string,
  settings: Record<string, unknown> = {},
) {
  store.credentials.set(`${orgId}:${kind}`, {
    secret: encryptSecret(secret, contextFor(orgId, kind)),
    settings,
    updatedAt: new Date("2026-08-30T09:00:00Z"),
  });
}

const SMS = { channel: "SMS" as const, to: "9998887770", body: "x" };

beforeEach(() => {
  env.current = {
    APP_NAME: "City Logistics",
    APP_URL: "http://localhost:3010",
    APP_ROOT_DOMAIN: "localhost",
    SMS_SENDER_ID: "",
    SMTP_FROM: "",
    GPS_PROVIDER: "mock",
    CREDENTIALS_KEY: Buffer.alloc(32, 0x7c).toString("base64url"),
  };
  store.orgs.clear();
  store.credentials.clear();
  store.acting = null;
  organization(ACME, { name: "Acme Logistics" });
  organization(BHARAT, { name: "Bharat Roadways" });
  delete process.env.SMS_API_KEY;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PASSWORD;
  resetCredentialCache();
  resetCarrierCache();
});

// ────────────────────────────────────────────────────────────

describe("resolution", () => {
  it("gives a carrier with their own account exactly that", async () => {
    ownAccount(ACME, "SMS", "sk_acme_live", { senderId: "ACMELG" });
    process.env.SMS_API_KEY = "sk_platform_shared";

    const account = await asCarrier(ACME, () => credentialFor("SMS"));

    expect(account.source).toBe("tenant");
    expect(account.secret).toBe("sk_acme_live");
    expect(account.settings.senderId).toBe("ACMELG");
  });

  it("falls back to the platform's account for a carrier with none", async () => {
    process.env.SMS_API_KEY = "sk_platform_shared";
    env.current.SMS_SENDER_ID = "DEVSND";

    const account = await asCarrier(BHARAT, () => credentialFor("SMS"));

    expect(account.source).toBe("platform");
    expect(account.secret).toBe("sk_platform_shared");
  });

  it("reports no account at all when neither has one", async () => {
    const account = await asCarrier(ACME, () => credentialFor("SMS"));

    expect(account.source).toBe("none");
    expect(account.secret).toBeNull();
  });

  it("treats a slot opened without a key as still on the shared account", async () => {
    // An ordinary onboarding state: the operator has typed the SMTP host
    // while the password is still being issued. Half a credential is not a
    // credential — pairing this carrier's host with the platform's password
    // would authenticate as us to a relay that is not ours.
    store.credentials.set(`${ACME}:SMTP`, {
      secret: null,
      settings: { host: "smtp.acme.example", port: 587, user: "no-reply@acme.example" },
      updatedAt: new Date(),
    });
    process.env.SMTP_HOST = "smtp.platform.example";
    process.env.SMTP_PASSWORD = "pw_platform";

    const account = await asCarrier(ACME, () => credentialFor("SMTP"));

    expect(account.source).toBe("platform");
    expect(account.settings.host).toBe("smtp.platform.example");
    expect(account.secret).toBe("pw_platform");
  });

  it("refuses rather than falling back when a stored secret will not decrypt", async () => {
    // The alternative — treating a failed decryption as "no credential" —
    // turns one mis-deployed CREDENTIALS_KEY into every carrier's traffic
    // silently re-routed onto the platform's bill.
    ownAccount(ACME, "SMS", "sk_acme_live");
    env.current.CREDENTIALS_KEY = Buffer.alloc(32, 0x11).toString("base64url");
    process.env.SMS_API_KEY = "sk_platform_shared";

    await expect(
      asCarrier(ACME, () => credentialFor("SMS")),
    ).rejects.toThrow(/failed authentication/);
  });

  it("uses the environment and nothing else when no tenant is established", async () => {
    process.env.SMS_API_KEY = "sk_platform_shared";

    const account = await credentialFor("SMS");

    expect(account.orgId).toBeNull();
    expect(account.secret).toBe("sk_platform_shared");
  });
});

describe("two carriers, two sender ids", () => {
  beforeEach(() => {
    ownAccount(ACME, "SMS", "sk_acme_live", { senderId: "ACMELG" });
    ownAccount(BHARAT, "SMS", "sk_bharat_live", { senderId: "BHRTRD" });
  });

  it("sends each carrier's message under its own header", async () => {
    const acme = await asCarrier(ACME, () => resolveSenderId(SMS));
    const bharat = await asCarrier(BHARAT, () => resolveSenderId(SMS));

    expect(acme).toBe("ACMELG");
    expect(bharat).toBe("BHRTRD");
  });

  it("never lets one carrier's header into the other's message", async () => {
    const acme = await asCarrier(ACME, () => resolveSenderId(SMS));
    const bharat = await asCarrier(BHARAT, () => resolveSenderId(SMS));

    expect(acme).not.toBe(bharat);
    expect(acme).not.toContain("BHRT");
    expect(bharat).not.toContain("ACME");
  });

  it("keeps their gateway keys apart too", async () => {
    const acme = await asCarrier(ACME, () => credentialFor("SMS"));
    const bharat = await asCarrier(BHARAT, () => credentialFor("SMS"));

    expect(acme.secret).toBe("sk_acme_live");
    expect(bharat.secret).toBe("sk_bharat_live");
    expect(acme.secret).not.toBe(bharat.secret);
  });

  it("does not serve one carrier from the other's cache entry", async () => {
    // The cache is keyed on org and kind. If it were keyed on kind alone,
    // the second read below would return the first carrier's account and
    // every assertion above would still pass.
    store.acting = ACME;
    const acme = await runWithTenant(tenant(ACME), () => credentialFor("SMS"));
    store.acting = BHARAT;
    const bharat = await runWithTenant(tenant(BHARAT), () => credentialFor("SMS"));
    store.acting = null;

    expect(acme.secret).toBe("sk_acme_live");
    expect(bharat.secret).toBe("sk_bharat_live");
  });
});

describe("the header a carrier without their own account sends under", () => {
  it("is their organisation's, not the platform's development default", async () => {
    // `SMS_SENDER_ID` is the platform account's header. It must not jump
    // ahead of the carrier's own registered one just because the carrier is
    // riding on our gateway.
    organization(ACME, { name: "Acme Logistics", dltSenderId: "ACMELG" });
    env.current.SMS_SENDER_ID = "DEVSND";

    expect(await asCarrier(ACME, () => resolveSenderId(SMS))).toBe("ACMELG");
  });

  it("falls all the way back to the environment when they have none", async () => {
    env.current.SMS_SENDER_ID = "DEVSND";

    expect(await asCarrier(ACME, () => resolveSenderId(SMS))).toBe("DEVSND");
  });
});

describe("no credential and no fallback", () => {
  it("refuses the send rather than attempting it", async () => {
    // Nothing on the template, nothing on the organisation, no account of
    // their own, and an empty SMS_SENDER_ID. An attempt here would be
    // accepted by the aggregator, dropped by the operator, and recorded on
    // our side as delivered.
    await expect(
      asCarrier(ACME, () => resolveSenderId(SMS)),
    ).rejects.toThrow(/No DLT sender header/);
  });

  it("names the carrier, because the fix is their DLT registration", async () => {
    organization(ACME, { name: "Acme Logistics" });

    await expect(
      asCarrier(ACME, () => resolveSenderId(SMS)),
    ).rejects.toThrow(/Acme Logistics/);
  });

  it("refuses on a blank header rather than sending an empty one", async () => {
    ownAccount(ACME, "SMS", "sk_acme_live", { senderId: "   " });
    organization(ACME, { name: "Acme Logistics", dltSenderId: "  " });
    env.current.SMS_SENDER_ID = "   ";

    await expect(
      asCarrier(ACME, () => resolveSenderId({ ...SMS, dltSenderId: "" })),
    ).rejects.toThrow(/No DLT sender header/);
  });
});
