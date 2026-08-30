import { describe, expect, it } from "vitest";
import { ALLOWED_API_SCOPES, requestedScopes } from "./scopes";

/**
 * The issue-key form renders one checkbox per scope, and every one of them
 * is named `scopes`. Reading that with `formData.get` returns the first
 * ticked box and drops the rest without complaint, which is how every
 * multi-scope key issued through the screen came to hold exactly one.
 */
describe("requestedScopes", () => {
  it("keeps every ticked checkbox, not just the first", () => {
    const form = new FormData();
    form.append("scopes", "shipment.create");
    form.append("scopes", "shipment.read");
    form.append("scopes", "pickup.create");

    expect(requestedScopes(form)).toEqual([
      "shipment.create",
      "shipment.read",
      "pickup.create",
    ]);
  });

  it("is empty when nothing was ticked", () => {
    expect(requestedScopes(new FormData())).toEqual([]);
  });

  it("also accepts a single pasted list, however it was separated", () => {
    const form = new FormData();
    form.append("scopes", "shipment.create, shipment.read");
    expect(requestedScopes(form)).toEqual(["shipment.create", "shipment.read"]);
  });

  it("drops the blanks an unticked control leaves behind", () => {
    const form = new FormData();
    form.append("scopes", "");
    form.append("scopes", "  ");
    form.append("scopes", "shipment.read");
    expect(requestedScopes(form)).toEqual(["shipment.read"]);
  });
});

describe("ALLOWED_API_SCOPES", () => {
  it("offers nothing that cancels, corrects or touches money", () => {
    // Those need a person, and the audit trail should name one.
    for (const scope of ALLOWED_API_SCOPES) {
      expect(scope).not.toMatch(/cancel|invoice|payment|delete|override/);
    }
  });
});
