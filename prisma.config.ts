import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed/index.ts",
  },
  datasource: {
    // Migrations run as the database owner, deliberately.
    //
    // Once row-level security is switched on the application connects as a
    // restricted role that owns nothing — which is the whole point, since
    // RLS does not apply to a table's owner. That role cannot run DDL, so
    // Prisma Migrate keeps the owner's connection here. Where RLS is off,
    // the two are the same string and this changes nothing.
    url: process.env["MIGRATE_DATABASE_URL"] || process.env["DATABASE_URL"],

    // A scratch database Prisma may create, replay the migrations into, and
    // drop. Only `migrate dev` and `migrate diff --from-migrations` need it,
    // and the second is what proves the migrations and the schema still
    // agree — the check that would have caught `tenant_plan` existing in the
    // schema and in nobody's migration. Unset in production, where nothing
    // should be creating databases.
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
