import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isCustomerSubject, isPlatformSubject } from "@/lib/auth/subject";
import { IMPERSONATION_USER_ID_PREFIX } from "@/lib/platform/impersonation-credential";
import {
  currentImpersonation,
  type LiveGrant,
} from "@/lib/platform/impersonation-session";
import { resolveTenant } from "@/lib/tenant/resolve";
import { MODULES } from "@/lib/modules/modules";
import { narrowToModules } from "@/lib/modules/registry";
import { modulesForOrg } from "@/lib/modules/tenant-modules";
import type { DataScope } from "@/generated/prisma/client";

export type SessionUser = {
  id: string;
  orgId: string;
  name: string;
  mobile: string;
  email: string | null;
  isFieldUser: boolean;
  mustChangePassword: boolean;
  primaryBranch: { id: string; code: string; name: string } | null;
  roles: Array<{ code: string; name: string; scope: DataScope }>;
  /** Union of every permission granted by every role held. */
  permissions: ReadonlySet<string>;
  /** The widest scope across the user's roles. */
  scope: DataScope;
  /**
   * Branches this user may see. `null` means the whole network — callers
   * must treat null as "no filter", not as "no branches".
   */
  branchIds: string[] | null;
};

const SCOPE_RANK: Record<DataScope, number> = {
  OWN: 0,
  BRANCH: 1,
  BRANCH_SET: 2,
  NETWORK: 3,
};

/**
 * Loads the signed-in user with roles and permissions resolved fresh from
 * the database.
 *
 * Deliberately not cached in the JWT: revoking a permission must take
 * effect on the next request, which a token-cached copy cannot do. React's
 * `cache` keeps it to one query per request.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const user = await resolveSessionUser();
  if (!user) return null;
  return withoutUnboughtModules(user);
});

/**
 * ── The load-bearing lines in this file ──────────────────────────────────
 *
 * This looks like a small transform and it is the whole of module
 * enforcement for server actions, route handlers and page guards alike.
 *
 * Every `authorize("invoice.write")` and `requirePermission("cod.deposit")`
 * already written — and every one written from now on — becomes module-aware
 * here, without a single call site importing a module, naming a plan, or
 * knowing that plans exist. A permission owned by a module the carrier did
 * not buy is simply not in the set those checks read, so they refuse it the
 * same way they refuse a permission the role never had.
 *
 * It has to happen at *this* point rather than inside `loadTenantUser`,
 * because a platform operator's support session is assembled on a different
 * path and must be narrowed too: what a carrier has not bought does not
 * become visible because the vendor is the one looking.
 *
 * Permissions and modules stay independent, which is the point of doing it
 * by subtraction. Roles are untouched — the branch manager still *holds*
 * `invoice.read` in the database, and adding billing to the plan restores it
 * on the next request without anybody editing a role. See
 * `registry.ts::narrowToModules`.
 * ────────────────────────────────────────────────────────────────────────
 */
async function withoutUnboughtModules(user: SessionUser): Promise<SessionUser> {
  const granted = await modulesForOrg(user.orgId);
  return {
    ...user,
    permissions: narrowToModules(user.permissions, granted, MODULES),
  };
}

async function resolveSessionUser(): Promise<SessionUser | null> {
  // A support session answers first, and it answers instead of the tenant
  // cookie rather than alongside it. `resolveTenant()` has already checked
  // the grant against the host's organisation, so reading `source` here
  // means the two layers cannot disagree about whether this is an operator.
  const tenant = await resolveTenant();
  if (tenant?.source === "impersonation") {
    const grant = await currentImpersonation();
    if (!grant) return null;
    return impersonatedUser(grant);
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  // A portal customer holds the same cookie shape as staff. The namespaced
  // subject could not match an `app_user` row anyway, but refusing it here
  // makes the boundary explicit rather than incidental.
  if (isCustomerSubject(userId)) return null;

  // The same refusal for a platform operator. The operator console runs on
  // its own hostname with its own cookie, so a `platform:` subject should
  // never reach this function at all — which is exactly why it is refused
  // here rather than trusted to be impossible. A support login must never
  // satisfy a tenant permission check, and the cheapest way to guarantee
  // that is for the tenant session to resolve to nobody.
  if (isPlatformSubject(userId)) return null;

  return loadTenantUser(userId);
}

/**
 * A staff member, with roles and permissions resolved from the database.
 *
 * Extracted so that an impersonating operator who has adopted a named
 * tenant user goes through the **same** query and the same mapping as that
 * person's own login. There is no impersonation-flavoured variant of a
 * permission set: the operator either gets exactly what that person has,
 * or gets nothing.
 */
async function loadTenantUser(userId: string): Promise<SessionUser | null> {
  // Tenant-scoped, despite how it reads. `id` is unique across the product,
  // so this looks like a lookup with nothing guarding it — but the extension
  // adds the `orgId` of the host the request arrived on, which means a
  // session cookie carried to another tenant's subdomain resolves to no user
  // and the visitor is simply signed out there. The host stays the boundary
  // even for a cookie that has already authenticated somewhere else, so no
  // manual session-against-host comparison is needed here.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      orgId: true,
      name: true,
      mobile: true,
      email: true,
      status: true,
      isFieldUser: true,
      mustChangePassword: true,
      deletedAt: true,
      primaryBranch: { select: { id: true, code: true, name: true } },
      branchScopes: { select: { branchId: true } },
      roles: {
        select: {
          role: {
            select: {
              code: true,
              name: true,
              scope: true,
              isActive: true,
              permissions: {
                select: { permission: { select: { code: true } } },
              },
            },
          },
        },
      },
    },
  });

  // A user deactivated or deleted mid-session loses access immediately.
  if (!user || user.deletedAt || user.status !== "ACTIVE") return null;

  const activeRoles = user.roles
    .map((r) => r.role)
    .filter((role) => role.isActive);

  const permissions = new Set<string>();
  for (const role of activeRoles) {
    for (const rp of role.permissions) permissions.add(rp.permission.code);
  }

  const scope = activeRoles.reduce<DataScope>(
    (widest, role) =>
      SCOPE_RANK[role.scope] > SCOPE_RANK[widest] ? role.scope : widest,
    "OWN",
  );

  let branchIds: string[] | null;
  if (scope === "NETWORK") {
    branchIds = null;
  } else if (scope === "BRANCH_SET") {
    branchIds = [
      ...new Set(
        [
          user.primaryBranch?.id,
          ...user.branchScopes.map((s) => s.branchId),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
  } else {
    branchIds = user.primaryBranch ? [user.primaryBranch.id] : [];
  }

  return {
    id: user.id,
    orgId: user.orgId,
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    isFieldUser: user.isFieldUser,
    mustChangePassword: user.mustChangePassword,
    primaryBranch: user.primaryBranch,
    roles: activeRoles.map((r) => ({
      code: r.code,
      name: r.name,
      scope: r.scope,
    })),
    permissions,
    scope,
    branchIds,
  };
}

/**
 * ── Who a platform operator *is*, inside a tenant app ───────────────────
 *
 * Every ops page calls `requireUser()` and gets a `SessionUser`. An
 * operator is not a `User` row and must never become one, so the question
 * is what that call returns during a support session. Three answers were
 * available and only one of them is safe.
 *
 * **Rejected: widen `SessionUser`.** An `isOperator` flag would be the
 * shortest change and the worst one. It puts the fact in a field that
 * every existing call site already ignores, so the default behaviour of
 * all the code written before today would be to treat an operator as
 * staff. The rule this file has followed since the customer portal is that
 * the boundary must be structural rather than a flag somebody remembers to
 * check — hence `SessionUser` gains nothing here. What an ordinary caller
 * *can* see is `TenantContext.source === "impersonation"` and
 * `readOnly`, which the Prisma extension already enforces without asking
 * anyone's permission.
 *
 * **Rejected: give the operator their own permission set.** Anything
 * assembled by us — "all reads", "everything the plan allows" — is a
 * permission set no employee of that carrier holds, invented by the
 * vendor, inside the customer's data. That is precisely the thing a
 * time-boxed written-reason grant was designed not to be.
 *
 * **Chosen: the operator adopts a real identity, or none at all.**
 *
 * - With `asUserId`, `getCurrentUser()` returns *that person's* session,
 *   loaded through `loadTenantUser` — the same query, roles, branch scope
 *   and id their own login produces. The operator sees exactly what the
 *   person they are helping sees, no more, and cannot acquire a permission
 *   nobody at the carrier has because the set is that person's set. It is
 *   also what makes a write attributable: `AuditLog.userId` is a foreign
 *   key into the carrier's staff table, so the adopted user is the only
 *   actor an impersonated write *can* name. The operator half of that
 *   attribution is the `impersonation.enter` row in `PlatformAuditLog`,
 *   which pins the window those rows fall in.
 *
 * - Without `asUserId` the grant is tenant-wide, and there is nobody to
 *   adopt. The session is built here instead, and it is built to be unable
 *   to do anything that would need an identity: the tenant context is
 *   read-only (`grantMayWrite` refuses a grant with no adopted user), and
 *   the permission set is narrowed to `*.read` codes the carrier's **own
 *   active roles** already grant — every permission in it is one the
 *   carrier hands out to its own staff, and nothing sensitive, nothing
 *   that writes, and no export survives the filter. Its `id` is
 *   deliberately not a `User.id`, so "rows this user owns" resolves to
 *   none and no foreign key can ever be written with it.
 *
 * In both cases the session is visibly an operator's: the banner rendered
 * by the ops layout reads the tenant context, not this object.
 * ────────────────────────────────────────────────────────────────────────
 */
async function impersonatedUser(grant: LiveGrant): Promise<SessionUser | null> {
  if (grant.asUserId) {
    const adopted = await loadTenantUser(grant.asUserId);
    // The forced password change is the adopted person's to do, not the
    // operator's. Left set, `requireUser` would pin the whole support
    // session on `/password` — a screen whose write the read-only
    // impersonation context refuses anyway, so the operator would be stuck
    // on a form that cannot succeed and cannot be left.
    return adopted ? { ...adopted, mustChangePassword: false } : null;
  }
  return tenantWideSupportUser(grant);
}

/** The only permission action a tenant-wide support session may hold. */
const SUPPORT_READ_ACTION = "read";

async function tenantWideSupportUser(grant: LiveGrant): Promise<SessionUser> {
  // Scoped by the extension to the host's organisation, which
  // `resolveTenant()` has already matched against the grant — so this
  // reads one carrier's roles and cannot read another's.
  const roles = await prisma.role.findMany({
    where: { isActive: true },
    select: {
      scope: true,
      permissions: {
        select: {
          permission: {
            select: { code: true, action: true, isSensitive: true },
          },
        },
      },
    },
  });

  const permissions = new Set<string>();
  for (const role of roles) {
    for (const rp of role.permissions) {
      const permission = rp.permission;
      // Sensitive codes are excluded even when they read: `report.export`
      // is a read that writes an `EXPORT` audit row, and this session has
      // no `User.id` to put in it.
      if (permission.isSensitive) continue;
      if (permission.action !== SUPPORT_READ_ACTION) continue;
      permissions.add(permission.code);
    }
  }

  // The widest scope the carrier itself hands out, and never wider. A
  // tenant whose roles are all branch-scoped gives a branch-scoped support
  // session, which will see nothing — an empty screen is the right failure
  // here, and a visible one.
  const scope = roles.reduce<DataScope>(
    (widest, role) =>
      SCOPE_RANK[role.scope] > SCOPE_RANK[widest] ? role.scope : widest,
    "OWN",
  );

  return {
    id: `${IMPERSONATION_USER_ID_PREFIX}${grant.id}`,
    orgId: grant.orgId,
    // Named for what it is, so even the header's user menu says so.
    name: `${grant.operator.name} · platform support`,
    mobile: "—",
    email: grant.operator.email,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: null,
    roles: [
      { code: "PLATFORM_SUPPORT", name: "Platform support (read-only)", scope },
    ],
    permissions,
    scope,
    branchIds: scope === "NETWORK" ? null : [],
  };
}

/** Where a staff member is sent while their password is still somebody else's. */
export const STAFF_PASSWORD_PATH = "/password";

/**
 * Server-component guard: sends anonymous visitors to the login page, and
 * anybody still carrying a handed-out password to the screen that replaces
 * it.
 *
 * ── Why the forced change lives here ─────────────────────────────────────
 *
 * `createUser` sets `mustChangePassword` for every office account it gives
 * a password to, `resetPassword` sets it again and tells the administrator
 * "They must change it at next sign-in", and nothing on the tenant side
 * read the flag. There was no screen either: `/platform/password` belongs
 * to the operator console, on another host and another session. So the
 * temporary password an administrator typed into a dialog and read down a
 * telephone stayed that account's real password indefinitely, and the
 * message on the dialog was simply false.
 *
 * Put on `requireUser` rather than on the ops layout because both shells go
 * through it — a delivery agent whose password was reset is bounced the
 * same way — and because `requirePermission` calls it, so a page that
 * guards on a permission gets the check without restating it. Server
 * actions and route handlers go through `authorize`, which does not
 * redirect: an action must refuse, not navigate. They are unreachable in
 * practice because the screen that would post to them redirects first.
 * ────────────────────────────────────────────────────────────────────────
 */
export async function requireUser(options?: {
  returnTo?: string;
  /** Set only by the password screen itself, or it would redirect to itself. */
  allowPasswordChange?: boolean;
}): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(
      options?.returnTo
        ? `/login?next=${encodeURIComponent(options.returnTo)}`
        : "/login",
    );
  }
  if (user.mustChangePassword && !options?.allowPasswordChange) {
    redirect(STAFF_PASSWORD_PATH);
  }
  return user;
}

export function can(user: SessionUser, permission: string): boolean {
  return user.permissions.has(permission);
}

export function canAny(user: SessionUser, permissions: string[]): boolean {
  return permissions.some((p) => user.permissions.has(p));
}

/** Guard for pages. Renders the 403 page rather than a blank screen. */
export async function requirePermission(
  permission: string,
): Promise<SessionUser> {
  const user = await requireUser();
  if (!can(user, permission)) redirect("/forbidden");
  return user;
}

export class PermissionError extends Error {
  constructor(public permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "PermissionError";
  }
}

/** Guard for server actions and route handlers, which must throw, not redirect. */
export async function authorize(permission: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new PermissionError(permission);
  if (!can(user, permission)) throw new PermissionError(permission);
  return user;
}
