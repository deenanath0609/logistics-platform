import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The idempotency proof.
 *
 * The outbox retries an event whenever *any* handler attached to it throws,
 * so the same `shipment.delivered` can reach this dispatcher eight times
 * over. These tests replay events deliberately and assert that the customer
 * is messaged once — which is the whole reason `dedupeKeyFor` exists.
 *
 * Prisma is replaced with an in-memory store rather than a mock-per-call:
 * the interesting behaviour is what accumulates in the log across replays,
 * and assertions against a real collection say that far more directly than
 * counting calls.
 */

type LogRow = {
  id: string;
  templateId: string | null;
  channel: string;
  eventType: string;
  recipient: string;
  recipientKind: string;
  subject: string | null;
  body: string;
  status: string;
  attempts: number;
  error: string | null;
  shipmentId: string | null;
  customerId: string | null;
  branchId: string | null;
  providerRef: string | null;
  providerResponse: Record<string, unknown> | null;
  segments: number | null;
  costAmount: number | null;
  sentAt: Date | null;
  queuedAt: Date;
};

const store = vi.hoisted(() => ({
  templates: [] as Array<Record<string, unknown>>,
  preferences: [] as Array<Record<string, unknown>>,
  logs: [] as LogRow[],
  shipment: null as Record<string, unknown> | null,
  nextId: 0,
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    APP_NAME: "City Logistics",
    APP_URL: "https://app.test",
    OTP_TTL_SECONDS: 300,
    SMS_PROVIDER: "mock",
    WHATSAPP_PROVIDER: "mock",
  }),
}));

vi.mock("@/lib/prisma", () => {
  function matches(row: LogRow, where: Record<string, unknown>): boolean {
    if (where.shipmentId && row.shipmentId !== where.shipmentId) return false;

    const json = where.providerResponse as
      | { path: string[]; equals: unknown }
      | undefined;
    if (json) {
      const value = row.providerResponse?.[json.path[0]];
      if (value !== json.equals) return false;
    }
    return true;
  }

  return {
    prisma: {
      notificationTemplate: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          store.templates.filter(
            (t) => t.eventType === where.eventType && t.isActive === true,
          ),
      },
      notificationPreference: {
        findMany: async () => store.preferences,
      },
      shipment: {
        findUnique: async () => store.shipment,
      },
      notificationLog: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          store.logs.filter((row) => matches(row, where)).at(-1) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: `log_${++store.nextId}`,
            attempts: 0,
            queuedAt: new Date(),
            sentAt: null,
            providerRef: null,
            segments: null,
            costAmount: null,
            ...data,
          } as LogRow;
          store.logs.push(row);
          return row;
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = store.logs.find((r) => r.id === where.id);
          if (!row) throw new Error(`No log ${where.id}`);
          for (const [key, value] of Object.entries(data)) {
            if (
              value !== null &&
              typeof value === "object" &&
              "increment" in (value as Record<string, unknown>)
            ) {
              const current = (row as unknown as Record<string, number>)[key] ?? 0;
              (row as unknown as Record<string, number>)[key] =
                current + Number((value as { increment: number }).increment);
            } else {
              (row as unknown as Record<string, unknown>)[key] = value;
            }
          }
          return row;
        },
      },
      deliveryAttempt: { findFirst: async () => null },
      deliveryTask: { findFirst: async () => null },
      pickupRequest: { findFirst: async () => null },
      reasonCode: { findUnique: async () => null },
    },
  };
});

const { dispatchEvent } = await import("./dispatch");
const { setChannelAdapter, resetChannels } = await import("./channels");

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

function shipment() {
  return {
    id: "shp_1",
    lrNumber: "CL/DEL/2627/000412",
    currentStatus: "DELIVERED",
    packageCount: 3,
    chargeableWeight: "42.500",
    paymentType: "COD",
    codAmount: "12400.00",
    expectedDeliveryAt: new Date("2026-08-29T00:00:00Z"),
    deliveredAt: new Date("2026-08-28T10:12:00Z"),
    pickedUpAt: new Date("2026-08-26T05:00:00Z"),
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
    originBranch: { id: "br_okhla", name: "Okhla", phone: "1800000000", email: "okhla@ops.test" },
    destinationBranch: { id: "br_jaipur", name: "Jaipur City", phone: "1800000001", email: "jaipur@ops.test" },
    consignor: {
      id: "cus_1",
      name: "Sharma Traders",
      phone: "9876543210",
      email: "ops@sharma.test",
      portalUsers: [],
    },
  };
}

const DELIVERED_SMS = {
  id: "tpl_delivered_sms",
  code: "DELIVERED",
  channel: "SMS",
  eventType: "shipment.delivered",
  name: "Delivered",
  language: "en",
  subject: null,
  body: "{{brandName}}: LR {{lrNumber}} delivered. POD: {{podUrl}}",
  variables: ["brandName", "lrNumber", "podUrl"],
  recipientKind: "CONSIGNOR",
  dltTemplateId: "1307161234567890123",
  dltSenderId: "CTYLOG",
  isActive: true,
};

/** Uses only variables every shipment event supplies. */
const ARRIVAL_BODY = "{{brandName}}: LR {{lrNumber}} has reached {{destinationCity}}.";

let sends: Array<{ to: string; body: string }> = [];

function stubAdapter(behaviour: "ok" | "throw" | "reject" = "ok") {
  sends = [];
  setChannelAdapter("SMS", {
    provider: "stub",
    channel: "SMS",
    live: true,
    async send(message) {
      sends.push({ to: message.to, body: message.body });
      if (behaviour === "throw") throw new Error("gateway unreachable");
      if (behaviour === "reject") {
        return { ok: false, error: "DLT template not registered" };
      }
      return { ok: true, providerRef: `stub-${sends.length}` };
    },
  });
}

function deliveredEvent(overrides: Record<string, unknown> = {}) {
  return {
    outboxId: "obx_1",
    eventType: "shipment.delivered",
    aggregate: "Shipment",
    aggregateId: "shp_1",
    payload: { eventId: "evt_1", lrNumber: "CL/DEL/2627/000412", ...overrides },
  };
}

beforeEach(() => {
  store.templates = [DELIVERED_SMS];
  store.preferences = [];
  store.logs = [];
  store.shipment = shipment();
  store.nextId = 0;
  resetChannels();
  stubAdapter("ok");
});

// ────────────────────────────────────────────────────────────

describe("dispatchEvent", () => {
  it("sends once and logs the send", async () => {
    const summary = await dispatchEvent(deliveredEvent());

    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, duplicate: 0 });
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toBe("9876543210");
    expect(sends[0].body).toContain("CL/DEL/2627/000412");

    expect(store.logs).toHaveLength(1);
    expect(store.logs[0].status).toBe("SENT");
    expect(store.logs[0].providerRef).toBe("stub-1");
  });

  it("does not send twice when the outbox replays the same event", async () => {
    await dispatchEvent(deliveredEvent());
    const replay = await dispatchEvent(deliveredEvent());

    expect(replay).toEqual({ sent: 0, failed: 0, skipped: 0, duplicate: 1 });
    expect(sends).toHaveLength(1);
    expect(store.logs).toHaveLength(1);
  });

  it("stays idempotent across the outbox's full retry budget", async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await dispatchEvent(deliveredEvent());
    }

    expect(sends).toHaveLength(1);
    expect(store.logs).toHaveLength(1);
  });

  it("still sends for a genuinely different occurrence of the same event type", async () => {
    // Two failed attempts, two notifications — the key is the event, not
    // the shipment.
    store.templates = [
      {
        ...DELIVERED_SMS,
        eventType: "shipment.delivery_attempted",
        body: "{{brandName}}: LR {{lrNumber}} could not be delivered.",
      },
    ];

    await dispatchEvent({
      ...deliveredEvent(),
      eventType: "shipment.delivery_attempted",
      payload: { eventId: "evt_A" },
    });
    await dispatchEvent({
      ...deliveredEvent(),
      eventType: "shipment.delivery_attempted",
      payload: { eventId: "evt_B" },
    });

    expect(sends).toHaveLength(2);
    expect(store.logs).toHaveLength(2);
  });

  it("falls back to the outbox row id when the payload carries no event id", async () => {
    await dispatchEvent({ ...deliveredEvent(), payload: {} });
    await dispatchEvent({ ...deliveredEvent(), payload: {} });

    expect(sends).toHaveLength(1);
  });

  it("does not resend after the process died between the log row and the gateway", async () => {
    // Simulated by leaving a QUEUED row behind, which is exactly what a
    // crash mid-send looks like from the next replay's point of view.
    await dispatchEvent(deliveredEvent());
    store.logs[0].status = "QUEUED";

    const replay = await dispatchEvent(deliveredEvent());

    expect(replay.duplicate).toBe(1);
    expect(sends).toHaveLength(1);
  });
});

describe("failure handling", () => {
  it("marks the log FAILED and returns when the gateway throws", async () => {
    stubAdapter("throw");

    const summary = await dispatchEvent(deliveredEvent());

    expect(summary.failed).toBe(1);
    expect(store.logs[0].status).toBe("FAILED");
    expect(store.logs[0].error).toContain("gateway unreachable");
  });

  it("never throws out of the handler, so the operational event survives", async () => {
    stubAdapter("throw");
    await expect(dispatchEvent(deliveredEvent())).resolves.toBeDefined();
  });

  it("retries a rejected send on the next replay, reusing the same row", async () => {
    stubAdapter("reject");
    await dispatchEvent(deliveredEvent());
    expect(store.logs[0].status).toBe("FAILED");

    stubAdapter("ok");
    const retry = await dispatchEvent(deliveredEvent());

    expect(retry.sent).toBe(1);
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0].status).toBe("SENT");
    expect(store.logs[0].attempts).toBe(2);
  });
});

describe("recipients and preferences", () => {
  it("skips and logs when the recipient has no address on file", async () => {
    store.templates = [{ ...DELIVERED_SMS, recipientKind: "CONSIGNEE", channel: "EMAIL" }];
    setChannelAdapter("EMAIL", {
      provider: "stub",
      channel: "EMAIL",
      live: true,
      async send() {
        throw new Error("should not be called");
      },
    });

    const summary = await dispatchEvent(deliveredEvent());

    expect(summary.skipped).toBe(1);
    expect(store.logs[0].status).toBe("SKIPPED");
    expect(store.logs[0].error).toContain("email address");
  });

  it("honours an opt-out and records why nothing was sent", async () => {
    store.preferences = [
      {
        customerId: "cus_1",
        customerUserId: null,
        eventType: "shipment.delivered",
        channel: "SMS",
        enabled: false,
      },
    ];

    const summary = await dispatchEvent(deliveredEvent());

    expect(summary.skipped).toBe(1);
    expect(sends).toHaveLength(0);
    expect(store.logs[0].status).toBe("SKIPPED");
    expect(store.logs[0].error).toContain("opted out");
  });

  it("does not apply a consignor's opt-out to the consignee", async () => {
    store.templates = [{ ...DELIVERED_SMS, recipientKind: "CONSIGNEE" }];
    store.preferences = [
      {
        customerId: "cus_1",
        customerUserId: null,
        eventType: "shipment.delivered",
        channel: "SMS",
        enabled: false,
      },
    ];

    const summary = await dispatchEvent(deliveredEvent());

    expect(summary.sent).toBe(1);
    expect(sends[0].to).toBe("9998887770");
  });

  it("fans out to every active portal login, once each", async () => {
    store.shipment = {
      ...shipment(),
      consignor: {
        id: "cus_1",
        name: "Sharma Traders",
        phone: "9876543210",
        email: "ops@sharma.test",
        portalUsers: [
          { id: "cu_1", name: "A", email: "a@sharma.test", mobile: "9000000001" },
          { id: "cu_2", name: "B", email: "b@sharma.test", mobile: "9000000002" },
        ],
      },
    };
    store.templates = [{ ...DELIVERED_SMS, recipientKind: "CUSTOMER_USER" }];

    await dispatchEvent(deliveredEvent());
    await dispatchEvent(deliveredEvent());

    expect(sends.map((s) => s.to)).toEqual(["9000000001", "9000000002"]);
    expect(store.logs).toHaveLength(2);
  });
});

describe("relevance and template health", () => {
  it("does not announce arrival when the scan was at a transit hub", async () => {
    store.templates = [{ ...DELIVERED_SMS, eventType: "shipment.gate_in", body: ARRIVAL_BODY }];

    const summary = await dispatchEvent({
      ...deliveredEvent(),
      eventType: "shipment.gate_in",
      payload: { eventId: "evt_hub", branchId: "br_transit" },
    });

    expect(summary.sent).toBe(0);
    expect(sends).toHaveLength(0);
    expect(store.logs).toHaveLength(0);
  });

  it("announces arrival at the destination branch", async () => {
    store.templates = [{ ...DELIVERED_SMS, eventType: "shipment.gate_in", body: ARRIVAL_BODY }];

    const summary = await dispatchEvent({
      ...deliveredEvent(),
      eventType: "shipment.gate_in",
      payload: { eventId: "evt_dest", branchId: "br_jaipur" },
    });

    expect(summary.sent).toBe(1);
  });

  it("refuses to send a template with an unfilled placeholder", async () => {
    store.templates = [
      { ...DELIVERED_SMS, body: "LR {{lrNumber}} — ref {{invoiceRef}}" },
    ];

    const summary = await dispatchEvent(deliveredEvent());

    expect(summary.failed).toBe(1);
    expect(sends).toHaveLength(0);
    expect(store.logs[0].error).toContain("invoiceRef");
  });

  it("does nothing at all when no template matches the event", async () => {
    store.templates = [];

    const summary = await dispatchEvent(deliveredEvent());

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, duplicate: 0 });
    expect(store.logs).toHaveLength(0);
  });

  it("ignores an inactive template", async () => {
    store.templates = [{ ...DELIVERED_SMS, isActive: false }];

    expect((await dispatchEvent(deliveredEvent())).sent).toBe(0);
  });
});

/**
 * A placeholder with nothing behind it used to refuse the whole message,
 * whatever the reason it was empty. That is right for a name the trigger
 * cannot supply — a typo, or a template on the wrong trigger — and wrong
 * for a field of this consignment that is legitimately blank. It was the
 * second case that was actually happening: `codAmount` is null on every
 * consignment that is not COD, so the out-for-delivery message was refused
 * for the majority of parcels rather than sent without a figure.
 */
describe("placeholders with no value", () => {
  const OUT_FOR_DELIVERY = {
    ...DELIVERED_SMS,
    id: "tpl_ofd",
    code: "OUT_FOR_DELIVERY",
    eventType: "shipment.run_started",
    body: "{{brandName}}: LR {{lrNumber}} is out for delivery. COD due: {{codAmount}}.",
    variables: ["brandName", "lrNumber", "codAmount"],
  };

  function runStarted() {
    return {
      outboxId: "obx_run",
      eventType: "shipment.run_started",
      aggregate: "Shipment",
      aggregateId: "shp_1",
      payload: { eventId: "evt_run", runId: null, taskId: null },
    };
  }

  it("sends anyway when the trigger supplies the name but this shipment has no value", async () => {
    store.templates = [OUT_FOR_DELIVERY];
    store.shipment = { ...shipment(), codAmount: null, paymentType: "PAID" };

    const summary = await dispatchEvent(runStarted());

    expect(summary.failed).toBe(0);
    expect(summary.sent).toBe(1);
    expect(store.logs[0].status).toBe("SENT");
  });

  it("still refuses a name the trigger cannot supply at all", async () => {
    store.templates = [
      {
        ...OUT_FOR_DELIVERY,
        body: "{{brandName}}: {{lrNumber}} — {{invoiceBalance}}",
        variables: ["brandName", "lrNumber", "invoiceBalance"],
      },
    ];

    const summary = await dispatchEvent(runStarted());

    expect(summary.failed).toBe(1);
    expect(sends).toHaveLength(0);
    expect(store.logs[0].status).toBe("FAILED");
    expect(store.logs[0].error).toContain("invoiceBalance");
  });

  it("keeps a required name required, so a blank one still refuses", async () => {
    // `trackingUrl` and `lrNumber` are marked required in the catalogue: a
    // message inviting somebody to track a consignment on a link that is
    // not there is worse than no message. Everything else on a shipment may
    // legitimately be blank.
    const { requiredVariables } = await import("./variables");
    const required = requiredVariables("shipment.run_started");

    expect(required.has("trackingUrl")).toBe(true);
    expect(required.has("lrNumber")).toBe(true);
    expect(required.has("codAmount")).toBe(false);
  });
});

/**
 * The delivery OTP is what signs for the parcel. Sitting in the send log
 * next to the number it went to, it is authentication written down and
 * readable by everyone holding `master.read` — including the branch staff
 * whose delivery it would let them close without the consignee.
 */
describe("secrets in the send log", () => {
  it("sends the code to the gateway and never writes it down", async () => {
    store.templates = [
      {
        ...DELIVERED_SMS,
        id: "tpl_otp",
        code: "DELIVERY_OTP",
        eventType: "notification.delivery_otp",
        recipientKind: "CONSIGNEE",
        body: "{{otpCode}} is your {{brandName}} delivery code for {{lrNumber}}.",
        variables: ["otpCode", "brandName", "lrNumber"],
      },
    ];

    const summary = await dispatchEvent({
      outboxId: "obx_otp",
      eventType: "notification.delivery_otp",
      aggregate: "Shipment",
      aggregateId: "shp_1",
      payload: { eventId: "evt_otp", code: "482193" },
    });

    expect(summary.sent).toBe(1);
    expect(sends[0].body).toContain("482193");
    expect(store.logs[0].body).not.toContain("482193");
    expect(store.logs[0].body).toContain("••••");
  });
});
