import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The settlements form, between the browser and the service.
 *
 * Five server actions across `src/app/(ops)/finance` had no coverage of any
 * kind: no unit test, and no verify script, because a server action cannot
 * be driven over HTTP the way a page can. These four are the ones that move
 * money, and everything they decide before calling the service — what a
 * typed deduction means, whether a reason was given, what a refusal looks
 * like to the person who posted the form — was decided by nothing that
 * could fail.
 *
 * The service behind them is covered by `settlement.test.ts` and
 * `settlement-approve.test.ts`. This file is only about the layer above:
 * what reaches `createSettlement`, and what comes back to the screen.
 *
 * ── The one thing worth stating plainly ─────────────────────────────────
 *
 * `deductions` is carried to the service as a *string*, never as a number.
 * The action's own comment explains why — `MoneyIn` takes a string and
 * `dec()` reads it exactly, and "a deduction is the one line on a settlement
 * a driver argues about" — but nothing checked that the string survived.
 * `Number(raw)` appears twice in the parsing, once to validate and once to
 * compare, and either could have become the value passed on.
 */

const store = vi.hoisted(() => ({
  /** Every `createSettlement` input, in order. */
  prepared: [] as Array<Record<string, unknown>>,
  approved: [] as Array<Record<string, unknown>>,
  paid: [] as Array<Record<string, unknown>>,
  cancelled: [] as Array<Record<string, unknown>>,
  revalidated: [] as string[],
  /** What the mocked service hands back. */
  result: { ok: true, number: "SET/2627/000009", netPayable: 19000 } as Record<
    string,
    unknown
  >,
  /** Set to make the next `createSettlement` throw rather than return. */
  throwNext: null as Error | null,
  /** Permissions the mocked `authorize` will accept. */
  held: new Set<string>([
    "settlement.prepare",
    "settlement.approve",
    "payment.record",
  ]),
}));

class PermissionError extends Error {
  constructor(public permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "PermissionError";
  }
}

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    store.revalidated.push(path);
  },
}));

vi.mock("@/lib/auth/session", () => ({
  PermissionError,
  authorize: async (permission: string) => {
    if (!store.held.has(permission)) throw new PermissionError(permission);
    return { id: "usr-accounts", orgId: "org-1", name: "Accounts" };
  },
}));

vi.mock("@/lib/billing/settlement", () => ({
  createSettlement: async (input: Record<string, unknown>) => {
    if (store.throwNext) {
      const error = store.throwNext;
      store.throwNext = null;
      throw error;
    }
    store.prepared.push(input);
    return store.result;
  },
  approveSettlement: async (input: Record<string, unknown>) => {
    store.approved.push(input);
    return store.result;
  },
  markSettlementPaid: async (input: Record<string, unknown>) => {
    store.paid.push(input);
    return store.result;
  },
  cancelSettlement: async (input: Record<string, unknown>) => {
    store.cancelled.push(input);
    return store.result;
  },
}));

const {
  prepareSettlementAction,
  approveSettlementAction,
  markSettlementPaidAction,
  cancelSettlementAction,
} = await import("./actions");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  store.prepared = [];
  store.approved = [];
  store.paid = [];
  store.cancelled = [];
  store.revalidated = [];
  store.result = { ok: true, number: "SET/2627/000009", netPayable: 19000 };
  store.held = new Set(["settlement.prepare", "settlement.approve", "payment.record"]);
  store.throwNext = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── what reaches the service ────────────────────────────────────────────

describe("prepareSettlementAction, on the deduction field", () => {
  it("hands the service the digits that were typed, as a string", async () => {
    await prepareSettlementAction({}, form({ tripId: "trip-1", deductions: "1250.55" }));

    expect(store.prepared.at(0)).toMatchObject({ deductions: "1250.55" });
    expect(typeof store.prepared.at(0)?.deductions).toBe("string");
  });

  it("does not round-trip the figure through a double", async () => {
    // 0.1 + 0.2 arithmetic on a deduction is a rupee the driver notices.
    // These two survive `Number()` and back with different values.
    for (const typed of ["1000.10", "0.07", "12345678901234.56"]) {
      store.prepared = [];
      await prepareSettlementAction({}, form({ tripId: "trip-1", deductions: typed }));
      expect(store.prepared.at(0)?.deductions, typed).toBe(typed);
    }
  });

  it("treats a blank deduction as zero rather than as absent", async () => {
    for (const blank of ["", "   "]) {
      store.prepared = [];
      await prepareSettlementAction({}, form({ tripId: "trip-1", deductions: blank }));
      expect(store.prepared.at(0)?.deductions, JSON.stringify(blank)).toBe("0");
    }

    store.prepared = [];
    await prepareSettlementAction({}, form({ tripId: "trip-1" }));
    expect(store.prepared.at(0)?.deductions).toBe("0");
  });

  it("refuses a negative deduction with a field error, and prepares nothing", async () => {
    // A negative deduction is an addition: it pays the driver *more* than
    // the trip earned, from a field labelled "deductions".
    for (const negative of ["-1", "-0.01", "-25000"]) {
      const result = await prepareSettlementAction(
        {},
        form({ tripId: "trip-1", deductions: negative }),
      );

      expect(result.error, negative).toMatch(/cannot be negative/i);
      expect(result.fieldErrors?.deductions, negative).toBeTruthy();
    }
    expect(store.prepared).toHaveLength(0);
    expect(store.revalidated).toHaveLength(0);
  });

  /**
   * Recorded rather than asserted as desirable.
   *
   * An unparseable figure — `"1,200"` from a keyboard that inserts group
   * separators, `"12oo"`, `"₹500"` — fails `Number.isFinite` and is
   * silently replaced with `"0"`. The settlement is then prepared with no
   * deduction at all and no error on the screen, which pays the driver the
   * full amount and reconciles to nobody's satisfaction later. The negative
   * branch two lines above returns a field error for its bad input; this
   * one does not.
   *
   * The assertion is written in the direction that stays true whichever way
   * that is settled: an unparseable deduction must never become a *charge*.
   * If it grows a field error instead, only the second half changes.
   */
  it("never turns an unparseable deduction into a charge against the driver", async () => {
    for (const junk of ["1,200", "12oo", "₹500", "abc", "1_000"]) {
      store.prepared = [];
      const result = await prepareSettlementAction(
        {},
        form({ tripId: "trip-1", deductions: junk }),
      );

      const deduction = store.prepared.at(0)?.deductions as string | undefined;
      if (deduction !== undefined) expect(Number(deduction), junk).toBe(0);
      else expect(result.error, junk).toBeTruthy();
    }
  });

  it("passes a typed trip earning along, and omits it when it is not a number", async () => {
    // The service decides whether to trust it — this only has to not lose
    // it, and not invent one.
    await prepareSettlementAction(
      {},
      form({ tripId: "trip-1", tripEarning: "18000.00" }),
    );
    expect(store.prepared.at(0)).toMatchObject({ tripEarning: "18000.00" });

    for (const junk of ["", "  ", "not a number"]) {
      store.prepared = [];
      await prepareSettlementAction({}, form({ tripId: "trip-1", tripEarning: junk }));
      expect(store.prepared.at(0)?.tripEarning, JSON.stringify(junk)).toBeUndefined();
    }
  });

  it("refuses a post with no trip at all, before reaching the service", async () => {
    const result = await prepareSettlementAction({}, form({ deductions: "100" }));

    expect(result.error).toMatch(/pick a trip/i);
    expect(store.prepared).toHaveLength(0);
  });

  it("tells the preparer that a second person is needed", async () => {
    const result = await prepareSettlementAction({}, form({ tripId: "trip-1" }));

    expect(result.ok).toBe(true);
    expect(result.message).toContain("SET/2627/000009");
    expect(result.message).toMatch(/second person/i);
    expect(store.revalidated).toEqual(["/finance/settlements"]);
  });
});

// ── the reason, which is what the audit row is for ──────────────────────

describe("approveSettlementAction", () => {
  it("insists on a reason before it will call the service", async () => {
    for (const reason of ["", "   "]) {
      const result = await approveSettlementAction(
        {},
        form({ id: "set-1", reason }),
      );

      expect(result.error, JSON.stringify(reason)).toMatch(/reason is required/i);
      expect(result.fieldErrors?.reason).toBeTruthy();
    }
    expect(store.approved).toHaveLength(0);
    expect(store.revalidated).toHaveLength(0);
  });

  it("refuses a post with nothing selected", async () => {
    const result = await approveSettlementAction({}, form({ reason: "Checked." }));

    expect(result.error).toMatch(/nothing selected/i);
    expect(store.approved).toHaveLength(0);
  });

  it("passes the reason through untouched, so the audit row is what was typed", async () => {
    await approveSettlementAction(
      {},
      form({ id: "set-1", reason: "Fuel bills and toll receipts seen." }),
    );

    expect(store.approved.at(0)).toEqual({
      settlementId: "set-1",
      reason: "Fuel bills and toll receipts seen.",
    });
  });

  it("shows the service's own refusal rather than a generic one", async () => {
    // The two-person rule refuses here, and the person reading the screen
    // has to be told which rule stopped them or they will simply try again.
    store.result = {
      ok: false,
      error: "A settlement cannot be approved by the person who prepared it.",
    };

    const result = await approveSettlementAction(
      {},
      form({ id: "set-1", reason: "Approving." }),
    );

    expect(result.error).toMatch(/person who prepared it/i);
    expect(result.ok).toBeUndefined();
    expect(store.revalidated).toHaveLength(0);
  });
});

describe("markSettlementPaidAction and cancelSettlementAction", () => {
  it("marks paid on payment.record, carrying the reference", async () => {
    const result = await markSettlementPaidAction(
      {},
      form({ id: "set-1", reference: "NEFT/8812" }),
    );

    expect(result.ok).toBe(true);
    expect(store.paid.at(0)).toEqual({ settlementId: "set-1", reference: "NEFT/8812" });
    expect(store.revalidated).toEqual(["/finance/settlements"]);
  });

  it("sends a null reference rather than an empty string", async () => {
    await markSettlementPaidAction({}, form({ id: "set-1" }));
    expect(store.paid.at(0)?.reference).toBeNull();
  });

  it("insists on a reason to cancel, and calls nothing without one", async () => {
    const result = await cancelSettlementAction({}, form({ id: "set-1", reason: " " }));

    expect(result.error).toMatch(/reason is required/i);
    expect(store.cancelled).toHaveLength(0);
  });
});

// ── refusals as the screen sees them ────────────────────────────────────

describe("a permission refusal", () => {
  /**
   * `guard()` maps a `PermissionError` to one sentence and everything else
   * to another. Getting that backwards would either publish an internal
   * stack message to a browser, or tell somebody their save failed when in
   * fact they were not allowed to try.
   */
  it.each([
    ["prepareSettlementAction", "settlement.prepare"],
    ["approveSettlementAction", "settlement.approve"],
    ["markSettlementPaidAction", "payment.record"],
    ["cancelSettlementAction", "settlement.approve"],
  ] as const)("%s answers a missing %s with a permission message", async (name, code) => {
    store.held.delete(code);

    const actions: Record<string, (p: object, f: FormData) => Promise<{ error?: string }>> = {
      prepareSettlementAction,
      approveSettlementAction,
      markSettlementPaidAction,
      cancelSettlementAction,
    };

    const result = await actions[name](
      {},
      form({ tripId: "trip-1", id: "set-1", reason: "Approving." }),
    );

    expect(result.error).toMatch(/do not have permission/i);
    expect(result.error).not.toContain(code);
    expect(store.prepared.length + store.approved.length + store.paid.length).toBe(0);
  });

  it("says nothing was saved, and leaks nothing, when the service throws", async () => {
    store.throwNext = new Error("connect ECONNREFUSED 10.0.0.7:5432");

    const result = await prepareSettlementAction({}, form({ tripId: "trip-1" }));

    expect(result.error).toMatch(/nothing was saved/i);
    expect(result.error).not.toContain("ECONNREFUSED");
    expect(result.error).not.toContain("10.0.0.7");
  });
});
