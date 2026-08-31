import { describe, expect, it } from "vitest";
import { visibleNavGroups } from "@/components/shell/nav";
import { MODULES } from "@/lib/modules/modules";
import {
  modulesForPlan,
  narrowToModules,
  type ModuleKey,
} from "@/lib/modules/registry";
import {
  PERMISSION_CODES,
  SYSTEM_ROLES,
  type RoleDef,
} from "@/lib/rbac/permissions";

/**
 * Help has to survive every filter in front of the sidebar.
 *
 * There are three of them and they compose: the plan decides which modules
 * a carrier has, the modules narrow the session's permissions, and the nav
 * then hides what is left over. Any one of the three can make a link
 * disappear, so "everybody can reach the help page" is not something a
 * reading of `nav.ts` can establish on its own — hence a test that walks
 * the roles the seed actually creates, on the barest plan there is.
 */

/** The session a role gets on a plan granting `features`. */
function sessionFor(role: RoleDef, features: string[]): {
  permissions: Set<string>;
  modules: Set<ModuleKey>;
} {
  const modules = modulesForPlan(features, MODULES);
  const held = role.permissions === "*" ? PERMISSION_CODES : role.permissions;
  return {
    permissions: new Set(narrowToModules(held, modules, MODULES)),
    modules,
  };
}

function hrefs(role: RoleDef, features: string[]): string[] {
  const { permissions, modules } = sessionFor(role, features);
  return visibleNavGroups(permissions, modules).flatMap((group) =>
    group.items.map((item) => item.href),
  );
}

/** No plan at all: the always-on modules, and nothing more. */
const BAREST: string[] = [];

describe("Help is reachable by everybody", () => {
  it("survives for every system role on a plan that bought nothing", () => {
    const without = SYSTEM_ROLES.filter(
      (role) => !hrefs(role, BAREST).includes("/help"),
    );
    expect(without.map((role) => role.code)).toEqual([]);
  });

  it("survives for the booking counter, which holds eleven codes", () => {
    const bookingExec = SYSTEM_ROLES.find((role) => role.code === "BOOKING_EXEC");
    expect(bookingExec).toBeDefined();
    expect(hrefs(bookingExec!, BAREST)).toContain("/help");
  });

  it("survives for a driver, who holds no permission the rest share", () => {
    // The narrowest session the seed can produce: DRIVER's four codes, of
    // which a plan with no modules leaves one. If Help were gated on any
    // permission at all, this is where it would vanish.
    const driver = SYSTEM_ROLES.find((role) => role.code === "DRIVER");
    expect(driver).toBeDefined();

    const { permissions } = sessionFor(driver!, BAREST);
    expect([...permissions]).toEqual(["vehicle.read"]);
    expect(hrefs(driver!, BAREST)).toContain("/help");
  });

  it("still hides what a role genuinely cannot open", () => {
    // The guard on the guard: if the filter had been loosened rather than
    // given a null case, everything above would pass for the wrong reason.
    const driver = SYSTEM_ROLES.find((role) => role.code === "DRIVER")!;
    const shown = hrefs(driver, BAREST);
    expect(shown).not.toContain("/admin/users");
    expect(shown).not.toContain("/finance/invoices");
    expect(shown).toContain("/fleet/vehicles");
  });
});

describe("the plan still gates everything else", () => {
  it("drops a section the carrier did not buy, and keeps Help", () => {
    const superAdmin = SYSTEM_ROLES.find((role) => role.code === "SUPER_ADMIN")!;

    const bare = hrefs(superAdmin, BAREST);
    expect(bare).not.toContain("/dispatch/manifests");
    expect(bare).toContain("/help");

    const withDispatch = hrefs(superAdmin, ["dispatch"]);
    expect(withDispatch).toContain("/dispatch/manifests");
    expect(withDispatch).toContain("/help");
  });
});
