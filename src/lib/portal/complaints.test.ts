import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The leak test.
 *
 * `ComplaintMessage.isInternal` defaults to true, so a note saved without
 * thinking about it is private. The whole protection is that the read side
 * never forgets the filter — which is not something a type can enforce, so
 * it is asserted here instead.
 *
 * Prisma is replaced with an in-memory store that *honestly applies the
 * where clause it is given*, rather than a stub that returns a fixed list.
 * That distinction is the entire value of the test: a stub would keep
 * passing if somebody deleted `CUSTOMER_VISIBLE` from the query, and this
 * store will not. Delete the filter and the internal note appears in the
 * thread, exactly as it would in production.
 */

type MessageRow = {
  id: string;
  complaintId: string;
  body: string;
  createdAt: Date;
  authorUserId: string | null;
  authorCustomerUserId: string | null;
  isInternal: boolean;
};

type ComplaintRow = {
  id: string;
  customerId: string | null;
  number: string;
  category: string;
  status: string;
  subject: string;
  description: string;
  resolution: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  firstResponseAt: Date | null;
  shipmentId: string | null;
};

const store = vi.hoisted(() => ({
  complaints: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  customerUsers: [] as Array<Record<string, unknown>>,
}));

/**
 * `src/lib/complaints/service.ts` reaches the staff permission matrix and
 * the audit log on its write paths. Neither is on the read path this file
 * exercises, and both drag Auth.js — and with it `next/server` — into a
 * plain node test. Stubbed so the module under test can be imported.
 */
vi.mock("@/lib/auth/session", () => ({
  can: () => false,
  canAny: () => false,
}));
vi.mock("@/server/services/audit", () => ({
  recordAudit: async () => undefined,
}));

vi.mock("@/lib/prisma", () => {
  /**
   * A tiny, literal `where` matcher: scalar equality plus `{ in: [...] }`.
   * Anything it does not understand throws, so a query that grows a new
   * clause fails loudly here instead of being silently ignored — a matcher
   * that quietly returns everything is how a scoping test stops testing.
   */
  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, condition] of Object.entries(where)) {
      const value = row[key];

      if (condition === null || typeof condition !== "object") {
        if (value !== condition) return false;
        continue;
      }

      const clause = condition as Record<string, unknown>;
      if (Array.isArray(clause.in)) {
        if (!clause.in.includes(value)) return false;
        continue;
      }

      throw new Error(`unsupported where clause on ${key}: ${JSON.stringify(clause)}`);
    }
    return true;
  }

  /**
   * `select` is applied for real, and that is not a detail.
   *
   * `customerVisibleMessages` does not select `isInternal`, so in
   * production a row reaching the projection has no flag on it to check.
   * A mock that returned whole rows would hand the projection a flag it
   * never sees for real, the second guard would catch a leak the first one
   * let through, and the test would pass with the filter deleted. This one
   * reproduces the real shape instead.
   */
  function project(
    row: Record<string, unknown>,
    select?: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!select) return { ...row };
    const out: Record<string, unknown> = {};
    for (const [key, wanted] of Object.entries(select)) {
      if (wanted) out[key] = row[key] ?? null;
    }
    return out;
  }

  type Args = { where?: Record<string, unknown>; select?: Record<string, unknown> };

  function findMany(rows: Array<Record<string, unknown>>) {
    return async (args: Args = {}) =>
      rows
        .filter((row) => matches(row, args.where ?? {}))
        .map((row) => project(row, args.select));
  }

  return {
    prisma: {
      complaint: {
        findFirst: async (args: Args = {}) => {
          const row = store.complaints.find((r) => matches(r, args.where ?? {}));
          return row ? project(row, args.select) : null;
        },
        findMany: findMany(store.complaints),
      },
      complaintMessage: {
        findMany: findMany(store.messages),
      },
      customerUser: {
        findMany: findMany(store.customerUsers),
      },
    },
  };
});

import type { CustomerSession } from "@/lib/auth/customer-session";
import {
  getPortalComplaint,
  toPortalThread,
  priorityForCategory,
  isPortalCategory,
  PORTAL_COMPLAINT_CATEGORIES,
  type InternalMessageLike,
} from "./complaints";

const ACME: CustomerSession = {
  id: "cu_arun",
  name: "Arun Mehta",
  email: "arun@acme.test",
  role: "OWNER",
  mustChangePassword: false,
  customerId: "cust_acme",
  customerCode: "ACME",
  customerName: "Acme Industries",
  orgId: "org_1",
  visibleBranchIds: [],
};

const RIVAL: CustomerSession = {
  ...ACME,
  id: "cu_priya",
  name: "Priya Rao",
  email: "priya@rival.test",
  customerId: "cust_rival",
  customerCode: "RIVAL",
  customerName: "Rival Freight",
};

function complaint(overrides: Partial<ComplaintRow> = {}): ComplaintRow {
  return {
    id: "cmp_1",
    customerId: "cust_acme",
    number: "CMP/2627/0001",
    category: "DAMAGE",
    status: "INVESTIGATING",
    subject: "Two cartons crushed",
    description: "Both outer cartons arrived crushed and taped over.",
    resolution: null,
    createdAt: new Date("2026-08-20T09:00:00Z"),
    resolvedAt: null,
    firstResponseAt: new Date("2026-08-20T10:30:00Z"),
    shipmentId: null,
    ...overrides,
  };
}

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg_1",
    complaintId: "cmp_1",
    body: "Thank you for reporting this. We are checking with the hub.",
    createdAt: new Date("2026-08-20T10:30:00Z"),
    authorUserId: "user_desk",
    authorCustomerUserId: null,
    isInternal: false,
    ...overrides,
  };
}

/** The line nobody outside the building may ever read. */
const INTERNAL_NOTE =
  "Handler at Jaipur has form for this. Do not admit liability, settle at 40% and move on.";

beforeEach(() => {
  store.complaints.length = 0;
  store.messages.length = 0;
  store.customerUsers.length = 0;
});

// ────────────────────────────────────────────────────────────
// The leak
// ────────────────────────────────────────────────────────────

describe("getPortalComplaint — internal notes", () => {
  beforeEach(() => {
    store.complaints.push(complaint());
    store.customerUsers.push({
      id: "cu_arun",
      customerId: "cust_acme",
      name: "Arun Mehta",
    });

    store.messages.push(
      message({
        id: "m_customer",
        body: "Two of the four cartons arrived crushed.",
        createdAt: new Date("2026-08-20T09:05:00Z"),
        authorUserId: null,
        authorCustomerUserId: "cu_arun",
        isInternal: false,
      }),
      message({
        id: "m_internal",
        body: INTERNAL_NOTE,
        createdAt: new Date("2026-08-20T09:40:00Z"),
        isInternal: true,
      }),
      message({
        id: "m_reply",
        body: "We have opened an investigation with the destination hub.",
        createdAt: new Date("2026-08-20T10:30:00Z"),
        isInternal: false,
      }),
    );
  });

  it("never puts an internal note in a portal thread", async () => {
    const detail = await getPortalComplaint(ACME, "cmp_1");

    expect(detail).not.toBeNull();
    expect(detail!.messages.map((m) => m.id)).toEqual(["m_customer", "m_reply"]);

    // Not just absent from the list — absent from the payload entirely.
    expect(JSON.stringify(detail)).not.toContain(INTERNAL_NOTE);
    expect(JSON.stringify(detail)).not.toContain("40%");
  });

  it("counts only what the customer can see", async () => {
    const detail = await getPortalComplaint(ACME, "cmp_1");
    expect(detail!.messageCount).toBe(2);
  });

  it("attributes the thread without naming staff", async () => {
    const detail = await getPortalComplaint(ACME, "cmp_1");

    const [mine, theirs] = detail!.messages;
    expect(mine.author).toBe("you");
    expect(mine.authorName).toBe("Arun Mehta");
    expect(theirs.author).toBe("team");
    expect(theirs.authorName).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// Account scoping
// ────────────────────────────────────────────────────────────

describe("getPortalComplaint — scoping", () => {
  it("cannot reach another account's complaint by id", async () => {
    store.complaints.push(complaint({ id: "cmp_1", customerId: "cust_acme" }));
    store.messages.push(message());

    expect(await getPortalComplaint(RIVAL, "cmp_1")).toBeNull();
    expect(await getPortalComplaint(ACME, "cmp_1")).not.toBeNull();
  });

  it("refuses to build a filter for a session with no account", async () => {
    store.complaints.push(complaint());

    await expect(
      getPortalComplaint({ ...ACME, customerId: "" }, "cmp_1"),
    ).rejects.toThrow();
  });

  it("does not name a colleague from another account", async () => {
    store.complaints.push(complaint());
    // Same id shape, different account — the name lookup is scoped too, so
    // this resolves to nothing rather than to a stranger's name.
    store.customerUsers.push({
      id: "cu_outsider",
      customerId: "cust_rival",
      name: "Someone Else",
    });
    store.messages.push(
      message({
        id: "m_outsider",
        authorUserId: null,
        authorCustomerUserId: "cu_outsider",
        isInternal: false,
      }),
    );

    const detail = await getPortalComplaint(ACME, "cmp_1");
    expect(detail!.messages[0].author).toBe("colleague");
    expect(detail!.messages[0].authorName).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("Someone Else");
  });
});

// ────────────────────────────────────────────────────────────
// The projection on its own
// ────────────────────────────────────────────────────────────

describe("toPortalThread", () => {
  const context = {
    viewerId: "cu_arun",
    colleagueNames: new Map([
      ["cu_arun", "Arun Mehta"],
      ["cu_sana", "Sana Iyer"],
    ]),
  };

  function raw(overrides: Partial<InternalMessageLike> = {}): InternalMessageLike {
    return {
      id: "m",
      body: "text",
      createdAt: new Date("2026-08-20T09:00:00Z"),
      authorUserId: "user_desk",
      authorCustomerUserId: null,
      ...overrides,
    };
  }

  it("drops a row that arrives still flagged internal", () => {
    // The second guard. Even handed a raw row straight out of Prisma —
    // which is what a future caller will eventually do — the note does not
    // come out the other side.
    const thread = toPortalThread(
      [raw({ id: "safe" }), raw({ id: "leak", body: INTERNAL_NOTE, isInternal: true })],
      context,
    );

    expect(thread.map((m) => m.id)).toEqual(["safe"]);
  });

  it("keeps a row that says it is not internal", () => {
    const thread = toPortalThread([raw({ id: "ok", isInternal: false })], context);
    expect(thread.map((m) => m.id)).toEqual(["ok"]);
  });

  it("drops a message nobody wrote", () => {
    const thread = toPortalThread(
      [raw({ id: "orphan", authorUserId: null, authorCustomerUserId: null })],
      context,
    );
    expect(thread).toHaveLength(0);
  });

  it("tells a colleague apart from the viewer", () => {
    const thread = toPortalThread(
      [
        raw({ id: "mine", authorUserId: null, authorCustomerUserId: "cu_arun" }),
        raw({ id: "hers", authorUserId: null, authorCustomerUserId: "cu_sana" }),
      ],
      context,
    );

    expect(thread.map((m) => [m.author, m.authorName])).toEqual([
      ["you", "Arun Mehta"],
      ["colleague", "Sana Iyer"],
    ]);
  });

  it("carries nothing but the four declared keys", () => {
    const thread = toPortalThread(
      [
        raw({
          id: "m",
          isInternal: false,
          // Everything an internal row might drag along.
          attachmentId: "asset_1",
          complaintId: "cmp_1",
          authorUser: { name: "Desk Agent", mobile: "9876543210" },
        }),
      ],
      context,
    );

    expect(Object.keys(thread[0]).sort()).toEqual([
      "at",
      "author",
      "authorName",
      "body",
      "id",
    ]);
    expect(JSON.stringify(thread)).not.toContain("9876543210");
    expect(JSON.stringify(thread)).not.toContain("Desk Agent");
  });

  it("orders oldest first, whatever order it was handed", () => {
    const thread = toPortalThread(
      [
        raw({ id: "late", createdAt: new Date("2026-08-21T09:00:00Z") }),
        raw({ id: "early", createdAt: new Date("2026-08-20T09:00:00Z") }),
      ],
      context,
    );

    expect(thread.map((m) => m.id)).toEqual(["early", "late"]);
  });
});

// ────────────────────────────────────────────────────────────
// Categories and priority
// ────────────────────────────────────────────────────────────

describe("categories", () => {
  it("offers exactly the nine the BRD names", () => {
    expect(PORTAL_COMPLAINT_CATEGORIES.map((c) => c.value)).toEqual([
      "DELAY",
      "DAMAGE",
      "MISSING",
      "WRONG_DELIVERY",
      "BILLING",
      "POD_ISSUE",
      "PICKUP_ISSUE",
      "BEHAVIOUR",
      "OTHER",
    ]);
  });

  it("refuses a category that is not on the list", () => {
    expect(isPortalCategory("DELAY")).toBe(true);
    expect(isPortalCategory("URGENT")).toBe(false);
    expect(isPortalCategory("")).toBe(false);
  });

  it("never lets a customer self-select CRITICAL", () => {
    for (const option of PORTAL_COMPLAINT_CATEGORIES) {
      expect(priorityForCategory(option.value)).not.toBe("CRITICAL");
    }
    expect(priorityForCategory("MISSING")).toBe("HIGH");
    expect(priorityForCategory("BILLING")).toBe("NORMAL");
  });
});
