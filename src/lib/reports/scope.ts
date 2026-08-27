import type { SessionUser } from "@/lib/auth/session";
import { anyBranchScope, branchScope } from "@/server/repositories/scope";
import type { ReportFilters } from "./types";

/**
 * Report scoping.
 *
 * Every report query goes through one of these. A branch manager who
 * opens the "network" booking register sees their branch, not the
 * network — and they see it without being told off, because the report
 * header says which branches it covers rather than the report refusing to
 * run.
 *
 * The user's scope and the chosen filter are ANDed. Picking a branch you
 * cannot see therefore returns nothing rather than returning it, which is
 * the correct failure direction.
 */

type Where = Record<string, unknown>;

function and(...clauses: Array<Where | null | undefined>): Where {
  const parts = clauses.filter(
    (clause): clause is Where => Boolean(clause) && Object.keys(clause!).length > 0,
  );

  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  return { AND: parts };
}

/**
 * Shipments, which are reachable through several branch columns — a
 * consignment is visible to its origin, its current location, and its
 * destination.
 */
export function shipmentWhere(
  user: SessionUser,
  filters: ReportFilters,
  dateField: "bookedAt" | "pickedUpAt" | "dispatchedAt" | "deliveredAt" | "statusUpdatedAt" = "bookedAt",
): Where {
  const range = { [dateField]: { gte: filters.from, lte: filters.to } };

  const chosenBranch = filters.branchId
    ? {
        OR: [
          { originBranchId: filters.branchId },
          { destinationBranchId: filters.branchId },
          { currentBranchId: filters.branchId },
          { bookingBranchId: filters.branchId },
        ],
      }
    : null;

  return and(
    { deletedAt: null },
    range,
    anyBranchScope(user, [
      "originBranchId",
      "destinationBranchId",
      "currentBranchId",
    ]),
    chosenBranch,
    filters.customerId ? { consignorId: filters.customerId } : null,
    filters.originBranchId ? { originBranchId: filters.originBranchId } : null,
    filters.destinationBranchId
      ? { destinationBranchId: filters.destinationBranchId }
      : null,
    filters.serviceTypeId ? { serviceTypeId: filters.serviceTypeId } : null,
    filters.mode ? { mode: filters.mode } : null,
    filters.q
      ? {
          OR: [
            { lrNumber: { contains: filters.q, mode: "insensitive" as const } },
            {
              customerReference: {
                contains: filters.q,
                mode: "insensitive" as const,
              },
            },
            {
              consigneeName: { contains: filters.q, mode: "insensitive" as const },
            },
            { consigneePhone: { contains: filters.q } },
          ],
        }
      : null,
  );
}

/** Models with a single `branchId` column: pickups, receipts, runs, COD. */
export function singleBranchWhere(
  user: SessionUser,
  filters: ReportFilters,
  dateField: string,
  branchField = "branchId",
): Where {
  return and(
    { [dateField]: { gte: filters.from, lte: filters.to } },
    branchScope(user, branchField),
    filters.branchId ? { [branchField]: filters.branchId } : null,
  );
}

/** Trips and manifests, which run between two branches. */
export function laneWhere(
  user: SessionUser,
  filters: ReportFilters,
  dateField: string,
): Where {
  const chosenBranch = filters.branchId
    ? {
        OR: [
          { originBranchId: filters.branchId },
          { destinationBranchId: filters.branchId },
        ],
      }
    : null;

  return and(
    { [dateField]: { gte: filters.from, lte: filters.to } },
    anyBranchScope(user, ["originBranchId", "destinationBranchId"]),
    chosenBranch,
    filters.originBranchId ? { originBranchId: filters.originBranchId } : null,
    filters.destinationBranchId
      ? { destinationBranchId: filters.destinationBranchId }
      : null,
  );
}

/**
 * The branches a report actually covers, for the header.
 *
 * Saying it out loud matters: "network report" on a screen that is
 * silently filtered to one branch is how two people compare figures for
 * an hour before working out why they disagree.
 */
export function scopeNote(user: SessionUser): string | null {
  if (user.branchIds === null) return null;
  if (user.branchIds.length === 0) {
    return "You have no branch assigned, so this report covers nothing. Ask an administrator.";
  }
  if (user.branchIds.length === 1) {
    return `Scoped to ${user.primaryBranch?.name ?? "your branch"}.`;
  }
  return `Scoped to your ${user.branchIds.length} assigned branches.`;
}

export { and as andWhere };
