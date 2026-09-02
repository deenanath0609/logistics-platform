import { describe, expect, it } from "vitest";
import {
  CUSTOMER_SUBJECT_PREFIX,
  PLATFORM_SUBJECT_PREFIX,
  customerSubject,
  isCustomerSubject,
  isPlatformSubject,
  platformSubject,
  readCustomerSubject,
  readPlatformSubject,
} from "./subject";

/**
 * The boundary between the three populations that sign in.
 *
 * Six of these eight exports are the only thing keeping a portal customer,
 * a tenant staff member and a platform operator out of each other's
 * sessions, and none of them was named by a test or a verify script.
 * `session.ts` returns null for a prefixed subject on lines 111 and 119;
 * `customer-session.ts` resolves a customer *only* from a prefixed one;
 * `platform/session.ts` mints and reads the operator cookie through the
 * other pair. Every one of those is a single boolean away from a
 * cross-realm login.
 *
 * The functions are three lines each, which is exactly why nobody tested
 * them and exactly why the failure would be total rather than partial.
 *
 * ── What "null" has to mean ─────────────────────────────────────────────
 *
 * The header of the module under test says callers must treat null as "not
 * a customer", never as "any customer". These tests hold the reader to the
 * matching half: every reader returns null for every subject that is not
 * its own, and never an empty string, and never the subject itself.
 */

/** A staff subject is a bare cuid — no prefix at all. */
const STAFF = "cmg7k2p3q0000v8x4h1n2m5t9";
const CUSTOMER_ID = "cmg7k2p3q0001v8x4h1n2m5ta";
const ADMIN_ID = "cmg7k2p3q0002v8x4h1n2m5tb";

describe("the prefixes", () => {
  it("cannot occur inside a cuid, which is what makes the namespace work", () => {
    // The whole scheme rests on this: `getCurrentUser()` looks the subject
    // up in `app_user`, and a prefixed subject must be unable to collide
    // with a row there even by accident.
    expect(CUSTOMER_SUBJECT_PREFIX).toBe("customer:");
    expect(PLATFORM_SUBJECT_PREFIX).toBe("platform:");
    for (const prefix of [CUSTOMER_SUBJECT_PREFIX, PLATFORM_SUBJECT_PREFIX]) {
      expect(prefix).toContain(":");
      expect(STAFF).not.toContain(prefix);
      expect(/^[a-z0-9]+$/.test(STAFF)).toBe(true);
    }
  });

  it("uses two prefixes that are not a prefix of one another", () => {
    expect(CUSTOMER_SUBJECT_PREFIX.startsWith(PLATFORM_SUBJECT_PREFIX)).toBe(false);
    expect(PLATFORM_SUBJECT_PREFIX.startsWith(CUSTOMER_SUBJECT_PREFIX)).toBe(false);
  });
});

describe("round trip", () => {
  it("returns the id it was given, for each realm", () => {
    expect(readCustomerSubject(customerSubject(CUSTOMER_ID))).toBe(CUSTOMER_ID);
    expect(readPlatformSubject(platformSubject(ADMIN_ID))).toBe(ADMIN_ID);
  });

  it("does not double-prefix an already-wrapped subject on re-entry", () => {
    // Wrapping twice would still read back — as `customer:<id>`, which is
    // not a `CustomerUser.id` and resolves to nobody.
    const twice = customerSubject(customerSubject(CUSTOMER_ID));
    expect(readCustomerSubject(twice)).toBe(`${CUSTOMER_SUBJECT_PREFIX}${CUSTOMER_ID}`);
    expect(readCustomerSubject(twice)).not.toBe(CUSTOMER_ID);
  });
});

describe("no reader answers for another realm", () => {
  const subjects = {
    staff: STAFF,
    customer: customerSubject(CUSTOMER_ID),
    platform: platformSubject(ADMIN_ID),
  };

  it("reads a customer id only out of a customer subject", () => {
    expect(readCustomerSubject(subjects.customer)).toBe(CUSTOMER_ID);
    expect(readCustomerSubject(subjects.platform)).toBeNull();
    expect(readCustomerSubject(subjects.staff)).toBeNull();
  });

  it("reads an operator id only out of a platform subject", () => {
    expect(readPlatformSubject(subjects.platform)).toBe(ADMIN_ID);
    expect(readPlatformSubject(subjects.customer)).toBeNull();
    expect(readPlatformSubject(subjects.staff)).toBeNull();
  });

  it("recognises each subject as exactly one realm", () => {
    expect([isCustomerSubject(subjects.staff), isPlatformSubject(subjects.staff)]).toEqual([
      false,
      false,
    ]);
    expect([
      isCustomerSubject(subjects.customer),
      isPlatformSubject(subjects.customer),
    ]).toEqual([true, false]);
    expect([
      isCustomerSubject(subjects.platform),
      isPlatformSubject(subjects.platform),
    ]).toEqual([false, true]);
  });
});

describe("what a hostile or broken subject reads as", () => {
  /**
   * `readCustomerSubject` slicing a prefix off blindly would turn a bare
   * `"customer:"` into `""`, and an empty string is falsy — which is fine
   * until it is passed to a `findUnique` that treats an empty `where` as no
   * filter. The module returns null for it instead, and this is the test
   * that says so.
   */
  it("returns null rather than an empty id for a prefix with nothing after it", () => {
    expect(readCustomerSubject(CUSTOMER_SUBJECT_PREFIX)).toBeNull();
    expect(readPlatformSubject(PLATFORM_SUBJECT_PREFIX)).toBeNull();
    // …while still classifying them as belonging to that realm, so
    // `getCurrentUser()` refuses them rather than treating them as staff.
    expect(isCustomerSubject(CUSTOMER_SUBJECT_PREFIX)).toBe(true);
    expect(isPlatformSubject(PLATFORM_SUBJECT_PREFIX)).toBe(true);
  });

  it("treats a missing subject as nobody, in every realm", () => {
    for (const subject of [null, undefined, ""]) {
      expect(isCustomerSubject(subject), String(subject)).toBe(false);
      expect(isPlatformSubject(subject), String(subject)).toBe(false);
      expect(readCustomerSubject(subject), String(subject)).toBeNull();
      expect(readPlatformSubject(subject), String(subject)).toBeNull();
    }
  });

  it("matches the prefix only at the start", () => {
    // An id that merely contains the word is staff, not a customer.
    for (const subject of [
      `x${CUSTOMER_SUBJECT_PREFIX}${CUSTOMER_ID}`,
      ` ${CUSTOMER_SUBJECT_PREFIX}${CUSTOMER_ID}`,
      `user-customer:${CUSTOMER_ID}`,
    ]) {
      expect(isCustomerSubject(subject), subject).toBe(false);
      expect(readCustomerSubject(subject), subject).toBeNull();
    }
    expect(isPlatformSubject(`x${PLATFORM_SUBJECT_PREFIX}${ADMIN_ID}`)).toBe(false);
  });

  it("is case-sensitive, so a re-cased cookie does not change realm", () => {
    expect(isCustomerSubject(`Customer:${CUSTOMER_ID}`)).toBe(false);
    expect(isPlatformSubject(`PLATFORM:${ADMIN_ID}`)).toBe(false);
  });

  it("does not let a customer id shaped like a platform subject cross over", () => {
    // The failure mode this guards: an attacker-chosen id, or a copied
    // token, whose payload is itself a prefixed string.
    const nested = customerSubject(`${PLATFORM_SUBJECT_PREFIX}${ADMIN_ID}`);

    expect(isCustomerSubject(nested)).toBe(true);
    expect(isPlatformSubject(nested)).toBe(false);
    expect(readPlatformSubject(nested)).toBeNull();
    // It reads back as a customer id that happens to contain a colon, and
    // will resolve against `customer_user` to nothing.
    expect(readCustomerSubject(nested)).toBe(`${PLATFORM_SUBJECT_PREFIX}${ADMIN_ID}`);
  });
});
