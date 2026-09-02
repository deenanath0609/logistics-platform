import { describe, expect, it } from "vitest";
import { headerSafe } from "./email";
import { toMsg91Mobile } from "./sms";

/**
 * The two places customer-supplied text meets a gateway's wire format.
 *
 * Both adapters are otherwise untestable without a relay or an aggregator
 * account, and both of these are pure — which is exactly why the parts worth
 * getting wrong were pulled out into functions rather than left inline.
 */

describe("an email header cannot be escaped", () => {
  it("strips a newline that would begin a second header", () => {
    // The whole attack: everything after the break is a header of the
    // sender's choosing, on a message signed as the carrier.
    expect(headerSafe("Your parcel\r\nBcc: everyone@example.com")).toBe(
      "Your parcel Bcc: everyone@example.com",
    );
  });

  it.each([
    ["a bare line feed", "Delivered\nX-Spoof: yes"],
    ["a bare carriage return", "Delivered\rX-Spoof: yes"],
    ["a run of them", "Delivered\r\n\r\n\nX-Spoof: yes"],
  ])("collapses %s", (_label, value) => {
    const safe = headerSafe(value);
    expect(safe).not.toMatch(/[\r\n]/);
    expect(safe).toBe("Delivered X-Spoof: yes");
  });

  it("leaves an ordinary subject alone", () => {
    expect(headerSafe("LR CL202609020065 — out for delivery")).toBe(
      "LR CL202609020065 — out for delivery",
    );
  });

  it("trims, so a subject of only whitespace is empty rather than blank-looking", () => {
    expect(headerSafe("  \r\n  ")).toBe("");
  });
});

describe("a mobile number as MSG91 wants it", () => {
  it.each([
    ["9811100011", "919811100011", "ten digits as typed at a counter"],
    ["+91 98111 00011", "919811100011", "the way a customer writes it"],
    ["098111-00011", "919811100011", "with the trunk prefix and a dash"],
    ["919811100011", "919811100011", "already carrying its country code"],
  ])("%s becomes %s — %s", (input, expected) => {
    expect(toMsg91Mobile(input)).toBe(expected);
  });

  it("refuses a number that is short, rather than sending it somewhere", () => {
    // The aggregator accepts a malformed number and reports it undelivered
    // hours later, by which time nobody has been told anything. Better to
    // fail here, where the log records why.
    expect(toMsg91Mobile("98111")).toBeNull();
  });

  it("refuses a number that is too long to be one", () => {
    expect(toMsg91Mobile("9811100011981110001198")).toBeNull();
  });

  it("refuses a landline written as a name", () => {
    expect(toMsg91Mobile("front desk")).toBeNull();
  });

  it("takes a country code other than India when told one", () => {
    expect(toMsg91Mobile("5551234567", "1")).toBe("15551234567");
  });
});
