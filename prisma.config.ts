import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed/index.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
