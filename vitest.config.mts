import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    // `.tsx` is included as well as `.ts`.
    //
    // The pattern was `src/**` + `/*.test.ts`, which is every test file in
    // the repo today — and would have silently ignored the first one
    // anybody wrote next to a component. A test that is never collected is
    // worse than a missing test: the suite still reports that 84 files
    // passed.
    include: [
      "src/**/*.test.{ts,tsx}",
      "tests/**/*.test.{ts,tsx}",
      "workers/**/*.test.{ts,tsx}",
    ],
    coverage: {
      // `npm run coverage` answers a weaker question than
      // `npm run coverage:map`, and the thresholds here are deliberately
      // absent so nobody mistakes a number for an assurance.
      //
      // Every defect this product shipped this quarter — the search box
      // that dropped the branch filter, `verifyCodDeposit` overwriting the
      // shortfall column, route deviation switching itself off ten minutes
      // into every trip — was on a line that executed. Line coverage would
      // have been green on all of them.
      //
      // Read it as "which files has nothing ever loaded", which it answers
      // well, and use the coverage map for "which rule could be deleted
      // without turning the suite red", which it cannot answer at all.
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/lib/**", "src/server/**", "workers/**"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        // Generated, or a re-export with no behaviour of its own.
        "src/lib/**/index.ts",
        "src/lib/prisma.ts",
        "src/lib/prisma-base.ts",
      ],
    },
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
});
