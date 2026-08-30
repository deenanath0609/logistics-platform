import { describe, expect, it, vi } from "vitest";
import { isCrossTenantScope } from "@/lib/tenant/context";

/**
 * That the watchdog's own query is still inside the scope that authorises it.
 *
 * This is a regression test for a bug that shipped green because the other
 * watchdog test replaces `runCrossTenant` with `fn => fn()`, which has no
 * AsyncLocalStorage in it at all. With the real one, the shape of the
 * callback decides whether the declaration is in force when the query runs:
 *
 *   runCrossTenant(reason, () => prisma.x.count(...))   // scope already gone
 *   runCrossTenant(reason, async () => await prisma.x.count(...))  // held
 *
 * A Prisma promise is lazy — building the call runs nothing. The first form
 * returns it unexecuted, `runCrossTenant` pops the scope, and the await
 * happens in the caller with no declaration in sight. The tenant extension
 * then refuses the read. Because the watchdog catches its own errors so a
 * database hiccup cannot take the web server down, this failed silently:
 * every minute, forever, and the outbox backlog it exists to report went
 * unreported for the life of the process.
 *
 * So this test does not assert a count. It asserts *where* the query ran.
 */

/** Records whether the cross-tenant declaration was in force at execution. */
let scopeAtExecution: boolean | null = null;

/**
 * A stand-in with the one property of a Prisma promise that caused the bug:
 * nothing happens until something awaits it.
 */
vi.mock("@/lib/prisma", () => ({
  prisma: {
    outboxEvent: {
      count: () => ({
        then(resolve: (value: number) => unknown) {
          scopeAtExecution = isCrossTenantScope();
          return Promise.resolve(0).then(resolve);
        },
      }),
    },
  },
}));

const { stalePendingEvents } = await import("./worker-watchdog");

describe("the watchdog's cross-tenant read", () => {
  it("runs while the declaration is still in force", async () => {
    scopeAtExecution = null;

    await stalePendingEvents();

    expect(scopeAtExecution).toBe(true);
  });

  it("leaves no scope behind once it has finished", async () => {
    await stalePendingEvents();

    // The declaration is for one query, not for whatever the timer does
    // next. If it leaked, an ordinary tenant-scoped read afterwards would
    // quietly see every carrier's rows.
    expect(isCrossTenantScope()).toBe(false);
  });
});
