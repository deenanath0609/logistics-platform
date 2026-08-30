import { beforeEach, describe, expect, it, vi } from "vitest";
import { Supervisor } from "../../../workers/supervisor";
import { resetShutdownForTests } from "@/lib/runtime/shutdown";

/**
 * The drain, driven the way the worker drives it.
 *
 * These tests do not call `drainOutbox` directly. They enqueue an event,
 * hand `outboxPass` to a real `Supervisor` — the same class `workers/index.ts`
 * uses — and let the timer fire, because the question is not "does the drain
 * work" but "does a separate process with its own scheduler actually move
 * these rows, and what does it leave behind when it is stopped".
 *
 * The three things proved here, in order of how much they cost when wrong:
 *
 *  1. A row enqueued while nothing is running is drained once the worker
 *     starts. That is the point of taking the loops out of the web server:
 *     the queue is durable, and the drain is somebody else's job.
 *  2. A shutdown mid-pass leaves nothing PROCESSING. A row claimed and
 *     abandoned is invisible — no error, no retry, no alert — and turns up
 *     as "this carrier's notifications stopped" a week later.
 *  3. A row that *was* abandoned, by a process that never got to shut down
 *     politely, comes back. The claim lease is the only thing standing
 *     between a `kill -9` and a permanently stuck event.
 *
 * Prisma is an in-memory table rather than a per-call mock: what matters is
 * the state the rows end up in, and asserting against a real collection says
 * that far more directly than counting calls.
 *
 * Each test uses its own event type. `onOutbox` has no unsubscribe — nothing
 * in production has ever needed one — so handlers accumulate for the life of
 * the file, and distinct names are what keep one test's throwing handler out
 * of the next test's pass.
 */

type Row = {
  id: string;
  orgId: string;
  eventType: string;
  aggregate: string;
  aggregateId: string;
  payload: unknown;
  status: "PENDING" | "PROCESSING" | "DONE" | "DEAD";
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  processedAt: Date | null;
  createdAt: Date;
};

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  nextId: 0,
}));

vi.mock("@/lib/tenant", () => ({
  requireTenantOrgId: async () => "org_acme",
}));

/**
 * One tenant, in the shape `forEachTenant` really has: the work is invoked
 * once per organisation, inside that organisation. The isolation itself is
 * proved in `src/lib/tenant/*`; what is exercised here is the scheduling
 * wrapped around it.
 */
vi.mock("@/lib/tenant/for-each-tenant", () => ({
  forEachTenant: async <T>(
    _options: { job: string },
    work: (tenant: unknown, slice: unknown) => Promise<T>,
  ) => {
    const value = await work(
      { orgId: "org_acme", slug: "acme" },
      { index: 0, total: 1 },
    );
    return {
      results: [{ orgId: "org_acme", slug: "acme", value }],
      ran: 1,
      failed: 0,
    };
  },
}));

vi.mock("@/lib/prisma", () => {
  const rows = () => store.rows as unknown as Row[];

  function matches(row: Row, where: Record<string, unknown>): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;

    if (where.status !== undefined) {
      const wanted = where.status as string | { in: string[] };
      if (typeof wanted === "string") {
        if (row.status !== wanted) return false;
      } else if (!wanted.in.includes(row.status)) {
        return false;
      }
    }

    const due = where.nextAttemptAt as { lte?: Date } | undefined;
    if (due?.lte && row.nextAttemptAt.getTime() > due.lte.getTime()) return false;

    return true;
  }

  return {
    prisma: {
      outboxEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: `evt_${store.nextId++}`,
            status: "PENDING",
            attempts: 0,
            maxAttempts: 10,
            nextAttemptAt: new Date(),
            lastError: null,
            processedAt: null,
            createdAt: new Date(store.nextId),
            ...data,
          } as unknown as Row;
          store.rows.push(row as unknown as Record<string, unknown>);
          return row;
        },

        findMany: async ({
          where,
          take,
        }: {
          where: Record<string, unknown>;
          take?: number;
        }) => {
          const found = rows()
            .filter((row) => matches(row, where))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return take ? found.slice(0, take) : found;
        },

        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hit = rows().filter((row) => matches(row, where));
          for (const row of hit) Object.assign(row, data);
          return { count: hit.length };
        },

        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = rows().find((r) => r.id === where.id);
          if (!row) throw new Error(`no such row ${where.id}`);
          for (const [key, value] of Object.entries(data)) {
            const increment = (value as { increment?: number } | null)?.increment;
            if (typeof increment === "number") {
              (row as Record<string, unknown>)[key] =
                (row[key as keyof Row] as number) + increment;
            } else {
              (row as Record<string, unknown>)[key] = value;
            }
          }
          return row;
        },
      },
    },
  };
});

const outbox = await import("./outbox");

function rows(): Row[] {
  return store.rows as unknown as Row[];
}

function byStatus(status: Row["status"]): Row[] {
  return rows().filter((row) => row.status === status);
}

async function enqueue(eventType: string, aggregateId = "shp_1"): Promise<void> {
  await outbox.enqueueOutbox({
    eventType,
    aggregate: "Shipment",
    aggregateId,
    payload: {},
  });
}

beforeEach(() => {
  // Shutdown is process-wide state by design, so a case that ends with it
  // set would otherwise silently disable the drain in every case after it.
  resetShutdownForTests();
  store.rows.length = 0;
  store.nextId = 0;
});

describe("a worker drains what was enqueued while nothing was running", () => {
  it("moves a queued event to DONE", async () => {
    const seen: string[] = [];
    outbox.onOutbox("probe.drained", async (event) => {
      seen.push(event.aggregateId);
    });

    await enqueue("probe.drained");

    // The state a booking leaves behind: committed, queued, and nothing in
    // the process that wrote it is going to do anything about it.
    expect(byStatus("PENDING")).toHaveLength(1);

    const supervisor = new Supervisor();
    supervisor.start([{ name: "outbox drain", everyMs: 5, run: outbox.outboxPass }]);

    await vi.waitFor(() => expect(byStatus("DONE")).toHaveLength(1));
    await supervisor.shutdown(30_000);

    expect(seen).toEqual(["shp_1"]);
    expect(rows()[0].processedAt).not.toBeNull();
  });

  it("leaves a failed event PENDING with a backoff rather than losing it", async () => {
    outbox.onOutbox("probe.failing", async () => {
      throw new Error("SMS gateway refused the connection");
    });

    await enqueue("probe.failing");
    await outbox.outboxPass();

    const [row] = rows();
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("SMS gateway");
    // Backed off, so the pass five seconds later does not hammer a gateway
    // that has just said no.
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("shutdown mid-pass", () => {
  it("leaves no row claimed but unprocessed", async () => {
    // A handler genuinely still working when the signal arrives — the SMS
    // provider has the request and has not answered yet.
    let release!: () => void;
    const inHandler = new Promise<void>((entered) => {
      outbox.onOutbox("probe.slow", () => {
        entered();
        return new Promise<void>((done) => {
          release = done;
        });
      });
    });

    await enqueue("probe.slow");

    const supervisor = new Supervisor();
    supervisor.start([{ name: "outbox drain", everyMs: 5, run: outbox.outboxPass }]);

    await inHandler;

    // The row is claimed right now. Ending the process here is the bug.
    expect(byStatus("PROCESSING")).toHaveLength(1);

    const stopping = supervisor.shutdown(30_000);
    release();
    const report = await stopping;

    expect(report.clean).toBe(true);
    expect(byStatus("PROCESSING")).toHaveLength(0);
    expect(byStatus("DONE")).toHaveLength(1);
  });

  it("refuses to claim anything new once the signal has arrived", async () => {
    let release!: () => void;
    const inHandler = new Promise<void>((entered) => {
      outbox.onOutbox("probe.late_arrival", () => {
        entered();
        return new Promise<void>((done) => {
          release = done;
        });
      });
    });

    await enqueue("probe.late_arrival", "shp_1");

    const supervisor = new Supervisor();
    supervisor.start([{ name: "outbox drain", everyMs: 5, run: outbox.outboxPass }]);
    await inHandler;

    const stopping = supervisor.shutdown(30_000);

    // A second event lands after the signal — a request that was already in
    // flight in the web tier. It must be left whole for the next worker,
    // not half-claimed by one on its way out.
    await enqueue("probe.late_arrival", "shp_2");
    release();
    await stopping;

    const second = rows().find((row) => row.aggregateId === "shp_2");
    expect(second?.status).toBe("PENDING");
  });
});

describe("a process that never got to shut down politely", () => {
  it("puts back an event whose claim lease has expired", async () => {
    const seen: string[] = [];
    outbox.onOutbox("probe.reclaimed", async (event) => {
      seen.push(event.aggregateId);
    });

    await enqueue("probe.reclaimed");

    // Exactly what a `kill -9` between the claim and the DONE write leaves
    // behind: PROCESSING, with a lease that has since run out. Nothing else
    // in the system ever looks at a PROCESSING row, so without the reclaim
    // this event is stuck for good and no error is raised about it.
    const [row] = rows();
    row.status = "PROCESSING";
    row.nextAttemptAt = new Date(Date.now() - 60_000);

    await outbox.outboxPass();

    expect(seen).toEqual(["shp_1"]);
    expect(row.status).toBe("DONE");
  });

  it("leaves a live claim alone", async () => {
    const seen: string[] = [];
    outbox.onOutbox("probe.live_claim", async (event) => {
      seen.push(event.aggregateId);
    });

    await enqueue("probe.live_claim");

    // Another worker is inside the handlers for this row right now. Taking
    // it back would send the customer the same message twice.
    const [row] = rows();
    row.status = "PROCESSING";
    row.nextAttemptAt = new Date(Date.now() + 60_000);

    await outbox.outboxPass();

    expect(seen).toEqual([]);
    expect(row.status).toBe("PROCESSING");
  });
});
