import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isCustomerSubject } from "@/lib/auth/subject";
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
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  // A portal customer holds the same cookie shape as staff. The namespaced
  // subject could not match an `app_user` row anyway, but refusing it here
  // makes the boundary explicit rather than incidental.
  if (isCustomerSubject(userId)) return null;

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
});

/** Server-component guard: sends anonymous visitors to the login page. */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(
      returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login",
    );
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
