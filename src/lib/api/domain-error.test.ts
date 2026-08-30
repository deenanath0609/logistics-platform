import { describe, expect, it } from "vitest";
import { partnerFacingError } from "./domain-error";

describe("partnerFacingError", () => {
  it("forwards a validation message that names a field", () => {
    // These are written by hand for a person to read, and a partner needs
    // them: without the message, a 422 is a guessing game.
    const safe = partnerFacingError({
      error: "COD is not offered on EXP.",
      field: "paymentType",
    });
    expect(safe).toEqual({
      message: "COD is not offered on EXP.",
      field: "paymentType",
    });
  });

  it("withholds an unfielded message, which may be an exception's", () => {
    // `createBooking` ends in a catch returning `error.message` verbatim.
    // This one names a Prisma model and column; it went into a 422 body on
    // the public internet.
    const safe = partnerFacingError({
      error:
        "Invalid `prisma.shipment.create()` invocation: Null constraint failed on the fields: (`consignorId`)",
    });
    expect(safe.message).not.toContain("prisma");
    expect(safe.message).not.toContain("consignorId");
    expect(safe.withheld).toContain("prisma.shipment.create");
  });

  it("withholds a tenant-context failure, which carries two organisation ids", () => {
    const safe = partnerFacingError({
      error:
        "TenantContextError: row belongs to org_9f2c but the request resolved org_41ab",
    });
    expect(safe.message).not.toContain("org_9f2c");
    expect(safe.message).not.toContain("org_41ab");
  });

  it("still says something a partner can act on", () => {
    const safe = partnerFacingError({ error: "boom" });
    expect(safe.message).toMatch(/request id/i);
    expect(safe.field).toBeUndefined();
  });
});
