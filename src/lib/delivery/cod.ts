import Decimal from "decimal.js";
import { prisma, tenantTransaction } from "@/lib/prisma";
import type { CodMode } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch, branchScope } from "@/server/repositories/scope";
import { enqueueOutbox } from "@/server/services/outbox";

/**
 * Cash on delivery, from the door to the branch safe.
 *
 * Four states, each a ledger row: `COLLECTED` at the door, `DEPOSITED` when
 * the agent hands it over at day end, `RECONCILED` once the branch has
 * counted it, `REMITTED` when the customer is paid. Money never moves
 * between them silently — every step is a row someone signed for.
 *
 * Everything is `Decimal(14,2)` end to end. A float here is a rupee
 * missing at the end of the month with nobody able to say where.
 *
 * See docs/BRD.html §A.10.
 */

export type AgentCodPosition = {
  agentId: string;
  agentName: string;
  /** Runs the agent had out on this date. */
  runNumbers: string[];
  /** What the shipments on the runs said was due. */
  expected: Decimal;
  /** What the agent actually took at the doors. */
  collected: Decimal;
  /** What has been handed in at the branch. */
  deposited: Decimal;
  /** What the branch has counted and accepted. */
  verified: Decimal;
  /** Collected minus deposited. Red on the day-end screen when non-zero. */
  shortfall: Decimal;
  collectionCount: number;
  /** Collections still sitting with the agent — what a deposit would cover. */
  undepositedIds: string[];
};

/**
 * The day-end position for every agent at a branch.
 *
 * Built from collection rows, not from the run counters, because the
 * counters are a convenience and the rows are the ledger.
 */
export async function agentCodPositions(
  branchId: string,
  date: Date,
  user: SessionUser,
): Promise<AgentCodPosition[]> {
  const dayStart = startOfDay(date);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const [collections, deposits, runs] = await Promise.all([
    prisma.codCollection.findMany({
      where: {
        branchId,
        collectedAt: { gte: dayStart, lt: dayEnd },
        ...branchScope(user, "branchId"),
      },
      select: {
        id: true,
        agentId: true,
        amountExpected: true,
        amountCollected: true,
        state: true,
        depositId: true,
      },
    }),
    prisma.codDeposit.findMany({
      where: { branchId, depositDate: dayStart },
      select: {
        agentId: true,
        amountDeclared: true,
        amountVerified: true,
        status: true,
      },
    }),
    prisma.deliveryRun.findMany({
      where: { branchId, runDate: dayStart },
      select: { number: true, agentId: true, agent: { select: { name: true } } },
    }),
  ]);

  const byAgent = new Map<string, AgentCodPosition>();

  function seat(agentId: string, agentName: string): AgentCodPosition {
    const existing = byAgent.get(agentId);
    if (existing) return existing;

    const fresh: AgentCodPosition = {
      agentId,
      agentName,
      runNumbers: [],
      expected: new Decimal(0),
      collected: new Decimal(0),
      deposited: new Decimal(0),
      verified: new Decimal(0),
      shortfall: new Decimal(0),
      collectionCount: 0,
      undepositedIds: [],
    };
    byAgent.set(agentId, fresh);
    return fresh;
  }

  for (const run of runs) {
    seat(run.agentId, run.agent.name).runNumbers.push(run.number);
  }

  for (const collection of collections) {
    if (!collection.agentId) continue;
    const row = seat(collection.agentId, "Unnamed agent");
    row.expected = row.expected.plus(collection.amountExpected.toString());
    row.collected = row.collected.plus(collection.amountCollected.toString());
    row.collectionCount += 1;
    if (!collection.depositId) row.undepositedIds.push(collection.id);
  }

  for (const deposit of deposits) {
    const row = seat(deposit.agentId, "Unnamed agent");
    row.deposited = row.deposited.plus(deposit.amountDeclared.toString());
    if (deposit.amountVerified) {
      row.verified = row.verified.plus(deposit.amountVerified.toString());
    }
  }

  // Fill in names for agents who collected but have no run on this date —
  // a reassignment mid-day, or a collection synced late from yesterday.
  const unnamed = [...byAgent.values()].filter((row) => row.agentName === "Unnamed agent");
  if (unnamed.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: unnamed.map((row) => row.agentId) } },
      select: { id: true, name: true },
    });
    for (const found of users) {
      const row = byAgent.get(found.id);
      if (row) row.agentName = found.name;
    }
  }

  for (const row of byAgent.values()) {
    row.shortfall = row.collected.minus(row.deposited);
  }

  return [...byAgent.values()].sort((a, b) => {
    // Anyone short sorts to the top: that is what the screen is for.
    const shortfallGap = b.shortfall.comparedTo(a.shortfall);
    if (shortfallGap !== 0) return shortfallGap;
    return a.agentName.localeCompare(b.agentName);
  });
}

export type CreateDepositInput = {
  branchId: string;
  agentId: string;
  depositDate: Date;
  amountDeclared: number | string;
  mode: CodMode;
  reference?: string | null;
  remarks?: string | null;
  /** Collections this deposit covers. Defaults to everything undeposited. */
  collectionIds?: string[];
};

export type DepositResult =
  | { ok: true; depositId: string; shortfall: string }
  | { ok: false; error: string; field?: string };

/**
 * The day-end handover.
 *
 * The declared amount is what the agent says they are handing over; the
 * verified amount is what the branch counts. The difference is the
 * shortfall, and it is stored rather than recomputed on read, because it is
 * the number an inquiry is opened on.
 */
export async function createCodDeposit(
  input: CreateDepositInput,
  actor: SessionUser,
): Promise<DepositResult> {
  if (!can(actor, "cod.deposit")) {
    return { ok: false, error: "You do not have permission to record a COD deposit." };
  }
  if (!coversBranch(actor, input.branchId)) {
    return { ok: false, error: "That branch is outside your scope." };
  }

  const declared = new Decimal(input.amountDeclared || 0);
  if (declared.lessThanOrEqualTo(0)) {
    return { ok: false, error: "Enter the amount being handed over.", field: "amountDeclared" };
  }

  const depositDate = startOfDay(input.depositDate);

  const collections = await prisma.codCollection.findMany({
    where: {
      branchId: input.branchId,
      agentId: input.agentId,
      depositId: null,
      state: "COLLECTED",
      ...(input.collectionIds?.length ? { id: { in: input.collectionIds } } : {}),
    },
    select: { id: true, amountCollected: true },
  });

  if (collections.length === 0) {
    return { ok: false, error: "This agent has nothing outstanding to deposit." };
  }

  const collected = collections.reduce(
    (sum, row) => sum.plus(row.amountCollected.toString()),
    new Decimal(0),
  );

  // Declared minus collected: negative means the agent is holding cash back.
  const shortfall = collected.minus(declared);

  const deposit = await tenantTransaction(async (tx) => {
    const created = await tx.codDeposit.create({
      data: {
        // The clerk taking the handover. The collections being covered were
        // read under the same tenant a moment ago.
        orgId: actor.orgId,
        branchId: input.branchId,
        agentId: input.agentId,
        depositDate,
        amountDeclared: declared.toFixed(2),
        shortfall: shortfall.toFixed(2),
        mode: input.mode,
        reference: input.reference ?? undefined,
        remarks: input.remarks ?? undefined,
      },
      select: { id: true },
    });

    await tx.codCollection.updateMany({
      where: { id: { in: collections.map((row) => row.id) } },
      data: { depositId: created.id, state: "DEPOSITED" },
    });

    if (!shortfall.isZero()) {
      // §A.11: a COD shortfall at day end is a same-day exception owned by
      // branch accounts. Raised here so it cannot be quietly absorbed.
      await enqueueOutbox(
        {
          eventType: "cod.shortfall",
          aggregate: "CodDeposit",
          aggregateId: created.id,
          payload: {
            branchId: input.branchId,
            agentId: input.agentId,
            depositDate: depositDate.toISOString(),
            collected: collected.toFixed(2),
            declared: declared.toFixed(2),
            shortfall: shortfall.toFixed(2),
          },
        },
        tx,
      );
    }

    return created;
  });

  return { ok: true, depositId: deposit.id, shortfall: shortfall.toFixed(2) };
}

/**
 * The branch counts the cash.
 *
 * A deposit that counts short is `DISPUTED`, not silently accepted, and its
 * collections stay where they are until somebody resolves it.
 */
export async function verifyCodDeposit(
  depositId: string,
  amountVerified: number | string,
  actor: SessionUser,
  remarks?: string | null,
): Promise<{ ok: true; shortfall: string; disputed: boolean } | { ok: false; error: string }> {
  if (!can(actor, "cod.reconcile")) {
    return { ok: false, error: "You do not have permission to reconcile COD." };
  }

  const deposit = await prisma.codDeposit.findUnique({
    where: { id: depositId },
    select: { id: true, branchId: true, amountDeclared: true, status: true },
  });

  if (!deposit) return { ok: false, error: "That deposit does not exist." };
  if (!coversBranch(actor, deposit.branchId)) {
    return { ok: false, error: "That deposit belongs to another branch." };
  }
  if (deposit.status !== "PENDING") {
    return { ok: false, error: "That deposit has already been counted." };
  }

  const verified = new Decimal(amountVerified || 0);
  const shortfall = new Decimal(deposit.amountDeclared.toString()).minus(verified);
  const disputed = !shortfall.isZero();

  await tenantTransaction(async (tx) => {
    await tx.codDeposit.update({
      where: { id: depositId },
      data: {
        amountVerified: verified.toFixed(2),
        shortfall: shortfall.toFixed(2),
        status: disputed ? "DISPUTED" : "VERIFIED",
        verifiedById: actor.id,
        verifiedAt: new Date(),
        remarks: remarks ?? undefined,
      },
    });

    if (!disputed) {
      await tx.codCollection.updateMany({
        where: { depositId, state: "DEPOSITED" },
        data: { state: "RECONCILED" },
      });
    }
  });

  return { ok: true, shortfall: shortfall.toFixed(2), disputed };
}

/** Local midnight — a deposit belongs to a day, not to an instant. */
export function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}
