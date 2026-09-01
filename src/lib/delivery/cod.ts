import Decimal from "decimal.js";
import { prisma, tenantTransaction } from "@/lib/prisma";
import type { CodMode } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { enqueueOutbox } from "@/server/services/outbox";
import { storedDate } from "./calendar";

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
  /** How many of the day's deposits have actually been counted. */
  countedDeposits: number;
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
  // One branch's day end, and only if it is this person's branch. The page
  // validates its query string, but this is an exported service and the
  // guarantee has to live where the read is.
  if (!coversBranch(user, branchId)) return [];

  // `collectedAt` is a real instant, so its window is the *local* day —
  // that is when the agent was at the doors. `depositDate` and `runDate`
  // are `date` columns and are matched at UTC midnight; see `./calendar`.
  const dayStart = startOfDay(date);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const calendarDay = storedDate(date);

  const [collections, deposits, runs] = await Promise.all([
    prisma.codCollection.findMany({
      where: {
        // No `...branchScope()` spread here. It returns `{ branchId: {...} }`,
        // and spread after an explicit `branchId` it *replaced* it — so a
        // manager covering two branches saw both branches' cash added up
        // under whichever one the screen said it was showing, and the
        // shortfall against a single branch's deposits was invented. The
        // `coversBranch` guard above is the scope check; this is the filter.
        branchId,
        collectedAt: { gte: dayStart, lt: dayEnd },
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
      where: { branchId, depositDate: calendarDay },
      select: {
        agentId: true,
        amountDeclared: true,
        amountVerified: true,
        status: true,
      },
    }),
    prisma.deliveryRun.findMany({
      where: { branchId, runDate: calendarDay },
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
      countedDeposits: 0,
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

  // Counted deposits are worth what the branch counted, not what the slip
  // claimed. An uncounted one is worth what was declared — nobody has
  // contradicted it yet.
  for (const deposit of deposits) {
    const row = seat(deposit.agentId, "Unnamed agent");
    const declared = new Decimal(deposit.amountDeclared.toString());
    const counted =
      deposit.amountVerified === null
        ? null
        : new Decimal(deposit.amountVerified.toString());

    row.deposited = row.deposited.plus(counted ?? declared);
    if (counted) {
      row.verified = row.verified.plus(counted);
      row.countedDeposits += 1;
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

  // `@db.Date`. Local midnight files the handover under yesterday at IST,
  // where the SLA shortfall detector — which matches this column at UTC
  // midnight, correctly — would never find it and would open an exception
  // against an agent who had handed in every rupee. See `./calendar`.
  const depositDate = storedDate(input.depositDate);

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
 *
 * ── The shortfall this measures ─────────────────────────────────────────
 *
 * `shortfall` is what is missing against **what the agent took at the
 * doors** — never against what their own slip claimed. That distinction
 * used to be lost here: `createCodDeposit` stored `collected − declared`
 * and this function overwrote it with `declared − verified`. An agent who
 * collected ₹1,000, declared ₹800 and had ₹800 counted therefore ended the
 * day with a `shortfall` of ₹0, a `VERIFIED` deposit, and every one of the
 * ₹1,000 of collections moved to `RECONCILED` — ₹200 of a customer's money
 * marked settled and then invisible on every screen that reads the deposit.
 *
 * So the count is compared against the collections the deposit actually
 * covers, and a deposit is only `VERIFIED` when nothing is missing. The
 * `disputed` flag still means "the count disagrees with the slip", because
 * that is a different conversation from "the agent is short".
 * ────────────────────────────────────────────────────────────────────────
 */
export async function verifyCodDeposit(
  depositId: string,
  amountVerified: number | string,
  actor: SessionUser,
  remarks?: string | null,
): Promise<
  | { ok: true; shortfall: string; disputed: boolean; miscount: string }
  | { ok: false; error: string }
> {
  if (!can(actor, "cod.reconcile")) {
    return { ok: false, error: "You do not have permission to reconcile COD." };
  }

  const deposit = await prisma.codDeposit.findUnique({
    where: { id: depositId },
    select: {
      id: true,
      branchId: true,
      amountDeclared: true,
      status: true,
      collections: { select: { amountCollected: true } },
    },
  });

  if (!deposit) return { ok: false, error: "That deposit does not exist." };
  if (!coversBranch(actor, deposit.branchId)) {
    return { ok: false, error: "That deposit belongs to another branch." };
  }
  if (deposit.status !== "PENDING") {
    return { ok: false, error: "That deposit has already been counted." };
  }

  const verified = new Decimal(amountVerified || 0);
  const declared = new Decimal(deposit.amountDeclared.toString());
  const collected = deposit.collections.reduce(
    (sum, row) => sum.plus(row.amountCollected.toString()),
    new Decimal(0),
  );

  /** What was taken at the doors and has not reached the branch. */
  const shortfall = collected.minus(verified);
  /** What the count disagrees with the slip about. */
  const miscount = declared.minus(verified);
  const disputed = !shortfall.isZero() || !miscount.isZero();

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

  if (disputed) {
    // §A.11: money counted short at the branch is the same same-day
    // exception as money never handed in. Raised on the count as well as on
    // the handover, because this is where a partial deposit is finally
    // proved rather than merely declared.
    await enqueueOutbox({
      eventType: "cod.shortfall",
      aggregate: "CodDeposit",
      aggregateId: depositId,
      payload: {
        branchId: deposit.branchId,
        stage: "VERIFIED",
        collected: collected.toFixed(2),
        declared: declared.toFixed(2),
        verified: verified.toFixed(2),
        shortfall: shortfall.toFixed(2),
        miscount: miscount.toFixed(2),
      },
    });
  }

  return {
    ok: true,
    shortfall: shortfall.toFixed(2),
    disputed,
    miscount: miscount.toFixed(2),
  };
}

/** Local midnight — a deposit belongs to a day, not to an instant. */
export function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}
