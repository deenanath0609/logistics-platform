import { describe, expect, it } from "vitest";

// Nothing here touches a database or a request: every function under test
// is a pure rule. `getEnv()` is not reached, but the client module this
// file's imports pull in reads DATABASE_URL at construction.
process.env.DATABASE_URL ??= "postgres://unused/unused";

import {
  copiedNotificationTemplate,
  copiedNumberSeries,
  copiedPincode,
  normaliseMobile,
  validateProvisionShape,
  type ProvisionInput,
} from "@/lib/platform/provisioning";

// ────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────

const VALID: ProvisionInput = {
  name: "Acme Freight",
  legalName: "Acme Freight Private Limited",
  slug: "acme-freight",
  subdomain: "acme",
  lrPrefix: "AF",
  planId: null,
  templateOrgId: "org_template",
  branch: {
    code: "HO-DEL",
    name: "Head Office — Delhi",
    city: "Delhi",
    address: "Okhla Phase III",
    pincode: "110020",
    phone: "01141000100",
  },
  owner: {
    name: "Priya Rao",
    mobile: "9800000001",
    email: "priya@acmefreight.example",
  },
};

/** Deep-ish override, so a case can move one field without restating twelve. */
function input(patch: Partial<ProvisionInput> = {}): ProvisionInput {
  return {
    ...VALID,
    ...patch,
    branch: { ...VALID.branch, ...(patch.branch ?? {}) },
    owner: { ...VALID.owner, ...(patch.owner ?? {}) },
  };
}

describe("validateProvisionShape", () => {
  it("accepts a well-formed carrier", () => {
    expect(validateProvisionShape(VALID)).toBeNull();
  });

  it("refuses a reserved subdomain", () => {
    // `admin` is the operator console's own host. A carrier there would
    // serve the console from a tenant hostname, which is the boundary the
    // whole platform session design rests on.
    expect(validateProvisionShape(input({ subdomain: "admin" }))).toMatch(/reserved/i);
    expect(validateProvisionShape(input({ subdomain: "WWW" }))).toMatch(/reserved/i);
  });

  it("refuses a reserved slug too", () => {
    expect(validateProvisionShape(input({ slug: "api" }))).toMatch(/reserved/i);
  });

  it.each(["ab", "-acme", "acme-", "ac me", "acme.freight", "ACME_FREIGHT"])(
    "refuses %s as a DNS label",
    (value) => {
      expect(validateProvisionShape(input({ subdomain: value }))).toBeTruthy();
      expect(validateProvisionShape(input({ slug: value }))).toBeTruthy();
    },
  );

  it("accepts a three-character label, which is the floor", () => {
    expect(validateProvisionShape(input({ subdomain: "abc", slug: "abc" }))).toBeNull();
  });

  it.each(["A", "ABCDE", "A1", "", "ab cd"])(
    "refuses %s as an LR prefix",
    (value) => {
      expect(validateProvisionShape(input({ lrPrefix: value }))).toMatch(/LR prefix/i);
    },
  );

  it("accepts a lower-case LR prefix — it is upper-cased on save", () => {
    expect(validateProvisionShape(input({ lrPrefix: "af" }))).toBeNull();
  });

  it("requires a template to copy from", () => {
    expect(validateProvisionShape(input({ templateOrgId: "" }))).toMatch(
      /masters should be copied/i,
    );
  });

  it("requires a six-digit head-office PIN", () => {
    expect(
      validateProvisionShape(input({ branch: { ...VALID.branch, pincode: "11002" } })),
    ).toMatch(/six digits/i);
  });

  it("requires a head-office address — it is printed on documents", () => {
    expect(
      validateProvisionShape(input({ branch: { ...VALID.branch, address: "   " } })),
    ).toMatch(/address/i);
  });

  it("requires a usable owner mobile", () => {
    expect(
      validateProvisionShape(input({ owner: { ...VALID.owner, mobile: "98000" } })),
    ).toMatch(/mobile/i);
  });

  it("accepts a mobile written with a country code and spaces", () => {
    expect(
      validateProvisionShape(input({ owner: { ...VALID.owner, mobile: "+91 98000 00001" } })),
    ).toBeNull();
    expect(normaliseMobile("+91 98000 00001")).toBe("919800000001");
  });

  it("treats a blank owner email as absent rather than invalid", () => {
    expect(
      validateProvisionShape(input({ owner: { ...VALID.owner, email: null } })),
    ).toBeNull();
  });

  it("refuses an owner email that is not one", () => {
    expect(
      validateProvisionShape(input({ owner: { ...VALID.owner, email: "priya@" } })),
    ).toMatch(/email/i);
  });
});

// ────────────────────────────────────────────────────────────
// Copy rules
// ────────────────────────────────────────────────────────────

describe("copiedNumberSeries — counters reset", () => {
  const template = {
    document: "LR" as const,
    pattern: "{PREFIX}{YYYY}{MM}{DD}{SEQ}",
    prefix: "CL",
    padding: 4,
    resetPolicy: "DAILY" as const,
    currentValue: 84_213,
    periodKey: "2026-08-30",
    isActive: true,
  };

  it("starts the new carrier's counter at zero", () => {
    // Carrying 84,213 over would make the new carrier's first consignment
    // note bear a number the template has already printed and handed to a
    // customer.
    const copy = copiedNumberSeries(template, "org_new", "AF");
    expect(copy.currentValue).toBe(0);
    expect(copy.periodKey).toBeNull();
  });

  it("gives the LR series the new carrier's own prefix", () => {
    expect(copiedNumberSeries(template, "org_new", "AF").prefix).toBe("AF");
  });

  it("leaves every other document's prefix alone", () => {
    const invoice = { ...template, document: "INVOICE" as const, prefix: "INV" };
    expect(copiedNumberSeries(invoice, "org_new", "AF").prefix).toBe("INV");
  });

  it("keeps the shape — pattern, padding and reset policy", () => {
    const copy = copiedNumberSeries(template, "org_new", "AF");
    expect(copy.pattern).toBe(template.pattern);
    expect(copy.padding).toBe(4);
    expect(copy.resetPolicy).toBe("DAILY");
    expect(copy.orgId).toBe("org_new");
  });

  it("drops any branch scoping — the template's branches are not copied", () => {
    expect(copiedNumberSeries(template, "org_new", "AF").branchId).toBeNull();
  });
});

describe("copiedNotificationTemplate — DLT ids cleared", () => {
  const sms = {
    code: "SHIPMENT_DELIVERED",
    channel: "SMS" as const,
    eventType: "shipment.delivered",
    name: "Delivery confirmation",
    language: "en",
    subject: null,
    body: "Your consignment {{lrNumber}} has been delivered.",
    variables: ["lrNumber"],
    recipientKind: "CONSIGNEE" as const,
    dltTemplateId: "1207161234567890123",
    dltSenderId: "CLGSTC",
    isActive: true,
  };

  it("clears the DLT template and sender ids", () => {
    // Both are registered to one company with the telecom regulator. An
    // inherited sender header is rejected at the gateway, and a gateway
    // rejection looks identical to a successful queue from inside the app.
    const copy = copiedNotificationTemplate(sms, "org_new");
    expect(copy.dltTemplateId).toBeNull();
    expect(copy.dltSenderId).toBeNull();
  });

  it("copies SMS templates inactive, pending the carrier's own registration", () => {
    expect(copiedNotificationTemplate(sms, "org_new").isActive).toBe(false);
  });

  it("leaves email templates active — they need no DLT registration", () => {
    const email = { ...sms, channel: "EMAIL" as const, subject: "Delivered" };
    expect(copiedNotificationTemplate(email, "org_new").isActive).toBe(true);
  });

  it("respects a template the template tenant had already switched off", () => {
    const off = { ...sms, channel: "EMAIL" as const, isActive: false };
    expect(copiedNotificationTemplate(off, "org_new").isActive).toBe(false);
  });

  it("keeps the body and its declared variables verbatim", () => {
    const copy = copiedNotificationTemplate(sms, "org_new");
    expect(copy.body).toBe(sms.body);
    expect(copy.variables).toEqual(["lrNumber"]);
    expect(copy.orgId).toBe("org_new");
  });
});

describe("copiedPincode — serving branch nulled", () => {
  const pin = {
    code: "110020",
    cityId: "city_template_del",
    areaName: "Okhla Industrial Area",
    latitude: null,
    longitude: null,
    isServiceable: true,
    isOda: false,
    servingBranchId: "branch_template_hub_del",
  };

  it("drops the serving branch", () => {
    // It names one of the template's branches, and the template's branch
    // network is not copied. Left in place it would either break the
    // foreign key or route the new carrier's deliveries to another
    // company's hub.
    expect(copiedPincode(pin, "org_new", "city_new_del").servingBranchId).toBeNull();
  });

  it("re-points the pincode at the newly copied city", () => {
    const copy = copiedPincode(pin, "org_new", "city_new_del");
    expect(copy.cityId).toBe("city_new_del");
    expect(copy.orgId).toBe("org_new");
  });

  it("keeps serviceability and ODA, which are facts the template curated", () => {
    const oda = { ...pin, isServiceable: false, isOda: true };
    const copy = copiedPincode(oda, "org_new", "city_new_del");
    expect(copy.isServiceable).toBe(false);
    expect(copy.isOda).toBe(true);
    expect(copy.areaName).toBe("Okhla Industrial Area");
  });
});
