import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_CODES,
  SYSTEM_ROLES,
  type RoleDef,
} from "./permissions";

/**
 * The permission catalogue and the role matrix.
 *
 * This file is the single source of truth for what anyone in a carrier can
 * do, and until now nothing asserted anything about it. `nav.test.ts`,
 * `modules.test.ts` and `state-machine.test.ts` each import it to check
 * *their own* invariant against it; none of them check the matrix itself.
 *
 * Two things make that expensive. The first is that `prisma/seed/rbac.ts`
 * resolves a role's codes against the `permission` table and, on a code it
 * cannot find, prints
 *
 *     ! unknown permission "shipment.canel" in role BRANCH_MANAGER
 *
 * to the seed's stdout and carries on. A typo therefore ships as a role
 * quietly missing a grant, discovered by a branch manager who cannot cancel
 * a booking. The second is that the matrix is a list of string literals
 * three hundred lines long: a code pasted onto the wrong role is invisible
 * in review and invisible at run time, because a permission somebody holds
 * and should not is never the thing that throws.
 *
 * These tests are written as walks over the catalogue rather than as a
 * frozen snapshot of it. A snapshot of 400 grants is updated by pressing
 * `-u`, which is not a review. A walk states the property — a field device
 * holds nothing sensitive; every code named exists — and fails on the next
 * grant that breaks it, whatever its name.
 */

const codes = new Set<string>(PERMISSION_CODES);
const sensitive = new Set(PERMISSIONS.filter((p) => p.sensitive).map((p) => p.code));

/** A role's grants, with `"*"` expanded and duplicates collapsed. */
function grantsOf(role: RoleDef): Set<string> {
  return new Set(role.permissions === "*" ? PERMISSION_CODES : role.permissions);
}

const namedRoles = SYSTEM_ROLES.filter((role) => role.permissions !== "*");

// ── the catalogue ───────────────────────────────────────────────────────

describe("the permission catalogue", () => {
  it("has no duplicate code", () => {
    const seen = new Map<string, number>();
    for (const code of PERMISSION_CODES) seen.set(code, (seen.get(code) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([code]) => code)).toEqual([]);
  });

  it("builds every code as resource.action", () => {
    for (const permission of PERMISSIONS) {
      expect(permission.code).toBe(`${permission.resource}.${permission.action}`);
    }
  });

  it("gives every permission a module, a description and a lowercase code", () => {
    for (const permission of PERMISSIONS) {
      expect(permission.module, permission.code).toBeTruthy();
      expect(permission.description.length, permission.code).toBeGreaterThan(3);
      expect(permission.code, permission.code).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});

// ── the role matrix ─────────────────────────────────────────────────────

describe("every role grants only codes that exist", () => {
  /**
   * The seed's response to an unknown code is a `console.warn` in the
   * middle of a hundred lines of seed output. This is the assertion that
   * was standing in for.
   */
  it.each(namedRoles.map((role) => [role.code, role] as const))(
    "%s names no permission that is not in the catalogue",
    (_name, role) => {
      const unknown = [...grantsOf(role)].filter((code) => !codes.has(code));
      expect(unknown).toEqual([]);
    },
  );

  it("has a unique code and a real scope for each role", () => {
    const seen = new Set<string>();
    for (const role of SYSTEM_ROLES) {
      expect(seen.has(role.code), role.code).toBe(false);
      seen.add(role.code);
      expect(["OWN", "BRANCH", "BRANCH_SET", "NETWORK"], role.code).toContain(
        role.scope,
      );
      expect(role.name.length, role.code).toBeGreaterThan(2);
    }
  });

  it("grants SUPER_ADMIN everything, by wildcard rather than by a list", () => {
    const superAdmin = SYSTEM_ROLES.find((role) => role.code === "SUPER_ADMIN");
    // A list would drift from the catalogue on the next permission added,
    // and the drift would be a Super Admin who cannot do a new thing.
    expect(superAdmin?.permissions).toBe("*");
    expect(superAdmin?.scope).toBe("NETWORK");
  });
});

describe("what a field device may hold", () => {
  /**
   * OWN-scope roles sign in on a phone that lives in a jacket pocket, is
   * shared between shifts, and is the most likely credential in the company
   * to be lost. Everything sensitive is therefore off it — not by naming
   * the codes, which would go stale, but by walking the `sensitive` flag.
   */
  it.each(SYSTEM_ROLES.filter((role) => role.scope === "OWN").map((r) => [r.code, r] as const))(
    "%s holds nothing marked sensitive",
    (_name, role) => {
      expect([...grantsOf(role)].filter((code) => sensitive.has(code))).toEqual([]);
    },
  );

  it.each(SYSTEM_ROLES.filter((role) => role.scope === "OWN").map((r) => [r.code, r] as const))(
    "%s holds nothing from the admin, report or party modules",
    (_name, role) => {
      const moduleOf = new Map(PERMISSIONS.map((p) => [p.code, p.module]));
      const offLimits = [...grantsOf(role)].filter((code) =>
        ["admin", "report", "party"].includes(moduleOf.get(code) ?? ""),
      );
      expect(offLimits).toEqual([]);
    },
  );

  it.each(SYSTEM_ROLES.filter((role) => role.scope === "OWN").map((r) => [r.code, r] as const))(
    "%s touches finance only to log an expense in the field",
    (_name, role) => {
      // DRIVER holds `expense.record` so a fuel bill can be logged at the
      // pump, and that one code is the whole of a field role's finance
      // surface. Everything else in the module — approving, settling,
      // invoicing, reconciling COD — is somebody else's job at a desk.
      const moduleOf = new Map(PERMISSIONS.map((p) => [p.code, p.module]));
      const finance = [...grantsOf(role)].filter(
        (code) => moduleOf.get(code) === "finance",
      );
      expect(finance.filter((code) => code !== "expense.record")).toEqual([]);
    },
  );

  /**
   * Named because it is the regression the catalogue's own comment
   * describes: `settlement.prepare` was once gated on `expense.record`,
   * which DRIVER holds so a driver can log fuel, so a driver could draft
   * their own payout at a figure they typed in.
   */
  it("keeps DRIVER away from both halves of a settlement", () => {
    const driver = grantsOf(SYSTEM_ROLES.find((r) => r.code === "DRIVER")!);
    expect(driver.has("settlement.prepare")).toBe(false);
    expect(driver.has("settlement.approve")).toBe(false);
    expect(driver.has("expense.approve")).toBe(false);
    // …while keeping the one it needs to do its job.
    expect(driver.has("expense.record")).toBe(true);
  });

  it("keeps a delivery agent able to collect COD and unable to reconcile it", () => {
    const agent = grantsOf(SYSTEM_ROLES.find((r) => r.code === "DELIVERY_AGENT")!);
    expect(agent.has("cod.collect")).toBe(true);
    expect(agent.has("cod.deposit")).toBe(false);
    expect(agent.has("cod.reconcile")).toBe(false);
  });
});

describe("the read-only roles are read-only", () => {
  /**
   * MANAGEMENT and CUSTOMER_SUPPORT are both documented as unable to move
   * anything, and both are built by spreading `allReads`. The risk is not
   * the spread — it is the individual codes bolted on afterwards.
   */
  it("gives MANAGEMENT nothing but reads, reports and tracking", () => {
    const allowed = new Set([
      ...PERMISSIONS.filter((p) => p.action === "read").map((p) => p.code),
      "report.operations",
      "report.financial",
      "report.management",
      "tracking.read",
    ]);
    const extra = [...grantsOf(SYSTEM_ROLES.find((r) => r.code === "MANAGEMENT")!)].filter(
      (code) => !allowed.has(code),
    );
    expect(extra).toEqual([]);
  });

  it("gives CUSTOMER_SUPPORT no money, no masters and no fleet writes", () => {
    const support = grantsOf(SYSTEM_ROLES.find((r) => r.code === "CUSTOMER_SUPPORT")!);
    for (const code of [
      "invoice.create",
      "invoice.approve",
      "payment.record",
      "customer.manage_credit",
      "ratecard.manage",
      "master.manage",
      "vehicle.update",
      "shipment.cancel",
      "cod.reconcile",
    ]) {
      expect(support.has(code), code).toBe(false);
    }
    // The one write it is documented as having: correcting an address.
    expect(support.has("shipment.update")).toBe(true);
  });

  it("hands no sensitive read out through the `allReads` shorthand", () => {
    // `allReads` filters on `!sensitive`. If that filter were dropped, the
    // read-only roles would silently gain `receipt.close`-style codes that
    // happen to be spelled `read`.
    const management = grantsOf(SYSTEM_ROLES.find((r) => r.code === "MANAGEMENT")!);
    for (const permission of PERMISSIONS) {
      if (permission.action === "read" && permission.sensitive) {
        expect(management.has(permission.code), permission.code).toBe(false);
      }
    }
  });
});

describe("separation of duties", () => {
  /**
   * ACCOUNTS deliberately holds both halves — a two-person accounts team
   * needs both people able to do both jobs — so the control cannot be a
   * permission and is not one. It is a single line in
   * `approveSettlement` comparing `createdById` to the actor. This test
   * exists to record that the permission matrix is *not* the control, so
   * that nobody removes the identity check believing the matrix covers it.
   * `settlement-approve.test.ts` is where the actual control is asserted.
   */
  it("lets ACCOUNTS both prepare and approve, which is why the identity check exists", () => {
    const accounts = grantsOf(SYSTEM_ROLES.find((r) => r.code === "ACCOUNTS")!);
    expect(accounts.has("settlement.prepare")).toBe(true);
    expect(accounts.has("settlement.approve")).toBe(true);
  });

  it("keeps invoice approval away from every branch-scoped role", () => {
    for (const role of SYSTEM_ROLES) {
      if (role.scope === "NETWORK" || role.permissions === "*") continue;
      const grants = grantsOf(role);
      for (const code of ["invoice.approve", "invoice.cancel", "settlement.approve"]) {
        expect(grants.has(code), `${role.code} holds ${code}`).toBe(false);
      }
    }
  });

  it("gives TRANSPORT_DESK the preparer half only", () => {
    const desk = grantsOf(SYSTEM_ROLES.find((r) => r.code === "TRANSPORT_DESK")!);
    expect(desk.has("settlement.prepare")).toBe(true);
    expect(desk.has("settlement.approve")).toBe(false);
  });
});

// ── the catalogue against the code that reads it ────────────────────────

const SRC = path.resolve(import.meta.dirname, "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Where a code is *asked for*: the argument to a guard, a `permissions.has`,
 * or a declared `permission:` on a transition rule, nav entry or help topic.
 *
 * `lib/rbac` and `lib/modules` are excluded on purpose. The catalogue names
 * every code by definition, and the module registry maps modules to the
 * codes they own — neither is a place a permission is *checked*, and
 * counting them would make this test unable to fail.
 */
const GUARD_RE =
  /\b(?:can|canAny|authorize|requirePermission|requireAny|hasPermission)\s*\(\s*[\s\S]{0,80}?["']([a-z_]+\.[a-z_]+)["']|permissions\s*\.\s*has\s*\(\s*["']([a-z_]+\.[a-z_]+)["']|\bpermission\s*:\s*["']([a-z_]+\.[a-z_]+)["']/g;

/**
 * Comments are stripped first. Half this codebase's guards are described
 * in prose above the function that performs them — `session.ts` explains
 * itself with `authorize("invoice.write")`, a code that has never existed —
 * and a scanner that reads those finds guards nobody wrote.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const enforcedIn = new Map<string, Set<string>>();
for (const file of sourceFiles(SRC)) {
  const relative = path.relative(SRC, file).replace(/\\/g, "/");
  if (relative.startsWith("lib/rbac/") || relative.startsWith("lib/modules/")) continue;
  for (const match of withoutComments(readFileSync(file, "utf8")).matchAll(GUARD_RE)) {
    const code = match[1] ?? match[2] ?? match[3];
    if (!code) continue;
    if (!enforcedIn.has(code)) enforcedIn.set(code, new Set());
    enforcedIn.get(code)!.add(relative);
  }
}

/**
 * Permissions that exist in the catalogue, are granted by roles and shown
 * in the role editor, and are asked for by no code path at all.
 *
 * `SHORT_RECEIVED` and `EXCESS_RECEIVED` were exactly this in the exception
 * catalogue: enum entries with escalation ladders behind them, raised by
 * nothing, so the loss-and-damage figure was structurally always zero. A
 * permission in this state is worse than absent — the role editor offers it,
 * an administrator ticks it believing they have restricted something, and
 * the capability it names is either unreachable or ungated.
 *
 * Every entry here is a defect waiting to be routed, not a licence. The
 * list is empty apart from the one below, and a new arrival fails this test.
 */
const KNOWN_UNENFORCED: ReadonlyArray<{ code: string; why: string }> = [
  {
    code: "pod.upload",
    why:
      "Catalogued as sensitive — 'Upload or replace POD assets' — and asked " +
      "for by nothing. POD assets are written inside `deliverShipment`, gated " +
      "on `delivery.execute`, and there is no replace path at all. Reported " +
      "as a product finding in the phase 10 audit; not fixed here because " +
      "this pass does not touch product code.",
  },
];

describe("every permission is actually asked for somewhere", () => {
  it("has no permission the product never checks, beyond the known gaps", () => {
    const known = new Set(KNOWN_UNENFORCED.map((entry) => entry.code));
    const unenforced = PERMISSION_CODES.filter(
      (code) => !enforcedIn.has(code) && !known.has(code),
    );

    expect(
      unenforced,
      "these permissions are granted, shown in the role editor, and gate nothing",
    ).toEqual([]);
  });

  it("keeps the known-gap list honest by failing when a gap is closed", () => {
    // A fixed gap must be struck from the list, or the list becomes the
    // place stale exemptions accumulate.
    for (const entry of KNOWN_UNENFORCED) {
      expect(
        enforcedIn.has(entry.code),
        `${entry.code} is now enforced — remove it from KNOWN_UNENFORCED`,
      ).toBe(false);
    }
  });

  it("guards on no code that is missing from the catalogue", () => {
    // The inverse failure: `authorize("shipment.canel")` throws for
    // everyone, including Super Admin, because nobody can hold a code that
    // does not exist.
    const invented = [...enforcedIn.keys()].filter((code) => !codes.has(code));
    expect(invented).toEqual([]);
  });
});

describe("every permission can be reached by somebody other than Super Admin", () => {
  /**
   * A capability only SUPER_ADMIN can use is a capability that gets used by
   * sharing the Super Admin login, which is how a network ends up with one
   * password. This is reported rather than enforced — some of these are
   * deliberate — so the assertion is on the list not *growing*.
   */
  const granted = new Set(namedRoles.flatMap((role) => [...grantsOf(role)]));
  const superAdminOnly = PERMISSION_CODES.filter((code) => !granted.has(code));

  it("names the same set of Super-Admin-only permissions as when this was written", () => {
    expect([...superAdminOnly].sort()).toEqual(
      [
        "apikey.manage",
        "branch.manage",
        "customer.update",
        "geofence.manage",
        "master.manage",
        "pod.upload",
        "role.manage",
        "settings.manage",
        "shipment.correct_status",
        "shipment.edit_weight_post_invoice",
        "shipment.override_rate",
        "sla.manage",
        "user.manage",
        "vendor.create",
      ].sort(),
    );
  });

  it("still lets a booking clerk create the customer they cannot then edit", () => {
    // `customer.update` sits in the list above while `customer.create` does
    // not, so a counter clerk can open an account and cannot correct a typo
    // in it. Recorded here because it reads as an oversight and is the kind
    // of thing that is decided once and then forgotten.
    const clerk = grantsOf(SYSTEM_ROLES.find((r) => r.code === "BOOKING_EXEC")!);
    expect(clerk.has("customer.create")).toBe(true);
    expect(clerk.has("customer.update")).toBe(false);
  });
});
