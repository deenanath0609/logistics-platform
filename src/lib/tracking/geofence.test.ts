import { describe, expect, it } from "vitest";
import { destinationPoint, type LatLng } from "./geo";
import {
  EMPTY_FENCE_STATE,
  evaluateFences,
  fencesContaining,
  isInsideFence,
  replayFences,
  type FenceDefinition,
  type FenceState,
} from "./geofence";

const HUB_CENTRE: LatLng = { lat: 28.4595, lng: 77.0266 };

function circle(
  id: string,
  overrides: Partial<FenceDefinition> = {},
): FenceDefinition {
  return {
    id,
    name: `Fence ${id}`,
    type: "CIRCLE",
    branchId: `branch-${id}`,
    centre: HUB_CENTRE,
    radiusMetres: 200,
    ring: null,
    debouncePings: 2,
    ...overrides,
  };
}

/** A point `metres` from the hub centre, due east. */
const at = (metres: number) => destinationPoint(HUB_CENTRE, 90, metres);

const INSIDE = at(50);
const OUTSIDE = at(1_000);

describe("isInsideFence", () => {
  it("tests a circle by radius", () => {
    const fence = circle("a");
    expect(isInsideFence(at(150), fence)).toBe(true);
    expect(isInsideFence(at(250), fence)).toBe(false);
  });

  it("tests a polygon by its ring", () => {
    const fence = circle("b", {
      type: "POLYGON",
      centre: null,
      radiusMetres: null,
      ring: [
        { lat: 28.45, lng: 77.02 },
        { lat: 28.45, lng: 77.04 },
        { lat: 28.47, lng: 77.04 },
        { lat: 28.47, lng: 77.02 },
      ],
    });
    expect(isInsideFence({ lat: 28.46, lng: 77.03 }, fence)).toBe(true);
    expect(isInsideFence({ lat: 28.48, lng: 77.03 }, fence)).toBe(false);
  });

  it("treats a fence with missing geometry as containing nothing", () => {
    // A half-configured fence must never swallow the whole fleet.
    expect(isInsideFence(INSIDE, circle("c", { centre: null }))).toBe(false);
    expect(isInsideFence(INSIDE, circle("d", { radiusMetres: null }))).toBe(false);
    expect(
      isInsideFence(INSIDE, circle("e", { type: "POLYGON", ring: null })),
    ).toBe(false);
  });
});

describe("fencesContaining", () => {
  it("returns every fence the point falls in, including overlaps", () => {
    const fences = [
      circle("small", { radiusMetres: 100 }),
      circle("large", { radiusMetres: 5_000 }),
      circle("elsewhere", { centre: { lat: 26.9, lng: 75.8 } }),
    ];
    expect(fencesContaining(at(50), fences).sort()).toEqual(["large", "small"]);
    expect(fencesContaining(at(1_000), fences)).toEqual(["large"]);
    expect(fencesContaining({ lat: 0, lng: 0 }, fences)).toEqual([]);
  });
});

describe("evaluateFences — debounce", () => {
  const fences = [circle("hub", { debouncePings: 3 })];

  it("does not fire on the first agreeing ping", () => {
    const result = evaluateFences({
      point: INSIDE,
      fences,
      state: EMPTY_FENCE_STATE,
    });

    expect(result.transitions).toEqual([]);
    expect(result.containing).toEqual(["hub"]);
    expect(result.state).toEqual({
      insideGeofenceIds: [],
      pendingFenceId: "hub",
      pendingCount: 1,
    });
  });

  it("fires once the threshold is reached, and not again", () => {
    const { transitions, state } = replayFences(
      [INSIDE, INSIDE, INSIDE, INSIDE, INSIDE, INSIDE],
      fences,
    );

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ geofenceId: "hub", direction: "ENTER" });
    expect(state.insideGeofenceIds).toEqual(["hub"]);
    expect(state.pendingFenceId).toBeNull();
    expect(state.pendingCount).toBe(0);
  });

  it("carries the branch through, because that is what raises the arrival", () => {
    const { transitions } = replayFences([INSIDE, INSIDE, INSIDE], fences);
    expect(transitions[0].branchId).toBe("branch-hub");
  });

  /**
   * The case the debounce exists for. A truck parked on the fence line with
   * ordinary GPS noise crosses it repeatedly; without the debounce this run
   * is twenty arrival events, twenty status changes on every consignment
   * aboard, and twenty customer messages.
   */
  it("produces nothing at all for a vehicle idling on the boundary", () => {
    const flapping: LatLng[] = [];
    for (let i = 0; i < 40; i++) {
      flapping.push(i % 2 === 0 ? at(195) : at(205));
    }

    const { transitions, state } = replayFences(flapping, fences);

    expect(transitions).toEqual([]);
    expect(state.insideGeofenceIds).toEqual([]);
  });

  it("still settles once the truck actually pulls in", () => {
    const flapping: LatLng[] = [];
    for (let i = 0; i < 20; i++) flapping.push(i % 2 === 0 ? at(195) : at(205));
    const arriving = [...flapping, at(60), at(55), at(50), at(45), at(40)];

    const { transitions } = replayFences(arriving, fences);

    expect(transitions).toHaveLength(1);
    expect(transitions[0].direction).toBe("ENTER");
  });

  it("resets a half-counted change when the vehicle steps back", () => {
    const first = evaluateFences({ point: INSIDE, fences, state: EMPTY_FENCE_STATE });
    expect(first.state.pendingCount).toBe(1);

    const stepBack = evaluateFences({ point: OUTSIDE, fences, state: first.state });
    expect(stepBack.state.pendingFenceId).toBeNull();
    expect(stepBack.state.pendingCount).toBe(0);

    // The count must not resume where it left off an hour later.
    const back = evaluateFences({ point: INSIDE, fences, state: stepBack.state });
    expect(back.state.pendingCount).toBe(1);
    expect(back.transitions).toEqual([]);
  });

  it("treats a threshold of one as fire immediately", () => {
    const eager = [circle("hub", { debouncePings: 1 })];
    const { transitions } = replayFences([INSIDE], eager);
    expect(transitions).toHaveLength(1);
  });

  it("refuses to treat zero or a negative threshold as never fire", () => {
    // A fence saved with a bad value must still work, not go silent.
    for (const debouncePings of [0, -3]) {
      const { transitions } = replayFences([INSIDE], [circle("hub", { debouncePings })]);
      expect(transitions).toHaveLength(1);
    }
  });

  it("debounces the exit as well as the entry", () => {
    const inside: FenceState = {
      insideGeofenceIds: ["hub"],
      pendingFenceId: null,
      pendingCount: 0,
    };

    const one = evaluateFences({ point: OUTSIDE, fences, state: inside });
    expect(one.transitions).toEqual([]);
    const two = evaluateFences({ point: OUTSIDE, fences, state: one.state });
    expect(two.transitions).toEqual([]);
    const three = evaluateFences({ point: OUTSIDE, fences, state: two.state });

    expect(three.transitions).toHaveLength(1);
    expect(three.transitions[0]).toMatchObject({ geofenceId: "hub", direction: "EXIT" });
    expect(three.state.insideGeofenceIds).toEqual([]);
  });

  it("never re-enters a fence it is already inside", () => {
    const inside: FenceState = {
      insideGeofenceIds: ["hub"],
      pendingFenceId: null,
      pendingCount: 0,
    };
    const { transitions, state } = replayFences(
      Array.from({ length: 50 }, () => INSIDE),
      fences,
      inside,
    );

    expect(transitions).toEqual([]);
    expect(state.insideGeofenceIds).toEqual(["hub"]);
  });
});

describe("evaluateFences — several fences", () => {
  const origin = circle("origin", {
    centre: { lat: 28.6139, lng: 77.209 },
    radiusMetres: 300,
    debouncePings: 2,
  });
  const destination = circle("destination", {
    centre: { lat: 26.9124, lng: 75.7873 },
    radiusMetres: 300,
    debouncePings: 2,
  });

  it("records the whole lane as one exit and one entry", () => {
    const fences = [origin, destination];
    const inOrigin = destinationPoint(origin.centre!, 45, 100);
    const enRoute = { lat: 27.9, lng: 76.5 };
    const inDestination = destinationPoint(destination.centre!, 45, 100);

    const start: FenceState = {
      insideGeofenceIds: ["origin"],
      pendingFenceId: null,
      pendingCount: 0,
    };

    const { transitions, state } = replayFences(
      [inOrigin, inOrigin, enRoute, enRoute, enRoute, inDestination, inDestination, inDestination],
      fences,
      start,
    );

    expect(transitions.map((t) => `${t.direction} ${t.geofenceId}`)).toEqual([
      "EXIT origin",
      "ENTER destination",
    ]);
    expect(state.insideGeofenceIds).toEqual(["destination"]);
  });

  it("prefers the exit when a vehicle leaves one fence and enters another at once", () => {
    // Two adjacent yards sharing a wall. Leaving must be recorded before
    // arriving, or the timeline reads back-to-front.
    const left = circle("left", { centre: { lat: 28.5, lng: 77.0 }, radiusMetres: 400 });
    const right = circle("right", { centre: { lat: 28.5, lng: 77.008 }, radiusMetres: 400 });
    // Just out of the left yard and just into the right one, so an exit and
    // an entry are both on the table from the same fix.
    const crossing = { lat: 28.5, lng: 77.0045 };
    expect(fencesContaining(crossing, [left, right])).toEqual(["right"]);

    const state: FenceState = {
      insideGeofenceIds: ["left"],
      pendingFenceId: null,
      pendingCount: 0,
    };

    const first = evaluateFences({ point: crossing, fences: [left, right], state });
    expect(first.state.pendingFenceId).toBe("left");
    const second = evaluateFences({ point: crossing, fences: [left, right], state: first.state });

    expect(second.transitions).toHaveLength(1);
    expect(second.transitions[0]).toMatchObject({ direction: "EXIT", geofenceId: "left" });
  });

  it("is deterministic when two entries are equally valid", () => {
    const a = circle("aaa", { radiusMetres: 500 });
    const b = circle("bbb", { radiusMetres: 500 });

    const forwards = replayFences([INSIDE, INSIDE], [a, b]);
    const backwards = replayFences([INSIDE, INSIDE], [b, a]);

    expect(forwards.transitions).toEqual(backwards.transitions);
    expect(forwards.transitions[0].geofenceId).toBe("aaa");
  });

  it("drops a fence that has been deactivated without inventing an exit", () => {
    // Withdrawing a rule is not the same as a vehicle leaving a place, and
    // an arrival reversed by an administrative change would be a lie.
    const state: FenceState = {
      insideGeofenceIds: ["retired", "live"],
      pendingFenceId: null,
      pendingCount: 0,
    };

    const result = evaluateFences({
      point: INSIDE,
      fences: [circle("live", { radiusMetres: 500 })],
      state,
    });

    expect(result.transitions).toEqual([]);
    expect(result.state.insideGeofenceIds).toEqual(["live"]);
  });

  it("does nothing when there are no fences at all", () => {
    const result = evaluateFences({ point: INSIDE, fences: [], state: EMPTY_FENCE_STATE });
    expect(result.transitions).toEqual([]);
    expect(result.containing).toEqual([]);
    expect(result.state).toEqual(EMPTY_FENCE_STATE);
  });
});
