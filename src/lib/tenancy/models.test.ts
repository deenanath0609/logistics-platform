import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DERIVED_TENANT_TABLES,
  OPERATOR_OWNED_MODELS,
  SYSTEM_OWNED_MODELS,
  TENANT_MODELS,
} from "./models";

/**
 * The list in models.ts is the definition every isolation mechanism reads.
 * This re-derives the same facts from the schema so the two cannot drift.
 *
 * The failure this prevents is specific and quiet: someone adds a model
 * with an `orgId` column, the Prisma extension does not know about it, and
 * that table returns every tenant's rows to every tenant. Nothing errors.
 */

const SCHEMA_DIR = join(process.cwd(), "prisma", "schema");

type ParsedModel = { name: string; table: string; body: string };

function parseSchema(): ParsedModel[] {
  const models: ParsedModel[] = [];

  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".prisma"))) {
    const source = readFileSync(join(SCHEMA_DIR, file), "utf8");

    for (const match of source.matchAll(/^model (\w+) \{(.*?)^\}/gms)) {
      const [, name, body] = match;
      const mapped = body.match(/@@map\("(\w+)"\)/);
      models.push({ name, table: mapped?.[1] ?? name, body });
    }
  }

  return models;
}

const MODELS = parseSchema();

const hasField = (body: string, field: string) =>
  new RegExp(`^\\s+${field}\\s`, "m").test(body);

describe("the tenant model list", () => {
  it("finds the schema", () => {
    expect(MODELS.length).toBeGreaterThan(100);
  });

  it("covers every model carrying an orgId column", () => {
    const scoped = MODELS.filter((m) => hasField(m.body, "orgId")).map((m) => m.name);

    const accounted = new Set([
      ...Object.keys(TENANT_MODELS),
      ...Object.keys(OPERATOR_OWNED_MODELS),
      ...Object.keys(SYSTEM_OWNED_MODELS),
    ]);

    const unaccounted = scoped.filter((name) => !accounted.has(name));

    expect(
      unaccounted,
      `These models carry orgId but are in none of TENANT_MODELS, ` +
        `OPERATOR_OWNED_MODELS or SYSTEM_OWNED_MODELS. Until one of them ` +
        `lists it, the model is unprotected. Add it to TENANT_MODELS unless ` +
        `it belongs to the platform operator, or is infrastructure that has ` +
        `to read across tenants.`,
    ).toEqual([]);
  });

  it("lists nothing that has no orgId to scope on", () => {
    const byName = new Map(MODELS.map((m) => [m.name, m]));

    for (const name of Object.keys(TENANT_MODELS)) {
      const model = byName.get(name);
      expect(model, `${name} is listed but not in the schema`).toBeDefined();
      expect(
        hasField(model!.body, "orgId"),
        `${name} is listed as tenant-scoped but has no orgId column`,
      ).toBe(true);
    }
  });

  it("maps every model to its real table name", () => {
    const byName = new Map(MODELS.map((m) => [m.name, m]));

    for (const [name, table] of Object.entries(TENANT_MODELS)) {
      expect(byName.get(name)?.table, `${name} maps to the wrong table`).toBe(table);
    }
  });

  it("keeps Organization out — a tenant cannot be scoped to itself", () => {
    expect(Object.keys(TENANT_MODELS)).not.toContain("Organization");
  });

  it("resolves every derived table and its parent", () => {
    const byTable = new Map(MODELS.map((m) => [m.table, m]));
    const tenantTables = new Set(Object.values(TENANT_MODELS));

    for (const derived of DERIVED_TENANT_TABLES) {
      const model = byTable.get(derived.table);
      expect(model, `${derived.table} is not a table in the schema`).toBeDefined();
      expect(
        hasField(model!.body, derived.column),
        `${derived.table}.${derived.column} does not exist`,
      ).toBe(true);
      expect(
        tenantTables.has(derived.parentTable),
        `${derived.table} inherits from ${derived.parentTable}, which is not ` +
          `itself tenant-scoped — the chain has to end at a table with orgId`,
      ).toBe(true);
    }
  });
});
