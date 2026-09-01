import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
import {
  anyBranchScope,
  assignmentScope,
  branchScope,
  coversBranch,
} from "./scope";

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "user-1",
    orgId: "org-1",
    name: "Test User",
    mobile: "9000000000",
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: { id: "branch-1", code: "BR-1", name: "Branch One" },
    roles: [],
    permissions: new Set<string>(),
    scope: "BRANCH",
    branchIds: ["branch-1"],
    ...overrides,
  } as SessionUser;
}

describe("branch scoping", () => {
  it("returns nothing to filter on for a network user", () => {
    expect(branchScope(user({ scope: "NETWORK", branchIds: null }))).toEqual({});
  });

  it("matches no rows for a scoped user with no branch", () => {
    // `{}` here would hand them the whole network, which is the opposite of
    // what an unassigned account should see.
    expect(branchScope(user({ branchIds: [] }))).toEqual({
      branchId: { in: [] },
    });
  });

  it("names a single field, so it cannot collide with a search", () => {
    expect(branchScope(user(), "originBranchId")).toEqual({
      originBranchId: { in: ["branch-1"] },
    });
  });

  it("spans several columns with an OR", () => {
    expect(anyBranchScope(user(), ["originBranchId", "currentBranchId"])).toEqual({
      OR: [
        { originBranchId: { in: ["branch-1"] } },
        { currentBranchId: { in: ["branch-1"] } },
      ],
    });
  });

  it("gives an OWN-scope user only their own rows", () => {
    expect(assignmentScope(user({ scope: "OWN" }), "agentId")).toEqual({
      agentId: "user-1",
    });
  });

  it("covers a branch only when it is in reach", () => {
    expect(coversBranch(user(), "branch-1")).toBe(true);
    expect(coversBranch(user(), "branch-2")).toBe(false);
    expect(coversBranch(user({ branchIds: null }), "anything")).toBe(true);
  });
});

/**
 * ── The collision this test exists for ───────────────────────────────
 *
 * `anyBranchScope` returns `{ OR: [...] }`. A search filter returns
 * `{ OR: [...] }` too. Spread into the same object literal, the second key
 * wins and the first vanishes — so a list that scoped correctly with an
 * empty search box dropped its branch filter entirely the moment anybody
 * typed into it, and answered from the whole network.
 *
 * It happened twice, on `/shipments` and on `/hub/weigh`, and it survived
 * every existing check: the chips scoped correctly, the counts scoped
 * correctly, and the detail page refused the row. The only way to see it
 * was to search another branch's LR number and read the list.
 *
 * A comment on the helper is not enough, because the mistake is made at the
 * call site by someone adding a search to a list that already worked. So
 * this reads the source instead. It is crude on purpose: anything that
 * spreads an OR-producing scope helper into an object that also writes its
 * own `OR:` is refused, and the fix is always the same — put both into an
 * `AND: [...]` array, where two conditions can sit side by side.
 */
/*
  Only helpers that can actually return an `OR` belong here.
  `customerOwnedFilter` returns a bare `{ customerId }` and never collides,
  and listing it would make this test cry wolf — which is how a check earns
  the right to be ignored.
*/
const OR_PRODUCING = ["anyBranchScope", "customerShipmentFilter"];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "generated" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The object literal a spread sits in, read by counting braces forward from
 * the spread until the one that closes it. Good enough to see whether an
 * `OR:` key is written as a sibling; it does not need to parse TypeScript.
 */
function enclosingLiteral(source: string, spreadAt: number): string {
  let depth = 0;
  for (let i = spreadAt; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === "}") {
      if (depth === 0) return source.slice(spreadAt, i);
      depth -= 1;
    }
  }
  return source.slice(spreadAt);
}

describe("no list drops its branch filter when somebody searches", () => {
  it("never spreads an OR-producing scope beside another OR", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];

    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");

      for (const helper of OR_PRODUCING) {
        const needle = `...${helper}(`;
        let at = source.indexOf(needle);

        while (at !== -1) {
          // Siblings only. A nested `OR:` inside the spread's own argument
          // list, or inside a deeper object, is a different condition and
          // is not in competition for the key.
          const literal = enclosingLiteral(source, at + needle.length);
          const siblings = literal.replace(/\{[^{}]*\}/g, "");

          if (/\bOR:/.test(siblings)) {
            const line = source.slice(0, at).split("\n").length;
            offenders.push(`${relative(process.cwd(), file)}:${line} — ${helper}`);
          }

          at = source.indexOf(needle, at + needle.length);
        }
      }
    }

    expect(
      offenders,
      `These spread an OR-producing scope helper into an object that writes its own OR, ` +
        `so the scope is silently discarded. Put both inside AND: [...] instead.\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
