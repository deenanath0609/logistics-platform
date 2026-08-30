import Decimal from "decimal.js";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { can, type SessionUser } from "@/lib/auth/session";
import { branchScope, coversBranch } from "@/server/repositories/scope";
import {
  canDeactivateFieldUser,
  latestActivity,
  syncFreshness,
  OPEN_RUN_STATUSES,
  UNFINISHED_PICKUP_STATUSES,
  type OpenWork,
  type SyncFreshness,
} from "./field-staff";

/**
 * The database side of field-staff management.
 *
 * The rules themselves live in `./field-staff.ts` and are pure. This file
 * owns the reads that feed them and the transaction boundaries around the
 * writes, so a server action can stay a permission gate and a form parse.
 *
 * Every query here is tenant-scoped by the Prisma extension — see
 * docs/adr/001-multi-tenancy.md. No `orgId` appears in a `where`, and the
 * only place it is written is a `create`, from the actor.
 */

export type FieldStaffResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

// ────────────────────────────────────────────────────────────
// Open work
// ────────────────────────────────────────────────────────────

/**
 * What this person is still holding.
 *
 * Runs carry their remaining stop count because "reassign run DR-DEL-0042"
 * and "reassign run DR-DEL-0042, six stops still out" are different
 * amounts of urgency to a branch manager.
 */
export async function openWorkFor(userId: string): Promise<OpenWork> {
  const [runs, pickups] = await Promise.all([
    prisma.deliveryRun.findMany({
      where: { agentId: userId, status: { in: [...OPEN_RUN_STATUSES] } },
      orderBy: { runDate: "asc" },
      select: {
        number: true,
        status: true,
        _count: {
          select: {
            tasks: { where: { status: { in: ["PENDING", "OUT_FOR_DELIVERY"] } } },
          },
        },
      },
    }),
    prisma.pickupAssignment.findMany({
      where: {
        assignedToId: userId,
        supersededAt: null,
        status: { in: [...UNFINISHED_PICKUP_STATUSES] },
      },
      orderBy: { assignedAt: "asc" },
      select: { request: { select: { number: true } } },
    }),
  ]);

  return {
    runs: runs.map((run) => ({
      number: run.number,
      status: run.status,
      stopsRemaining: run._count.tasks,
    })),
    pickups: pickups.map((assignment) => ({
      number: assignment.request.number,
    })),
  };
}

// ────────────────────────────────────────────────────────────
// Deactivate / reactivate
// ────────────────────────────────────────────────────────────

/**
 * Removal is `status = INACTIVE` plus `deletedAt`, never a row deletion —
 * the reasoning is written out at `deactivateUser` in
 * `src/app/(ops)/admin/users/actions.ts`, which is the only caller.
 */
export async function deactivateFieldUser(
  userId: string,
  actor: SessionUser,
): Promise<FieldStaffResult> {
  if (!can(actor, "user.manage")) {
    return { ok: false, error: "You do not have permission to manage users." };
  }
  if (userId === actor.id) {
    return { ok: false, error: "You cannot deactivate your own account." };
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      mobile: true,
      status: true,
      deletedAt: true,
      primaryBranchId: true,
    },
  });

  if (!target) return { ok: false, error: "That person no longer exists." };
  if (!coversBranch(actor, target.primaryBranchId ?? "")) {
    return { ok: false, error: "That person is outside your scope." };
  }
  if (target.deletedAt) {
    return { ok: false, error: `${target.name} is already deactivated.` };
  }

  const check = canDeactivateFieldUser(target.name, await openWorkFor(userId));
  if (!check.ok) return { ok: false, error: check.reason };

  await tenantTransaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { status: "INACTIVE", deletedAt: new Date() },
    });

    // No second access check is added anywhere for this. `getCurrentUser()`
    // reloads roles and status from the database on every request and
    // returns null for `deletedAt` or a status other than ACTIVE, so the
    // very next request this person's phone makes resolves to nobody and
    // every `authorize()` throws. Revoking the sessions here only saves
    // that one round trip and keeps the session table honest.
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  return { ok: true, name: target.name };
}

export async function reactivateFieldUser(
  userId: string,
  actor: SessionUser,
): Promise<FieldStaffResult> {
  if (!can(actor, "user.manage")) {
    return { ok: false, error: "You do not have permission to manage users." };
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, deletedAt: true, primaryBranchId: true },
  });

  if (!target) return { ok: false, error: "That person no longer exists." };
  if (!coversBranch(actor, target.primaryBranchId ?? "")) {
    return { ok: false, error: "That person is outside your scope." };
  }
  if (!target.deletedAt) {
    return { ok: false, error: `${target.name} is already active.` };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { status: "ACTIVE", deletedAt: null },
  });

  return { ok: true, name: target.name };
}

// ────────────────────────────────────────────────────────────
// The roster
// ────────────────────────────────────────────────────────────

export type FieldStaffRow = {
  id: string;
  name: string;
  mobile: string;
  email: string | null;
  employeeCode: string | null;
  status: string;
  isDeactivated: boolean;
  primaryBranchId: string | null;
  branch: { code: string; name: string } | null;
  roleIds: string[];
  /** The run they are on right now, if any. */
  openRun: {
    id: string;
    number: string;
    status: string;
    totalStops: number;
    stopsRemaining: number;
    codExpected: string;
  } | null;
  /** Pickups assigned and not yet collected. */
  openPickups: number;
  /** Cash collected and not yet handed over, in rupees. */
  codInHand: string;
  lastActivityAt: Date | null;
  freshness: SyncFreshness;
};

export type RosterFilters = {
  branchId?: string;
  /** "active" (the default), "inactive", or "all". */
  presence?: string;
  q?: string;
  skip?: number;
  take?: number;
};

/**
 * The roster's `where`, shared by the listing and its count so the two can
 * never disagree about who is on the screen.
 *
 * The chosen branch and the actor's scope are combined with `AND`, not
 * merged into one object. Spreading them would put two `primaryBranchId`
 * keys in the same literal and the later one wins — which is a branch
 * filter in the query string *escaping* the actor's scope rather than
 * narrowing inside it.
 */
function rosterWhere(actor: SessionUser, filters: RosterFilters) {
  const presence = filters.presence ?? "active";

  return {
    isFieldUser: true,
    // Unlike /admin/users, a deactivated row is *not* filtered out here.
    // This is the screen where somebody is stood down, so it has to be the
    // screen where they can be found again and brought back.
    ...(presence === "active"
      ? { deletedAt: null }
      : presence === "inactive"
        ? { NOT: { deletedAt: null } }
        : {}),
    AND: [
      branchScope(actor, "primaryBranchId"),
      ...(filters.branchId ? [{ primaryBranchId: filters.branchId }] : []),
      ...(filters.q
        ? [
            {
              OR: [
                { name: { contains: filters.q, mode: "insensitive" as const } },
                { mobile: { contains: filters.q } },
                {
                  employeeCode: {
                    contains: filters.q,
                    mode: "insensitive" as const,
                  },
                },
              ],
            },
          ]
        : []),
    ],
  };
}

export async function countFieldStaff(
  actor: SessionUser,
  filters: RosterFilters,
): Promise<number> {
  return prisma.user.count({ where: rosterWhere(actor, filters) });
}

/**
 * One screenful of field staff with what each is carrying.
 *
 * Assembled as a handful of set-based queries rather than a query per
 * person: a branch with forty delivery boys would otherwise cost a hundred
 * and sixty round trips to render one page.
 */
export async function loadFieldStaffRoster(
  actor: SessionUser,
  filters: RosterFilters,
  asOf: Date = new Date(),
): Promise<FieldStaffRow[]> {
  const users = await prisma.user.findMany({
    where: rosterWhere(actor, filters),
    skip: filters.skip,
    take: filters.take,
    orderBy: [{ deletedAt: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      mobile: true,
      email: true,
      employeeCode: true,
      status: true,
      deletedAt: true,
      lastLoginAt: true,
      primaryBranchId: true,
      primaryBranch: { select: { code: true, name: true } },
      roles: { select: { roleId: true } },
    },
  });

  const ids = users.map((user) => user.id);
  if (ids.length === 0) return [];

  const [openRuns, openPickups, runActivity, pickupActivity, cod] =
    await Promise.all([
      prisma.deliveryRun.findMany({
        where: { agentId: { in: ids }, status: { in: [...OPEN_RUN_STATUSES] } },
        orderBy: { runDate: "desc" },
        select: {
          id: true,
          number: true,
          status: true,
          agentId: true,
          totalTasks: true,
          codExpected: true,
          _count: {
            select: {
              tasks: {
                where: { status: { in: ["PENDING", "OUT_FOR_DELIVERY"] } },
              },
            },
          },
        },
      }),

      prisma.pickupAssignment.groupBy({
        by: ["assignedToId"],
        where: {
          assignedToId: { in: ids },
          supersededAt: null,
          status: { in: [...UNFINISHED_PICKUP_STATUSES] },
        },
        _count: { _all: true },
      }),

      // `recalculateRunTotals` rewrites the run row on every delivery the
      // phone syncs, so `updatedAt` on the newest run is the closest thing
      // this schema has to "when did we last hear from that handset".
      prisma.deliveryRun.groupBy({
        by: ["agentId"],
        where: { agentId: { in: ids } },
        _max: { updatedAt: true },
      }),

      prisma.pickupAssignment.groupBy({
        by: ["assignedToId"],
        where: { assignedToId: { in: ids } },
        _max: { completedAt: true, startedAt: true },
      }),

      // Cash collected at the door and not yet deposited at the branch.
      // Anything past COLLECTED has left their hands.
      prisma.codCollection.groupBy({
        by: ["agentId"],
        where: { agentId: { in: ids }, state: "COLLECTED" },
        _sum: { amountCollected: true },
      }),
    ]);

  // A stop closed after the run row was last written is newer than the run
  // row itself, so the task timestamps get a look too. Scoped to the open
  // runs already loaded, which keeps this bounded to today's work.
  const openRunIds = openRuns.map((run) => run.id);
  const taskActivity = openRunIds.length
    ? await prisma.deliveryTask.groupBy({
        by: ["runId"],
        where: { runId: { in: openRunIds } },
        _max: { updatedAt: true },
      })
    : [];

  const runByAgent = new Map(openRuns.map((run) => [run.agentId, run]));
  const pickupCount = new Map(
    openPickups.map((row) => [row.assignedToId, row._count._all]),
  );
  const runSeen = new Map(
    runActivity.map((row) => [row.agentId, row._max.updatedAt]),
  );
  const pickupSeen = new Map(
    pickupActivity.map((row) => [
      row.assignedToId,
      latestActivity(row._max.completedAt, row._max.startedAt),
    ]),
  );
  const codByAgent = new Map(
    cod.map((row) => [row.agentId, row._sum.amountCollected]),
  );
  const taskSeenByRun = new Map(
    taskActivity.map((row) => [row.runId, row._max.updatedAt]),
  );

  return users.map((user) => {
    const run = runByAgent.get(user.id) ?? null;
    const lastActivityAt = latestActivity(
      runSeen.get(user.id) ?? null,
      pickupSeen.get(user.id) ?? null,
      run ? (taskSeenByRun.get(run.id) ?? null) : null,
      user.lastLoginAt,
    );

    return {
      id: user.id,
      name: user.name,
      mobile: user.mobile,
      email: user.email,
      employeeCode: user.employeeCode,
      status: user.status,
      isDeactivated: user.deletedAt !== null,
      primaryBranchId: user.primaryBranchId,
      branch: user.primaryBranch,
      roleIds: user.roles.map((role) => role.roleId),
      openRun: run
        ? {
            id: run.id,
            number: run.number,
            status: run.status,
            totalStops: run.totalTasks,
            stopsRemaining: run._count.tasks,
            codExpected: new Decimal(run.codExpected.toString()).toFixed(2),
          }
        : null,
      openPickups: pickupCount.get(user.id) ?? 0,
      codInHand: new Decimal(
        codByAgent.get(user.id)?.toString() ?? 0,
      ).toFixed(2),
      lastActivityAt,
      freshness: syncFreshness(lastActivityAt, asOf),
    };
  });
}
