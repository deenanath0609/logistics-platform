import { describe, expect, it, vi } from "vitest";

/**
 * The watchdog's only output is words, so the words are what is tested.
 *
 * This is not pedantry about wording. The whole design of the split rests on
 * one bet: that a developer who runs the web server without a worker finds
 * out from the machine rather than from a customer. If this message ever
 * stops naming the command, or stops saying that a healthy-looking UI is
 * exactly what a dead pipeline looks like, the bet is off and nothing else
 * in the system will notice.
 */

vi.mock("@/lib/prisma", () => ({ prisma: { outboxEvent: { count: async () => 0 } } }));
vi.mock("@/lib/tenant/context", () => ({
  runCrossTenant: <T>(_reason: string, fn: () => T) => fn(),
}));

const { START_WORKER_ADVICE, backlogWarning } = await import("./worker-watchdog");

describe("what a developer without a worker is told", () => {
  it("names the command to run", () => {
    expect(START_WORKER_ADVICE).toContain("npm run worker");
  });

  it("says what silently stops working", () => {
    // The list matters more than the instruction: "start the worker" is
    // easy to skim past, "no webhook fires" is not.
    for (const consequence of ["notifications", "webhooks", "GPS", "SLA"]) {
      expect(START_WORKER_ADVICE).toContain(consequence);
    }
  });

  it("warns that the UI will look fine anyway", () => {
    expect(START_WORKER_ADVICE.toLowerCase()).toContain("look entirely healthy");
  });

  it("offers the single-process escape hatch", () => {
    expect(START_WORKER_ADVICE).toContain("RUN_JOBS_IN_WEB=true");
  });
});

describe("the backlog warning", () => {
  it("reports the evidence and then the advice", () => {
    const message = backlogWarning(42, 2 * 60_000);

    // The count is the part that makes this different from the boot
    // message: it is proof rather than a reminder.
    expect(message).toContain("42 outbox event(s)");
    expect(message).toContain("more than 2 minute(s)");
    expect(message).toContain(START_WORKER_ADVICE);
  });
});
