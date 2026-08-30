import type { PlatformRole } from "@/generated/prisma/client";

/**
 * What each operator role may do.
 *
 * Deliberately a small fixed list rather than the tenant `Permission`
 * catalogue. The two vocabularies must not converge: a tenant permission
 * code appearing here is how, a year from now, someone writes a check that
 * accepts either population. The operator console has nine things it can
 * do; they fit in a literal union and the compiler enforces the spelling.
 */
export type PlatformCapability =
  | "tenant.read"
  | "tenant.write"
  | "tenant.lifecycle"
  | "onboarding.write"
  | "plan.read"
  | "plan.write"
  | "usage.read"
  | "audit.read"
  | "impersonate";

/** Everything an operator can do without changing anything. */
const READ: PlatformCapability[] = [
  "tenant.read",
  "plan.read",
  "usage.read",
  "audit.read",
];

const MATRIX: Record<PlatformRole, ReadonlySet<PlatformCapability>> = {
  OWNER: new Set<PlatformCapability>([
    ...READ,
    "tenant.write",
    "tenant.lifecycle",
    "onboarding.write",
    "plan.write",
    "impersonate",
  ]),

  /*
    Support reads everything and may open a support session, but cannot
    move a tenant's subdomain, change its plan or suspend it. The one
    dangerous capability they hold is impersonation, and that is a grant
    with a reason and an expiry rather than an ambient power.
  */
  SUPPORT: new Set<PlatformCapability>([...READ, "impersonate"]),

  /*
    Billing sees the commercial surface — plans, and the usage those plans
    are priced against — and nothing operational. Notably no `audit.read`:
    who suspended whom and which support session was opened is not a
    billing question.
  */
  BILLING: new Set<PlatformCapability>([
    "tenant.read",
    "plan.read",
    "plan.write",
    "usage.read",
  ]),

  VIEWER: new Set<PlatformCapability>(READ),
};

export function platformCan(
  role: PlatformRole,
  capability: PlatformCapability,
): boolean {
  return MATRIX[role].has(capability);
}

/** For rendering — the nav hides what a role cannot reach. */
export function capabilitiesFor(
  role: PlatformRole,
): ReadonlySet<PlatformCapability> {
  return MATRIX[role];
}

/** Shown next to the operator's name so the limits of a login are visible. */
export const PLATFORM_ROLE_LABEL: Record<PlatformRole, string> = {
  OWNER: "Owner — full control",
  SUPPORT: "Support — read and impersonate",
  BILLING: "Billing — plans and usage",
  VIEWER: "Viewer — read only",
};
