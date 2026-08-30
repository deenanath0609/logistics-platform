import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  effectiveScopes,
  generateApiKey,
  grantableScopes,
  hashApiKey,
  ipAllowed,
  ipInCidr,
  keyPrefixOf,
  parseApiKeyHeader,
  verifyApiKey,
  type ApiKeyRecord,
} from "./api-key";

const NOW = new Date("2026-08-27T10:00:00.000Z");

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: "key_1",
    orgId: "org_1",
    name: "Sharma Distributors ERP",
    keyHash: "",
    keyPrefix: "",
    scopes: ["shipment.create", "shipment.read"],
    ipAllowlist: [],
    customerId: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

/** A matched pair: the key a partner holds and the row we store. */
function issued(overrides: Partial<ApiKeyRecord> = {}) {
  const generated = generateApiKey();
  return {
    key: generated.key,
    row: record({
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      ...overrides,
    }),
  };
}

describe("generateApiKey", () => {
  it("issues a prefixed key and stores only its digest", () => {
    const generated = generateApiKey();

    expect(generated.key.startsWith(`${API_KEY_PREFIX}_`)).toBe(true);
    expect(generated.keyHash).toBe(hashApiKey(generated.key));
    // The stored material must not contain the key itself.
    expect(generated.keyHash).not.toContain(generated.key);
    expect(generated.key).not.toBe(generated.keyHash);
  });

  it("never issues the same key twice", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
  });

  it("stores a prefix that can be looked up from the presented key", () => {
    const generated = generateApiKey();
    expect(keyPrefixOf(generated.key)).toBe(generated.keyPrefix);
    // The prefix is a handle, not the secret: it must be far shorter.
    expect(generated.keyPrefix.length).toBeLessThan(generated.key.length / 2);
  });

  it("rejects anything that is not shaped like a key", () => {
    expect(keyPrefixOf("")).toBeNull();
    expect(keyPrefixOf("hunter2")).toBeNull();
    expect(keyPrefixOf("clk_zzzzzzzz_" + "a".repeat(48))).toBeNull();
    expect(keyPrefixOf("clk_1234abcd_short")).toBeNull();
  });
});

describe("parseApiKeyHeader", () => {
  it("reads a Bearer token", () => {
    expect(parseApiKeyHeader("Bearer clk_abc")).toBe("clk_abc");
    expect(parseApiKeyHeader("bearer   clk_abc  ")).toBe("clk_abc");
  });

  it("reads the ApiKey scheme and a bare value", () => {
    expect(parseApiKeyHeader("ApiKey clk_abc")).toBe("clk_abc");
    expect(parseApiKeyHeader("clk_abc")).toBe("clk_abc");
  });

  it("prefers an explicit X-Api-Key header", () => {
    expect(parseApiKeyHeader("Bearer other", "clk_abc")).toBe("clk_abc");
  });

  it("returns null when there is nothing to read", () => {
    expect(parseApiKeyHeader(null)).toBeNull();
    expect(parseApiKeyHeader("   ")).toBeNull();
    expect(parseApiKeyHeader(undefined, "  ")).toBeNull();
  });
});

describe("ipInCidr", () => {
  it("matches a bare address exactly", () => {
    expect(ipInCidr("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(ipInCidr("203.0.113.8", "203.0.113.7")).toBe(false);
  });

  it("matches inside an IPv4 block", () => {
    expect(ipInCidr("203.0.113.7", "203.0.113.0/24")).toBe(true);
    expect(ipInCidr("203.0.113.255", "203.0.113.0/24")).toBe(true);
    expect(ipInCidr("203.0.114.1", "203.0.113.0/24")).toBe(false);
  });

  it("handles the edges of the prefix range", () => {
    expect(ipInCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
    expect(ipInCidr("10.1.2.3", "10.1.2.3/32")).toBe(true);
    expect(ipInCidr("10.1.2.4", "10.1.2.3/32")).toBe(false);
    expect(ipInCidr("172.16.5.9", "172.16.0.0/12")).toBe(true);
    expect(ipInCidr("172.32.5.9", "172.16.0.0/12")).toBe(false);
  });

  it("refuses malformed rules rather than guessing", () => {
    expect(ipInCidr("203.0.113.7", "203.0.113.0/33")).toBe(false);
    expect(ipInCidr("203.0.113.7", "203.0.113.0/abc")).toBe(false);
    expect(ipInCidr("203.0.113.7", "not-an-address")).toBe(false);
    expect(ipInCidr("203.0.113.7", "")).toBe(false);
    expect(ipInCidr("999.0.113.7", "999.0.113.0/24")).toBe(false);
  });
});

describe("ipAllowed", () => {
  it("allows anything when the list is empty", () => {
    expect(ipAllowed("203.0.113.7", [])).toBe(true);
    expect(ipAllowed(null, [])).toBe(true);
  });

  it("refuses an unknown caller when a list exists", () => {
    expect(ipAllowed(null, ["203.0.113.0/24"])).toBe(false);
    expect(ipAllowed("198.51.100.4", ["203.0.113.0/24"])).toBe(false);
  });

  it("accepts a caller matching any entry", () => {
    expect(ipAllowed("198.51.100.4", ["203.0.113.0/24", "198.51.100.4"])).toBe(true);
  });
});

/**
 * A key may never carry more than the person who issued it holds, and may
 * never keep carrying it after they stop holding it. Both halves were
 * promised — in the guard's doc comment and on the issue form — and
 * neither was checked anywhere.
 */
describe("grantableScopes", () => {
  const catalogue = new Set(["shipment.create", "shipment.read", "pickup.create"]);

  it("grants what the issuer holds", () => {
    const { granted, refused } = grantableScopes(
      ["shipment.create", "shipment.read"],
      catalogue,
      new Set(["shipment.create", "shipment.read", "apikey.manage"]),
    );
    expect(granted).toEqual(["shipment.create", "shipment.read"]);
    expect(refused).toEqual([]);
  });

  it("refuses a scope the issuer does not hold themselves", () => {
    // The escalation: `apikey.manage` alone used to be enough to mint a key
    // that creates pickups, which the issuer's own account cannot do.
    const { granted, refused } = grantableScopes(
      ["pickup.create"],
      catalogue,
      new Set(["apikey.manage"]),
    );
    expect(granted).toEqual([]);
    expect(refused).toEqual(["pickup.create"]);
  });

  it("refuses a scope outside the catalogue however privileged the issuer", () => {
    const { refused } = grantableScopes(
      ["shipment.cancel"],
      catalogue,
      new Set(["shipment.cancel", "apikey.manage"]),
    );
    expect(refused).toEqual(["shipment.cancel"]);
  });

  it("keeps every scope asked for, not just the first", () => {
    // The form posts one `scopes` entry per ticked checkbox. Reading it
    // with `get` instead of `getAll` meant every multi-scope key ever
    // issued stored exactly one scope.
    const holder = new Set(["shipment.create", "shipment.read", "pickup.create"]);
    const { granted } = grantableScopes(
      ["shipment.create", "shipment.read", "pickup.create"],
      catalogue,
      holder,
    );
    expect(granted).toHaveLength(3);
  });

  it("de-duplicates rather than storing a scope twice", () => {
    const { granted } = grantableScopes(
      ["shipment.read", "shipment.read"],
      catalogue,
      new Set(["shipment.read"]),
    );
    expect(granted).toEqual(["shipment.read"]);
  });
});

describe("effectiveScopes", () => {
  it("is the key's scopes narrowed by what its owner holds today", () => {
    expect([
      ...effectiveScopes(
        ["shipment.create", "pickup.create"],
        new Set(["shipment.create"]),
      ),
    ]).toEqual(["shipment.create"]);
  });

  it("empties when the owner's role is revoked", () => {
    // Revoking somebody's role has to disable the keys they issued. It did
    // not: the guard admitted a request on `scopes` alone.
    expect(effectiveScopes(["shipment.create"], new Set()).size).toBe(0);
  });
});

describe("verifyApiKey", () => {
  it("accepts a valid key", () => {
    const { key, row } = issued();
    const result = verifyApiKey({
      presented: key,
      record: row,
      requiredScope: "shipment.create",
      address: "203.0.113.7",
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key.id).toBe("key_1");
  });

  it("refuses a revoked key", () => {
    const { key, row } = issued({ revokedAt: new Date("2026-08-01T00:00:00Z") });
    const result = verifyApiKey({ presented: key, record: row, now: NOW });

    expect(result).toMatchObject({ ok: false, code: "revoked", status: 401 });
  });

  it("still accepts a key revoked in the future — revocation is not retroactive", () => {
    const { key, row } = issued({ revokedAt: new Date("2026-09-01T00:00:00Z") });
    expect(verifyApiKey({ presented: key, record: row, now: NOW }).ok).toBe(true);
  });

  it("refuses an expired key", () => {
    const { key, row } = issued({ expiresAt: new Date("2026-08-26T23:59:00Z") });
    const result = verifyApiKey({ presented: key, record: row, now: NOW });

    expect(result).toMatchObject({ ok: false, code: "expired", status: 401 });
  });

  it("accepts a key that has not expired yet", () => {
    const { key, row } = issued({ expiresAt: new Date("2027-01-01T00:00:00Z") });
    expect(verifyApiKey({ presented: key, record: row, now: NOW }).ok).toBe(true);
  });

  it("refuses a key without the scope for this endpoint", () => {
    const { key, row } = issued({ scopes: ["shipment.read"] });
    const result = verifyApiKey({
      presented: key,
      record: row,
      requiredScope: "shipment.create",
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, code: "scope", status: 403 });
    if (!result.ok) expect(result.message).toContain("shipment.create");
  });

  it("refuses a caller outside the allowlist", () => {
    const { key, row } = issued({ ipAllowlist: ["203.0.113.0/24"] });
    const result = verifyApiKey({
      presented: key,
      record: row,
      address: "198.51.100.9",
      addressTrusted: true,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, code: "ip", status: 403 });
  });

  it("accepts a caller inside the allowlist", () => {
    const { key, row } = issued({ ipAllowlist: ["203.0.113.0/24"] });
    expect(
      verifyApiKey({
        presented: key,
        record: row,
        address: "203.0.113.9",
        addressTrusted: true,
        now: NOW,
      }).ok,
    ).toBe(true);
  });

  it("refuses an allowlisted key when the address is not vouched for", () => {
    // The allowlist used to be checked against the leftmost
    // `X-Forwarded-For` entry — a value the caller writes — so satisfying
    // it was a matter of typing the allowed address into a header. An
    // address nothing vouches for now fails the check outright rather than
    // being compared, and the message says what to configure.
    const { key, row } = issued({ ipAllowlist: ["203.0.113.0/24"] });
    const result = verifyApiKey({
      presented: key,
      record: row,
      address: "203.0.113.9",
      addressTrusted: false,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, code: "ip", status: 403 });
    if (!result.ok) expect(result.message).toContain("TRUSTED_PROXY_HOPS");
  });

  it("leaves a key with no allowlist unaffected by all of that", () => {
    // Most keys have no allowlist, and they must not start failing because
    // the deployment cannot identify the caller.
    const { key, row } = issued({ ipAllowlist: [] });
    expect(
      verifyApiKey({
        presented: key,
        record: row,
        address: null,
        addressTrusted: false,
        now: NOW,
      }).ok,
    ).toBe(true);
  });

  it("refuses a caller whose address we cannot see when a list exists", () => {
    const { key, row } = issued({ ipAllowlist: ["203.0.113.0/24"] });
    const result = verifyApiKey({
      presented: key,
      record: row,
      address: null,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, code: "ip" });
  });

  it("refuses a key whose digest does not match the row", () => {
    const other = generateApiKey();
    const { row } = issued();
    const result = verifyApiKey({ presented: other.key, record: row, now: NOW });

    expect(result).toMatchObject({ ok: false, code: "unknown", status: 401 });
  });

  it("refuses when no row was found for the prefix", () => {
    const { key } = issued();
    const result = verifyApiKey({ presented: key, record: null, now: NOW });

    expect(result).toMatchObject({ ok: false, code: "unknown", status: 401 });
  });

  it("refuses a missing or malformed key before touching the database result", () => {
    expect(verifyApiKey({ presented: null, record: null, now: NOW })).toMatchObject({
      code: "malformed",
      status: 401,
    });
    expect(verifyApiKey({ presented: "hunter2", record: null, now: NOW })).toMatchObject(
      { code: "malformed" },
    );
  });

  it("checks revocation before scope, so the message names the real problem", () => {
    const { key, row } = issued({
      revokedAt: new Date("2026-08-01T00:00:00Z"),
      scopes: [],
    });
    const result = verifyApiKey({
      presented: key,
      record: row,
      requiredScope: "shipment.create",
      now: NOW,
    });

    expect(result).toMatchObject({ code: "revoked" });
  });
});
