import { describe, expect, it } from "vitest";
import {
  applyTenant,
  clientKey,
  mergeWhere,
  readFilter,
  stampCreate,
  WRITE_OPERATIONS,
} from "@/lib/tenant/scope-args";
import { TenantContextError } from "@/lib/tenant/context";

const A = "org_a";
const B = "org_b";

describe("mergeWhere", () => {
  it("adds the tenant predicate to an empty where", () => {
    expect(mergeWhere(undefined, { orgId: A })).toEqual({ AND: [{ orgId: A }] });
  });

  it("keeps the caller's own top-level keys, which findUnique needs", () => {
    expect(mergeWhere({ id: "x" }, { orgId: A })).toEqual({
      id: "x",
      AND: [{ orgId: A }],
    });
  });

  it("does not clobber a caller's existing AND", () => {
    const merged = mergeWhere({ AND: [{ status: "BOOKED" }] }, { orgId: A });
    expect(merged.AND).toEqual([{ status: "BOOKED" }, { orgId: A }]);
  });

  it("accepts a non-array AND, which Prisma also allows", () => {
    const merged = mergeWhere({ AND: { status: "BOOKED" } }, { orgId: A });
    expect(merged.AND).toEqual([{ status: "BOOKED" }, { orgId: A }]);
  });

  /**
   * The one that matters. Spreading the filter into the top level would
   * leave a caller's `OR` free to match rows the filter excluded — the
   * predicate has to bind tighter than anything the caller wrote.
   */
  it("binds tighter than a caller's top-level OR", () => {
    const merged = mergeWhere(
      { OR: [{ lrNumber: "CL1" }, { customerReference: "CL1" }] },
      { orgId: A },
    );
    expect(merged.OR).toEqual([{ lrNumber: "CL1" }, { customerReference: "CL1" }]);
    expect(merged.AND).toEqual([{ orgId: A }]);
  });

  it("cannot be overridden by a caller who writes their own orgId", () => {
    const merged = mergeWhere({ orgId: B }, { orgId: A });
    // Both survive, and Postgres cannot satisfy both — the row set is empty,
    // which is the safe reading of a contradictory request.
    expect(merged.orgId).toBe(B);
    expect(merged.AND).toEqual([{ orgId: A }]);
  });
});

describe("readFilter", () => {
  it("is a plain equality for an ordinary scoped model", () => {
    expect(readFilter(A, false)).toEqual({ orgId: A });
  });

  it("lets the platform-wide default row through for optional models", () => {
    expect(readFilter(A, true)).toEqual({ OR: [{ orgId: A }, { orgId: null }] });
  });
});

describe("stampCreate", () => {
  it("stamps the tenant onto a single row", () => {
    expect(stampCreate({ code: "PTL" }, A)).toEqual({ code: "PTL", orgId: A });
  });

  it("stamps every row of a createMany", () => {
    expect(stampCreate([{ code: "A" }, { code: "B" }], A)).toEqual([
      { code: "A", orgId: A },
      { code: "B", orgId: A },
    ]);
  });

  it("accepts an orgId that agrees with the tenant", () => {
    expect(stampCreate({ orgId: A, code: "PTL" }, A)).toEqual({ orgId: A, code: "PTL" });
  });

  it("refuses to write a row for another tenant", () => {
    expect(() => stampCreate({ orgId: B, code: "PTL" }, A)).toThrow(TenantContextError);
  });

  it("refuses inside a createMany too, not just the first row", () => {
    expect(() => stampCreate([{ code: "A" }, { orgId: B }], A)).toThrow(TenantContextError);
  });
});

describe("applyTenant", () => {
  const scoped = (operation: string, args?: Record<string, unknown>) =>
    applyTenant(operation, args, A, false) as Record<string, unknown>;

  it.each([
    "findUnique",
    "findUniqueOrThrow",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "delete",
    "deleteMany",
    "count",
    "aggregate",
    "groupBy",
  ])("filters %s", (operation) => {
    expect(scoped(operation, { where: { id: "x" } }).where).toEqual({
      id: "x",
      AND: [{ orgId: A }],
    });
  });

  it("filters a read that passed no arguments at all", () => {
    expect(scoped("findMany").where).toEqual({ AND: [{ orgId: A }] });
  });

  it("stamps a create", () => {
    expect(scoped("create", { data: { code: "PTL" } }).data).toEqual({
      code: "PTL",
      orgId: A,
    });
  });

  it("filters an update and refuses to move the row to another tenant", () => {
    expect(scoped("update", { where: { id: "x" }, data: { name: "n" } }).where).toEqual({
      id: "x",
      AND: [{ orgId: A }],
    });
    expect(() =>
      applyTenant("update", { where: { id: "x" }, data: { orgId: B } }, A, false),
    ).toThrow(TenantContextError);
  });

  it("filters an upsert's where and stamps its create", () => {
    const args = scoped("upsert", {
      where: { id: "x" },
      create: { code: "PTL" },
      update: { name: "n" },
    });
    expect(args.where).toEqual({ id: "x", AND: [{ orgId: A }] });
    expect(args.create).toEqual({ code: "PTL", orgId: A });
  });

  it("does not mutate the caller's arguments", () => {
    const original = { where: { id: "x" } };
    scoped("findMany", original);
    expect(original).toEqual({ where: { id: "x" } });
  });

  /**
   * A Prisma version that adds an operation this code has not seen must not
   * pass through unfiltered — an unrecognised operation is exactly the shape
   * of the leak the extension exists to prevent.
   */
  it("refuses an operation it does not recognise rather than passing it through", () => {
    expect(() => scoped("findSomethingNew", { where: {} })).toThrow(TenantContextError);
  });
});

describe("clientKey", () => {
  it("maps a model name to its client delegate", () => {
    expect(clientKey("Shipment")).toBe("shipment");
    expect(clientKey("ShipmentPackage")).toBe("shipmentPackage");
  });
});

describe("WRITE_OPERATIONS", () => {
  it("covers every mutating operation, so a read-only tenant cannot be written to", () => {
    for (const operation of [
      "create",
      "createMany",
      "createManyAndReturn",
      "update",
      "updateMany",
      "updateManyAndReturn",
      "upsert",
      "delete",
      "deleteMany",
    ]) {
      expect(WRITE_OPERATIONS.has(operation)).toBe(true);
    }
  });

  it("does not treat a read as a write", () => {
    for (const operation of ["findMany", "findUnique", "count", "aggregate", "groupBy"]) {
      expect(WRITE_OPERATIONS.has(operation)).toBe(false);
    }
  });
});
