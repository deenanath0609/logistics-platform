import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may type an arrival.
 *
 * `recordMovement` writes a `ShipmentEvent` against every consignment on
 * the trip — the carrier's own custody evidence, and the thing that fires
 * the customer's "arrived at Delhi hub" message. It used to ask for
 * `tracking.read`, which `allReads` grants to MANAGEMENT ("read-only
 * visibility of the whole network") and CUSTOMER_SUPPORT, and it asked for
 * no branch at all: a trip id and a branch id were the entire input, and
 * any pair of them worked.
 *
 * Tested at the service rather than at the server action, because the
 * action is one of several ways in and the guarantee has to hold for the
 * function itself.
 */

const store = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  tripEvents: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

// The real module reaches for next-auth, which has no business being
// loaded to answer "is this code in that set". The semantics are the same.
vi.mock("@/lib/auth/session", () => ({
  can: (actor: { permissions: ReadonlySet<string> }, permission: string) =>
    actor.permissions.has(permission),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    trip: {
      findUnique: async () => ({
        id: "trip-1",
        number: "TR/2627/000014",
        status: "IN_TRANSIT",
        vehicleId: "veh-1",
        originBranchId: "br-jai",
        vehicle: { registrationNumber: "RJ14GA1234" },
      }),
    },
    branch: {
      findUnique: async () => ({ id: "br-del", code: "DEL", name: "Delhi" }),
    },
    tripEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        store.tripEvents.push(args.data);
        return {};
      },
    },
  },
}));

vi.mock("@/lib/shipment/events", () => ({
  appendShipmentEvent: async (input: Record<string, unknown>) => {
    store.events.push(input);
    return {
      ok: true,
      eventId: `evt-${store.events.length}`,
      previousStatus: "IN_TRANSIT",
      currentStatus: "ARRIVED_AT_HUB",
      statusChanged: true,
      duplicate: false,
    };
  },
}));

vi.mock("@/server/services/audit", () => ({
  recordAudit: async (input: Record<string, unknown>) => {
    store.audits.push(input);
  },
}));

vi.mock("./context", () => ({
  shipmentsOnTrip: async () => [
    { id: "shp-1", lrNumber: "CL/2627/JAI/000001", manifestId: "man-1" },
    { id: "shp-2", lrNumber: "CL/2627/JAI/000002", manifestId: "man-1" },
  ],
  loadBranchPoints: async () => [],
  activeTripForVehicle: async () => null,
}));

const { recordManualArrival, MANUAL_MOVEMENT_PERMISSION } = await import("./manual");

type Actor = Parameters<typeof recordManualArrival>[1];

function user(
  permissions: string[],
  branchIds: string[] | null,
  scope: Actor["scope"] = "BRANCH",
): Actor {
  return {
    id: "usr-1",
    orgId: "org-1",
    name: "Someone",
    mobile: "9000000000",
    email: null,
    isFieldUser: false,
    mustChangePassword: false,
    primaryBranch: branchIds?.[0]
      ? { id: branchIds[0], code: "X", name: "X" }
      : null,
    roles: [],
    permissions: new Set(permissions),
    scope,
    branchIds,
  };
}

const AT_DELHI = { tripId: "trip-1", branchId: "br-del" };

beforeEach(() => {
  store.events = [];
  store.tripEvents = [];
  store.audits = [];
});

describe("a manual arrival is a write, and is gated as one", () => {
  it("is not something the tracking read buys", () => {
    expect(MANUAL_MOVEMENT_PERMISSION).not.toBe("tracking.read");
  });

  it("refuses the read-only network account that used to be able to post it", async () => {
    // MANAGEMENT's shape: every plain read, network-wide, and nothing else.
    const management = user(
      ["tracking.read", "shipment.read", "trip.read", "report.management"],
      null,
      "NETWORK",
    );

    const result = await recordManualArrival(AT_DELHI, management);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/permission/i);
    // Nothing reached the timeline, the trip log or the audit trail.
    expect(store.events).toHaveLength(0);
    expect(store.tripEvents).toHaveLength(0);
  });

  it("lets a dispatcher at that branch record it", async () => {
    const dispatcher = user(["trip.dispatch"], ["br-del"]);

    const result = await recordManualArrival(AT_DELHI, dispatcher);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.moved).toBe(2);
    expect(store.events).toHaveLength(2);
    // Still the same event the fence would have written, differing in source.
    expect(store.events[0]).toMatchObject({
      eventType: "GEOFENCE_ENTER",
      source: "WEB",
    });
  });
});

describe("a manual arrival is scoped to branches the actor covers", () => {
  it("refuses a branch manager posting an arrival at somebody else's branch", async () => {
    const jaipur = user(["trip.dispatch"], ["br-jai"]);

    const result = await recordManualArrival(AT_DELHI, jaipur);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/branches you cover/i);
    expect(store.events).toHaveLength(0);
  });

  it("leaves a network-scoped operations manager alone", async () => {
    const ops = user(["trip.dispatch"], null, "NETWORK");

    const result = await recordManualArrival(AT_DELHI, ops);

    expect(result.ok).toBe(true);
    expect(store.events).toHaveLength(2);
  });
});
