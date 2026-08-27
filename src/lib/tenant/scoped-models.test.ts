import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  OPERATOR_OWNED_MODELS,
  TENANT_OPTIONAL_MODELS,
  TENANT_SCOPED_MODELS,
  UNSCOPED_MODELS,
} from "@/lib/tenant/scoped-models.generated";

/**
 * The failure this guards against: someone adds a tenant-owned table, gives
 * it an `orgId`, and the extension never learns about it — a table with no
 * isolation and no error. The generated list is derived from the schema, so
 * the only way it can go stale is if nobody regenerates it. This is what
 * notices.
 */
describe("scoped-models.generated.ts", () => {
  it("matches the Prisma schema", () => {
    expect(() =>
      execFileSync("node", ["scripts/gen-tenant-models.mjs", "--check"], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("puts every model in exactly one bucket", () => {
    const all = [
      ...TENANT_SCOPED_MODELS,
      ...TENANT_OPTIONAL_MODELS,
      ...OPERATOR_OWNED_MODELS,
      ...UNSCOPED_MODELS,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("never filters the operator's own tables", () => {
    for (const model of OPERATOR_OWNED_MODELS) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(false);
      expect(TENANT_OPTIONAL_MODELS.has(model)).toBe(false);
    }
  });

  it("keeps the tenant list itself and the permission catalogue global", () => {
    expect(UNSCOPED_MODELS.has("organization")).toBe(true);
    expect(UNSCOPED_MODELS.has("permission")).toBe(true);
  });
});
