import { describe, expect, it } from "vitest";
import { normaliseHost, parseTenantHost, tenantOrigin } from "@/lib/tenant/host";

describe("normaliseHost", () => {
  it("strips the port and lower-cases", () => {
    expect(normaliseHost("Acme.Platform.com:3010")).toBe("acme.platform.com");
  });

  it("keeps an IPv6 literal intact", () => {
    expect(normaliseHost("[::1]:3010")).toBe("[::1]");
  });

  it("treats blank and missing alike", () => {
    expect(normaliseHost("   ")).toBeNull();
    expect(normaliseHost(null)).toBeNull();
  });
});

describe("parseTenantHost", () => {
  const root = "platform.com";

  it("reads the first label as the tenant", () => {
    expect(parseTenantHost("acme.platform.com", root)).toEqual({
      kind: "subdomain",
      value: "acme",
    });
  });

  it("works the same way in development", () => {
    expect(parseTenantHost("acme.localhost:3010", "localhost")).toEqual({
      kind: "subdomain",
      value: "acme",
    });
  });

  it("refuses the bare platform domain", () => {
    expect(parseTenantHost("platform.com", root)).toBeNull();
    expect(parseTenantHost("localhost:3010", "localhost")).toBeNull();
  });

  it("refuses reserved labels so a tenant cannot be provisioned onto one", () => {
    for (const reserved of ["www", "api", "admin", "app"]) {
      expect(parseTenantHost(`${reserved}.platform.com`, root)).toBeNull();
    }
  });

  it("refuses a deeper name rather than guessing which label was meant", () => {
    expect(parseTenantHost("a.b.platform.com", root)).toBeNull();
  });

  it("refuses labels too short or malformed to be a real tenant", () => {
    expect(parseTenantHost("ab.platform.com", root)).toBeNull();
    expect(parseTenantHost("-acme.platform.com", root)).toBeNull();
    expect(parseTenantHost("acme-.platform.com", root)).toBeNull();
  });

  it("treats an unrelated host as a custom domain, matched whole", () => {
    expect(parseTenantHost("track.acmelogistics.com", root)).toEqual({
      kind: "customDomain",
      value: "track.acmelogistics.com",
    });
  });
});

describe("tenantOrigin", () => {
  it("prefers a custom domain once the tenant brings one", () => {
    expect(
      tenantOrigin(
        { subdomain: "acme", customDomain: "track.acmelogistics.com" },
        "platform.com",
      ),
    ).toBe("https://track.acmelogistics.com");
  });

  it("falls back to the subdomain", () => {
    expect(
      tenantOrigin({ subdomain: "acme", customDomain: null }, "platform.com"),
    ).toBe("https://acme.platform.com");
  });
});
