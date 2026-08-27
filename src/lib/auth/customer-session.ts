import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readCustomerSubject } from "@/lib/auth/subject";
import type { CustomerUserRole } from "@/generated/prisma/client";

/**
 * The signed-in portal customer.
 *
 * Note what is *not* here: no `permissions` set, no `roles`, no `scope`.
 * That is the point. `can()`, `canAny()`, `requirePermission()` and
 * `authorize()` all take a `SessionUser`, so a `CustomerSession` cannot be
 * passed to any of them without a compile error — the boundary is enforced
 * by the type system, not by a runtime flag someone can forget to check.
 *
 * See docs/BRD.html §A.14: "Customer users are strictly scoped to their own
 * account's data."
 */
export type CustomerSession = {
  /** `CustomerUser.id`, unwrapped from the namespaced subject. */
  id: string;
  name: string;
  email: string;
  role: CustomerUserRole;
  mustChangePassword: boolean;

  /** The account every query this session makes must be pinned to. */
  customerId: string;
  customerCode: string;
  customerName: string;
  /** Org of the owning account — needed to stamp rows they create. */
  orgId: string;

  /**
   * Branches of their own account this login may see. Empty means the
   * whole account — a group head office rather than one plant manager.
   */
  visibleBranchIds: string[];
};

/**
 * Loads the portal customer fresh from the database on every request.
 *
 * Same reasoning as `getCurrentUser`: a login deactivated or an account
 * blocked mid-session must lose access on the very next request, which a
 * token-cached copy cannot do.
 */
export const getCurrentCustomerUser = cache(
  async (): Promise<CustomerSession | null> => {
    const session = await auth();
    const customerUserId = readCustomerSubject(session?.user?.id);
    if (!customerUserId) return null;

    const user = await prisma.customerUser.findUnique({
      where: { id: customerUserId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        deletedAt: true,
        mustChangePassword: true,
        visibleBranchIds: true,
        customer: {
          select: {
            id: true,
            orgId: true,
            code: true,
            name: true,
            isActive: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!user || user.deletedAt || !user.isActive) return null;
    if (!user.customer.isActive || user.customer.deletedAt) return null;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      customerId: user.customer.id,
      customerCode: user.customer.code,
      customerName: user.customer.name,
      orgId: user.customer.orgId,
      visibleBranchIds: user.visibleBranchIds,
    };
  },
);

export const PORTAL_LOGIN_PATH = "/portal/login";
export const PORTAL_PASSWORD_PATH = "/portal/password";

/**
 * Server-component guard for every portal page.
 *
 * A login carrying `mustChangePassword` is bounced to the change-password
 * screen before it reaches anything else — an invited sub-user signs in
 * with a password their account owner chose, and that password must not
 * survive the first session.
 */
export async function requireCustomerUser(
  options: { allowPasswordChange?: boolean; returnTo?: string } = {},
): Promise<CustomerSession> {
  const customer = await getCurrentCustomerUser();

  if (!customer) {
    redirect(
      options.returnTo
        ? `${PORTAL_LOGIN_PATH}?next=${encodeURIComponent(options.returnTo)}`
        : PORTAL_LOGIN_PATH,
    );
  }

  if (customer.mustChangePassword && !options.allowPasswordChange) {
    redirect(PORTAL_PASSWORD_PATH);
  }

  return customer;
}

export class CustomerAuthError extends Error {
  constructor(message = "Not signed in to the portal.") {
    super(message);
    this.name = "CustomerAuthError";
  }
}

/** Guard for server actions, which must throw rather than redirect. */
export async function authorizeCustomer(): Promise<CustomerSession> {
  const customer = await getCurrentCustomerUser();
  if (!customer) throw new CustomerAuthError();
  return customer;
}

/**
 * Sub-user management is the account owner's, and nobody else's.
 * `VIEWER` and `MEMBER` cannot invite, and no role can reach another
 * account — the owning `customerId` is welded on by `ownedByCustomer`.
 */
export function isAccountOwner(session: CustomerSession): boolean {
  return session.role === "OWNER";
}

/** True when this login may create bookings, pickups and addresses. */
export function canWrite(session: CustomerSession): boolean {
  return session.role === "OWNER" || session.role === "MEMBER";
}

/**
 * The scope helper every portal query goes through.
 *
 * Returns a `where` fragment pinned to this session's account. Spread it
 * FIRST and let nothing else write `customerId`, so a caller cannot widen
 * it by accident:
 *
 *   prisma.customerAddress.findMany({ where: { ...ownedByCustomer(s), isActive: true } })
 */
export function ownedByCustomer(session: CustomerSession): {
  customerId: string;
} {
  if (!session.customerId) {
    // Unreachable through `getCurrentCustomerUser`, which always resolves
    // the account. Throwing rather than returning `{}` means a future bug
    // fails closed instead of returning the whole network.
    throw new CustomerAuthError("Portal session has no account.");
  }
  return { customerId: session.customerId };
}
