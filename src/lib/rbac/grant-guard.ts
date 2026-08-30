import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";

/**
 * ── Nobody may grant what they do not hold ──────────────────────────────
 *
 * `role.manage` and `user.manage` were each, on their own, a route to
 * everything. The role editor wrote whatever permission codes the form
 * posted; the user form wrote whatever role ids it posted. Someone holding
 * only `role.manage` could tick `settlement.approve`, `invoice.approve` and
 * `cod.reconcile` onto a role they themselves hold — or skip the detour and
 * assign themselves SUPER_ADMIN from the user screen. Both writes were
 * audited, which is how you find out afterwards, not how you stop it.
 *
 * Both call sites now come through here, so the rule cannot be enforced in
 * one screen and forgotten in the other: a grant is refused unless the
 * actor already holds every permission it confers.
 *
 * Revocation is deliberately *not* checked. Taking a permission away is not
 * an escalation, and an administrator must be able to strip a role of
 * something they do not hold themselves — otherwise the first response to a
 * compromised role would be blocked by this very guard.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * What the actor holds according to their roles — read from the database
 * rather than taken from `actor.permissions`.
 *
 * The session set has already been narrowed to the modules the carrier
 * bought (`session.ts::withoutUnboughtModules`). Comparing against that
 * narrowed set would mean an administrator could not configure a role for a
 * module the carrier has not bought yet, and — worse — a Super Admin in
 * such an organisation could not save the Super Admin role at all, since
 * that role is required to keep every permission in the catalogue while
 * their own session set would be missing the unbought ones. What a person
 * may hand out is a question about their roles; what they may *do* today is
 * the question modules answer, and it is asked separately.
 */
async function permissionsHeldBy(actor: SessionUser): Promise<Set<string>> {
  const roles = await prisma.role.findMany({
    where: { isActive: true, users: { some: { userId: actor.id } } },
    select: { permissions: { select: { permission: { select: { code: true } } } } },
  });

  const held = new Set<string>();
  for (const role of roles) {
    for (const rp of role.permissions) held.add(rp.permission.code);
  }
  return held;
}

/** The codes among `requested` that the actor cannot pass on, sorted. */
export async function permissionsBeyondActor(
  actor: SessionUser,
  requested: Iterable<string>,
): Promise<string[]> {
  const held = await permissionsHeldBy(actor);
  return [...new Set(requested)].filter((code) => !held.has(code)).sort();
}

/**
 * The same question asked of whole roles: assigning a role hands over
 * everything inside it, so SUPER_ADMIN is refused here for exactly the
 * reason `settlement.approve` is refused above — not by naming it.
 */
export async function rolesBeyondActor(
  actor: SessionUser,
  roleIds: string[],
): Promise<Array<{ name: string; codes: string[] }>> {
  if (roleIds.length === 0) return [];

  const [held, roles] = await Promise.all([
    permissionsHeldBy(actor),
    prisma.role.findMany({
      where: { id: { in: roleIds } },
      select: {
        name: true,
        permissions: { select: { permission: { select: { code: true } } } },
      },
    }),
  ]);

  return roles
    .map((role) => ({
      name: role.name,
      codes: role.permissions
        .map((rp) => rp.permission.code)
        .filter((code) => !held.has(code))
        .sort(),
    }))
    .filter((entry) => entry.codes.length > 0);
}

/** How many offending codes to name before summarising the rest. */
const LISTED = 4;

/** A refusal that names what is missing, so it can be asked for. */
export function escalationMessage(subject: string, codes: string[]): string {
  const named = codes.slice(0, LISTED).join(", ");
  const rest =
    codes.length > LISTED ? ` and ${codes.length - LISTED} more` : "";
  return (
    `${subject} would grant permissions you do not hold yourself: ` +
    `${named}${rest}. Ask someone who holds them to make this change.`
  );
}
