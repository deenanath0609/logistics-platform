import type { SessionUser } from "@/lib/auth/session";

/**
 * Branch and ownership scoping.
 *
 * Every query that returns operational records must pass through one of
 * these. Enforcing it here rather than in the UI is what makes the Phase 1
 * acceptance test — "a Delhi branch manager cannot see a Jaipur shipment
 * through the UI or the API" — hold for both surfaces at once.
 */

/**
 * A Prisma `where` fragment restricting rows to the branches this user may
 * see. Returns `{}` only for genuinely network-scoped users.
 *
 * `field` names the branch column on the target model, which is not always
 * `branchId` — a shipment has `originBranchId` and `currentBranchId`.
 */
export function branchScope(
  user: SessionUser,
  field = "branchId",
): Record<string, unknown> {
  if (user.branchIds === null) return {};

  // A scoped user with no branch assigned sees nothing. `in: []` matches no
  // rows, which is the safe reading — the alternative, returning `{}`, would
  // silently hand them the whole network.
  return { [field]: { in: user.branchIds } };
}

/**
 * Scoping for models reachable through several branch columns — a shipment
 * is visible to its origin, its current location, and its destination.
 */
export function anyBranchScope(
  user: SessionUser,
  fields: string[],
): Record<string, unknown> {
  if (user.branchIds === null) return {};
  return { OR: fields.map((field) => branchScope(user, field)) };
}

/**
 * Scoping for task-style models a field user owns — delivery runs, pickup
 * assignments. OWN-scope users see only rows assigned to them; wider scopes
 * fall back to branch scoping.
 */
export function assignmentScope(
  user: SessionUser,
  assigneeField = "assignedToId",
  branchField = "branchId",
): Record<string, unknown> {
  if (user.scope === "OWN") return { [assigneeField]: user.id };
  return branchScope(user, branchField);
}

/** True when the user may act on a record belonging to this branch. */
export function coversBranch(user: SessionUser, branchId: string): boolean {
  return user.branchIds === null || user.branchIds.includes(branchId);
}
