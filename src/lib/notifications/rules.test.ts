import { describe, expect, it } from "vitest";
import {
  dedupeKeyFor,
  isOptedOut,
  shouldAttempt,
  suppressReason,
  type PreferenceRow,
} from "./rules";
import { maskEmail, maskPhone, maskRecipient } from "./mask";

describe("dedupeKeyFor", () => {
  const base = {
    eventKey: "evt_9f2",
    templateId: "tpl_delivered_sms",
    channel: "SMS" as const,
    recipient: "9876543210",
  };

  it("is stable across replays of the same outbox event", () => {
    expect(dedupeKeyFor(base)).toBe(dedupeKeyFor({ ...base }));
  });

  it("separates two occurrences of the same event type", () => {
    // Two failed delivery attempts on one consignment are two notifications.
    expect(dedupeKeyFor({ ...base, eventKey: "evt_9f3" })).not.toBe(
      dedupeKeyFor(base),
    );
  });

  it("separates the SMS from the WhatsApp for the same occurrence", () => {
    expect(dedupeKeyFor({ ...base, channel: "WHATSAPP" })).not.toBe(
      dedupeKeyFor(base),
    );
  });

  it("separates two templates on the same event", () => {
    expect(dedupeKeyFor({ ...base, templateId: "tpl_delivered_email" })).not.toBe(
      dedupeKeyFor(base),
    );
  });

  it("separates each recipient of a fanned-out template", () => {
    expect(dedupeKeyFor({ ...base, recipient: "9999999999" })).not.toBe(
      dedupeKeyFor(base),
    );
  });

  it("normalises recipient casing and padding so one address is one key", () => {
    const a = dedupeKeyFor({ ...base, recipient: "Ops@Acme.co.in" });
    const b = dedupeKeyFor({ ...base, recipient: "  ops@acme.co.in " });
    expect(a).toBe(b);
  });
});

describe("shouldAttempt", () => {
  it("sends when nothing has been attempted", () => {
    expect(shouldAttempt(null)).toBe(true);
  });

  it("retries a send the gateway explicitly rejected", () => {
    expect(shouldAttempt("FAILED")).toBe(true);
  });

  it("never resends after a successful send", () => {
    expect(shouldAttempt("SENT")).toBe(false);
    expect(shouldAttempt("DELIVERED")).toBe(false);
  });

  it("does not resend a message that was skipped by choice", () => {
    expect(shouldAttempt("SKIPPED")).toBe(false);
  });

  it("does not resend a row stuck at QUEUED", () => {
    // We cannot tell whether the gateway took it. One missed SMS beats a
    // duplicate OTP; the stuck row stays visible on the send log.
    expect(shouldAttempt("QUEUED")).toBe(false);
  });

  it("does not resend to an address that bounced", () => {
    expect(shouldAttempt("BOUNCED")).toBe(false);
  });
});

describe("isOptedOut", () => {
  const rows: PreferenceRow[] = [
    { eventType: "shipment.booking_created", channel: "SMS", enabled: false },
    { eventType: "shipment.delivered", channel: "EMAIL", enabled: true },
  ];

  it("sends when there is no row at all", () => {
    expect(isOptedOut(rows, "shipment.gate_out", "SMS")).toBe(false);
  });

  it("sends when the row exists and is enabled", () => {
    expect(isOptedOut(rows, "shipment.delivered", "EMAIL")).toBe(false);
  });

  it("suppresses on an explicit disabled row", () => {
    expect(isOptedOut(rows, "shipment.booking_created", "SMS")).toBe(true);
  });

  it("does not leak an opt-out across channels", () => {
    expect(isOptedOut(rows, "shipment.booking_created", "EMAIL")).toBe(false);
  });

  it("treats a wildcard row as 'stop texting me'", () => {
    const stop: PreferenceRow[] = [
      { eventType: "*", channel: "SMS", enabled: false },
    ];
    expect(isOptedOut(stop, "shipment.delivered", "SMS")).toBe(true);
    expect(isOptedOut(stop, "shipment.delivered", "WHATSAPP")).toBe(false);
  });

  it("sends when the preference list is empty", () => {
    expect(isOptedOut([], "shipment.delivered", "SMS")).toBe(false);
  });
});

describe("suppressReason", () => {
  it("lets an ordinary event through", () => {
    expect(suppressReason("shipment.delivered", {})).toBeNull();
  });

  it("suppresses an arrival scan at a transit hub", () => {
    expect(
      suppressReason("shipment.gate_in", {
        branchId: "hub_jaipur_transit",
        destinationBranchId: "br_jaipur_city",
      }),
    ).toMatch(/transit hub/);
  });

  it("allows the arrival scan at the destination branch", () => {
    expect(
      suppressReason("shipment.gate_in", {
        branchId: "br_jaipur_city",
        destinationBranchId: "br_jaipur_city",
      }),
    ).toBeNull();
  });

  it("suppresses an arrival scan with no branch rather than guessing", () => {
    expect(
      suppressReason("shipment.gate_in", {
        branchId: null,
        destinationBranchId: "br_jaipur_city",
      }),
    ).not.toBeNull();
  });
});

describe("masking", () => {
  it("keeps enough of a phone number to recognise, not enough to dial", () => {
    expect(maskPhone("9876543210")).toBe("98•••43210");
    expect(maskPhone("9876543210")).not.toContain("65");
  });

  it("masks a short number entirely", () => {
    expect(maskPhone("1800")).toBe("••••");
  });

  it("keeps the email domain, which is what identifies the account", () => {
    expect(maskEmail("priya.sharma@acme.co.in")).toBe("pr••••••••••@acme.co.in");
  });

  it("handles a two-character local part", () => {
    expect(maskEmail("hr@acme.co.in")).toBe("h••@acme.co.in");
  });

  it("routes by the value, not by a channel column", () => {
    expect(maskRecipient("ops@acme.co.in")).toContain("@");
    expect(maskRecipient("9876543210")).toBe("98•••43210");
  });
});
