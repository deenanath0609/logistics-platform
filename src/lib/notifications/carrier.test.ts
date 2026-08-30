import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithTenant, type TenantContext } from "@/lib/tenant/context";

/**
 * The white-label proof.
 *
 * A consignee of one carrier must never be told the name of another, and on
 * a shared deployment the only thing standing between those two facts is the
 * fallback chain each of these tests walks. So each one is written as the
 * question an onboarding engineer actually asks — "what goes out if the
 * tenant has not filled this in yet?" — and the last link in every chain is
 * an environment variable that in production is empty.
 *
 * The sender-header case is the one that matters most and reads least
 * dramatically: an SMS sent under a header nobody registered is accepted by
 * the aggregator, dropped by the operator, and logged here as a success. The
 * only defence is refusing to send it, which is asserted twice below.
 */

const env = vi.hoisted(() => ({
  current: {
    APP_NAME: "City Logistics",
    APP_URL: "http://localhost:3010",
    APP_ROOT_DOMAIN: "localhost",
    SUPPORT_PHONE: "",
    SMS_SENDER_ID: "",
    SMTP_FROM: "",
    OTP_TTL_SECONDS: 300,
    SMS_PROVIDER: "mock",
    WHATSAPP_PROVIDER: "mock",
  } as Record<string, unknown>,
}));

const store = vi.hoisted(() => ({
  org: null as Record<string, unknown> | null,
  shipment: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/env", () => ({ getEnv: () => env.current }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // No carrier here has an account of their own with any gateway, which
    // is the state this file is about: every chain below ends at an
    // environment variable shared by the whole deployment.
    tenantCredential: { findFirst: async () => null },
    organization: { findUnique: async () => store.org },
    shipment: { findUnique: async () => store.shipment },
    deliveryAttempt: { findFirst: async () => null },
    deliveryTask: { findFirst: async () => null },
    pickupRequest: { findFirst: async () => null },
    reasonCode: { findUnique: async () => null },
  },
}));

const { baseVariables, eventVariables, loadShipmentContext } = await import("./context");
const { carrierIdentity, resetCarrierCache } = await import("./carrier");
const { resetCredentialCache } = await import("@/lib/integrations/credentials");
const { resolveSenderId } = await import("./channels/sms");
const { resolveFrom } = await import("./channels/email");

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

const TENANT: TenantContext = {
  orgId: "org_acme",
  slug: "acme",
  subdomain: "acme",
  status: "ACTIVE",
  source: "job",
  readOnly: false,
};

/** A fully onboarded carrier: every white-label field filled in. */
function organization(overrides: Record<string, unknown> = {}) {
  return {
    name: "Acme Logistics",
    supportPhone: "1800-ACME-01",
    supportEmail: "help@acme-logistics.example",
    subdomain: "acme",
    customDomain: null,
    dltSenderId: "ACMELG",
    smtpFrom: "Acme Logistics <noreply@acme-logistics.example>",
    ...overrides,
  };
}

/** Branchless so the branch link of the phone chain can be tested on its own. */
function shipment(overrides: Record<string, unknown> = {}) {
  return {
    id: "shp_1",
    lrNumber: "AC/DEL/2627/000412",
    currentStatus: "DELIVERED",
    packageCount: 3,
    chargeableWeight: "42.500",
    paymentType: "COD",
    codAmount: "12400.00",
    expectedDeliveryAt: new Date("2026-08-29T00:00:00Z"),
    deliveredAt: new Date("2026-08-28T10:12:00Z"),
    pickedUpAt: null,
    attemptCount: 0,
    originBranchId: "br_okhla",
    destinationBranchId: "br_jaipur",
    consignorId: "cus_1",
    consignorName: "Sharma Traders",
    consignorPhone: "9876543210",
    consignorEmail: "ops@sharma.test",
    consigneeName: "Mehta Industries",
    consigneePhone: "9998887770",
    consigneeEmail: null,
    consignorCity: { name: "Delhi" },
    consigneeCity: { name: "Jaipur" },
    originBranch: { id: "br_okhla", name: "Okhla", phone: null, email: null },
    destinationBranch: { id: "br_jaipur", name: "Jaipur City", phone: null, email: null },
    consignor: { id: "cus_1", portalUsers: [] },
    ...overrides,
  };
}

async function variables() {
  const context = await loadShipmentContext("shp_1");
  return baseVariables(context!);
}

/** Runs `fn` as the tenant, the way the outbox drain does. */
function asCarrier<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenant(TENANT, fn);
}

beforeEach(() => {
  env.current = {
    APP_NAME: "City Logistics",
    APP_URL: "http://localhost:3010",
    APP_ROOT_DOMAIN: "localhost",
    SUPPORT_PHONE: "",
    SMS_SENDER_ID: "",
    SMTP_FROM: "",
    OTP_TTL_SECONDS: 300,
    SMS_PROVIDER: "mock",
    WHATSAPP_PROVIDER: "mock",
  };
  store.org = organization();
  store.shipment = shipment();
  resetCarrierCache();
  resetCredentialCache();
});

// ────────────────────────────────────────────────────────────

describe("brand name", () => {
  it("is the carrier's trading name, not the platform's", async () => {
    const vars = await asCarrier(variables);

    expect(vars.brandName).toBe("Acme Logistics");
    expect(vars.brandName).not.toBe("City Logistics");
  });

  it("falls back to APP_NAME only when no tenant is established", async () => {
    expect((await variables()).brandName).toBe("City Logistics");
  });
});

describe("support phone", () => {
  it("prefers the branch handling the consignment", async () => {
    store.shipment = shipment({
      originBranch: { id: "br_okhla", name: "Okhla", phone: "011-4000-0000", email: null },
    });

    expect((await asCarrier(variables)).supportPhone).toBe("011-4000-0000");
  });

  it("falls back to the carrier's central number, not the platform's", async () => {
    env.current.SUPPORT_PHONE = "1800-PLATFORM";

    expect((await asCarrier(variables)).supportPhone).toBe("1800-ACME-01");
  });

  it("uses SUPPORT_PHONE only when the carrier has none on file", async () => {
    store.org = organization({ supportPhone: null });
    env.current.SUPPORT_PHONE = "1800-PLATFORM";

    expect((await asCarrier(variables)).supportPhone).toBe("1800-PLATFORM");
  });

  it("renders as empty rather than failing the whole message", async () => {
    store.org = organization({ supportPhone: "   " });

    expect((await asCarrier(variables)).supportPhone).toBe("");
  });
});

describe("support email", () => {
  it("comes from the carrier", async () => {
    expect((await asCarrier(variables)).supportEmail).toBe(
      "help@acme-logistics.example",
    );
  });

  it("is empty rather than absent when the carrier has not set one", async () => {
    store.org = organization({ supportEmail: null });

    // Empty, not null: a missing value leaves `{{supportEmail}}` standing in
    // the body and fails the send, which is not what an unset footer line
    // deserves.
    expect((await asCarrier(variables)).supportEmail).toBe("");
  });
});

describe("links", () => {
  it("points a consignee at the carrier's own subdomain", async () => {
    expect((await asCarrier(variables)).trackingUrl).toBe(
      "http://acme.localhost:3010/track/AC%2FDEL%2F2627%2F000412",
    );
  });

  it("prefers the carrier's custom domain once they have one", async () => {
    store.org = organization({ customDomain: "track.acme-logistics.example" });
    env.current.APP_URL = "https://app.platform.example";
    env.current.APP_ROOT_DOMAIN = "platform.example";

    expect((await asCarrier(variables)).trackingUrl).toBe(
      "https://track.acme-logistics.example/track/AC%2FDEL%2F2627%2F000412",
    );
  });

  it("carries the tenant host into the POD link too", async () => {
    const context = await loadShipmentContext("shp_1");
    const vars = await asCarrier(() =>
      eventVariables("shipment.delivered", context!, {}),
    );

    expect(vars.podUrl).toBe(
      "http://acme.localhost:3010/track/AC%2FDEL%2F2627%2F000412/pod",
    );
  });

  it("carries it into the reschedule link a failed attempt sends", async () => {
    const context = await loadShipmentContext("shp_1");
    const vars = await asCarrier(() =>
      eventVariables("shipment.delivery_attempted", context!, {}),
    );

    expect(vars.rescheduleUrl).toBe(
      "http://acme.localhost:3010/track/AC%2FDEL%2F2627%2F000412/reschedule",
    );
  });

  it("uses APP_URL only when there is no tenant to build a host from", async () => {
    expect((await variables()).trackingUrl).toBe(
      "http://localhost:3010/track/AC%2FDEL%2F2627%2F000412",
    );
  });

  it("never leaks one carrier's host into another's message", async () => {
    const acme = await asCarrier(variables);

    store.org = organization({ name: "Bharat Roadways", subdomain: "bharat" });
    resetCarrierCache();
    const bharat = await runWithTenant(
      { ...TENANT, orgId: "org_bharat", slug: "bharat", subdomain: "bharat" },
      variables,
    );

    expect(acme.trackingUrl).toContain("acme.localhost");
    expect(bharat.trackingUrl).toContain("bharat.localhost");
    expect(bharat.brandName).toBe("Bharat Roadways");
  });
});

describe("SMS sender header", () => {
  it("uses the template's own header first — it is what DLT approved", async () => {
    env.current.SMS_SENDER_ID = "DEVSND";

    const sender = await asCarrier(() =>
      resolveSenderId({ channel: "SMS", to: "9998887770", body: "x", dltSenderId: "TPLHDR" }),
    );

    expect(sender).toBe("TPLHDR");
  });

  it("falls back to the carrier's registered header", async () => {
    env.current.SMS_SENDER_ID = "DEVSND";

    const sender = await asCarrier(() =>
      resolveSenderId({ channel: "SMS", to: "9998887770", body: "x", dltSenderId: null }),
    );

    expect(sender).toBe("ACMELG");
  });

  it("uses SMS_SENDER_ID only as a development convenience", async () => {
    store.org = organization({ dltSenderId: null });
    env.current.SMS_SENDER_ID = "DEVSND";

    const sender = await asCarrier(() =>
      resolveSenderId({ channel: "SMS", to: "9998887770", body: "x" }),
    );

    expect(sender).toBe("DEVSND");
  });

  it("refuses to send when no header exists anywhere", async () => {
    store.org = organization({ dltSenderId: null });

    await expect(
      asCarrier(() =>
        resolveSenderId({ channel: "SMS", to: "9998887770", body: "x" }),
      ),
    ).rejects.toThrow(/No DLT sender header/);
  });

  it("refuses on a blank header rather than sending an empty one", async () => {
    // The gateway would accept `sender=""` and the operator would drop it,
    // which is indistinguishable from delivery in every log we keep.
    store.org = organization({ dltSenderId: "  " });
    env.current.SMS_SENDER_ID = "   ";

    await expect(
      asCarrier(() =>
        resolveSenderId({ channel: "SMS", to: "9998887770", body: "x", dltSenderId: "" }),
      ),
    ).rejects.toThrow(/No DLT sender header/);
  });

  it("names the carrier in the refusal, because the fix is their registration", async () => {
    store.org = organization({ dltSenderId: null });

    await expect(
      asCarrier(() =>
        resolveSenderId({ channel: "SMS", to: "9998887770", body: "x" }),
      ),
    ).rejects.toThrow(/Acme Logistics/);
  });
});

describe("email From address", () => {
  it("sends as the carrier, not as the platform", async () => {
    env.current.SMTP_FROM = "City Logistics <noreply@platform.example>";

    expect(await asCarrier(resolveFrom)).toBe(
      "Acme Logistics <noreply@acme-logistics.example>",
    );
  });

  it("falls back to SMTP_FROM while the carrier's mail domain is being set up", async () => {
    store.org = organization({ smtpFrom: null });
    env.current.SMTP_FROM = "City Logistics <noreply@platform.example>";

    expect(await asCarrier(resolveFrom)).toBe(
      "City Logistics <noreply@platform.example>",
    );
  });

  it("has nothing to send as when neither is set", async () => {
    store.org = organization({ smtpFrom: null });

    expect(await asCarrier(resolveFrom)).toBeNull();
  });
});

describe("identity lookup", () => {
  it("is null outside a tenant, so every caller falls back rather than throwing", async () => {
    expect(await carrierIdentity()).toBeNull();
  });

  it("is null for a tenant whose organisation row has gone", async () => {
    store.org = null;

    expect(await asCarrier(carrierIdentity)).toBeNull();
  });
});
