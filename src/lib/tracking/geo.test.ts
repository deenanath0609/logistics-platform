import { describe, expect, it } from "vitest";
import {
  EARTH_RADIUS_M,
  bearingDegrees,
  decodePolyline,
  destinationPoint,
  distanceToPolyline,
  encodePolyline,
  fitProjection,
  haversineMetres,
  isInsideCircle,
  isInsidePolygon,
  normaliseLngDelta,
  parseGeoJsonRing,
  pointAlongPolyline,
  polylineLengthMetres,
  projectOntoPolyline,
  type LatLng,
} from "./geo";

const DELHI: LatLng = { lat: 28.6139, lng: 77.209 };
const JAIPUR: LatLng = { lat: 26.9124, lng: 75.7873 };

/** One degree of latitude, anywhere: the yardstick most tests here use. */
const DEGREE_M = (Math.PI / 180) * EARTH_RADIUS_M;

describe("haversineMetres", () => {
  it("measures Delhi to Jaipur at the published great-circle distance", () => {
    const metres = haversineMetres(DELHI, JAIPUR);
    // ~235.3 km straight line. The road is nearer 280 km, and confusing the
    // two is how an ETA ends up an hour optimistic.
    expect(metres).toBeGreaterThan(234_000);
    expect(metres).toBeLessThan(237_000);
  });

  it("is symmetric", () => {
    expect(haversineMetres(DELHI, JAIPUR)).toBeCloseTo(
      haversineMetres(JAIPUR, DELHI),
      6,
    );
  });

  it("is zero for a point against itself", () => {
    expect(haversineMetres(DELHI, DELHI)).toBe(0);
  });

  it("measures one degree of latitude as ~111.2 km at any longitude", () => {
    expect(haversineMetres({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(
      DEGREE_M,
      3,
    );
    expect(
      haversineMetres({ lat: 0, lng: 173 }, { lat: 1, lng: 173 }),
    ).toBeCloseTo(DEGREE_M, 3);
  });

  it("measures one degree of longitude on the equator as ~111.2 km", () => {
    expect(haversineMetres({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(
      DEGREE_M,
      3,
    );
  });

  it("shrinks a degree of longitude by cos(latitude) away from the equator", () => {
    const atSixty = haversineMetres({ lat: 60, lng: 0 }, { lat: 60, lng: 1 });
    // cos 60° is exactly a half, which makes this a test with a known answer
    // rather than a snapshot of whatever the code happens to return.
    expect(atSixty / DEGREE_M).toBeCloseTo(0.5, 3);
  });

  it("treats a hop across the antimeridian as short, not as a lap of the planet", () => {
    const metres = haversineMetres(
      { lat: 0, lng: 179.5 },
      { lat: 0, lng: -179.5 },
    );
    expect(metres).toBeCloseTo(DEGREE_M, 3);
  });

  it("returns NaN rather than a plausible number for a missing coordinate", () => {
    expect(
      haversineMetres(DELHI, { lat: Number.NaN, lng: 0 }),
    ).toBeNaN();
  });
});

describe("normaliseLngDelta", () => {
  it("folds differences into (-180, 180]", () => {
    expect(normaliseLngDelta(0)).toBe(0);
    expect(normaliseLngDelta(359)).toBe(-1);
    expect(normaliseLngDelta(-359)).toBe(1);
    expect(normaliseLngDelta(180)).toBe(180);
    expect(normaliseLngDelta(-180)).toBe(180);
    expect(normaliseLngDelta(720.5)).toBeCloseTo(0.5, 9);
  });
});

describe("isInsideCircle", () => {
  const centre: LatLng = { lat: 28.5, lng: 77.1 };

  it("accepts a point well inside", () => {
    const near = destinationPoint(centre, 90, 100);
    expect(isInsideCircle(near, centre, 200)).toBe(true);
  });

  it("rejects a point well outside", () => {
    const far = destinationPoint(centre, 90, 5_000);
    expect(isInsideCircle(far, centre, 200)).toBe(false);
  });

  it("counts a point exactly on the boundary as inside", () => {
    const radius = 250;
    const onEdge = destinationPoint(centre, 33, radius);
    const measured = haversineMetres(onEdge, centre);
    // Confirm the fixture really does sit on the line before asserting on it.
    expect(measured).toBeCloseTo(radius, 6);
    expect(isInsideCircle(onEdge, centre, measured)).toBe(true);
  });

  it("rejects a point a millimetre outside the boundary", () => {
    const radius = 250;
    const onEdge = destinationPoint(centre, 33, radius);
    expect(isInsideCircle(onEdge, centre, radius - 0.001)).toBe(false);
  });

  it("works across the antimeridian", () => {
    const pacific: LatLng = { lat: 0, lng: 179.999 };
    const justOver: LatLng = { lat: 0, lng: -179.999 };
    // Roughly 222 m apart, not 40,000 km.
    expect(isInsideCircle(justOver, pacific, 300)).toBe(true);
    expect(isInsideCircle(justOver, pacific, 100)).toBe(false);
  });

  it("refuses a negative or non-finite radius rather than guessing", () => {
    expect(isInsideCircle(centre, centre, -1)).toBe(false);
    expect(isInsideCircle(centre, centre, Number.NaN)).toBe(false);
  });
});

describe("isInsidePolygon", () => {
  /**
   * A horseshoe opening north. The notch — longitude 1–2, latitude 1–3 —
   * sits squarely inside the bounding box and squarely outside the shape,
   * which is the case a bounding-box approximation gets wrong and a
   * delivery zone drawn around a river or a railway line looks exactly like.
   */
  const HORSESHOE: LatLng[] = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 3 },
    { lat: 3, lng: 3 },
    { lat: 3, lng: 2 },
    { lat: 1, lng: 2 },
    { lat: 1, lng: 1 },
    { lat: 3, lng: 1 },
    { lat: 3, lng: 0 },
  ];

  it("puts a point in the notch outside, where a bounding box would say inside", () => {
    const inNotch: LatLng = { lat: 2, lng: 1.5 };
    // The bounding box does contain it — that is the whole point of the case.
    expect(inNotch.lat).toBeGreaterThan(0);
    expect(inNotch.lat).toBeLessThan(3);
    expect(inNotch.lng).toBeGreaterThan(0);
    expect(inNotch.lng).toBeLessThan(3);

    expect(isInsidePolygon(inNotch, HORSESHOE)).toBe(false);
  });

  it("puts points in both arms and the base inside", () => {
    expect(isInsidePolygon({ lat: 2, lng: 0.5 }, HORSESHOE)).toBe(true);
    expect(isInsidePolygon({ lat: 2, lng: 2.5 }, HORSESHOE)).toBe(true);
    expect(isInsidePolygon({ lat: 0.5, lng: 1.5 }, HORSESHOE)).toBe(true);
  });

  it("puts points outside the shape outside", () => {
    expect(isInsidePolygon({ lat: -0.5, lng: 1.5 }, HORSESHOE)).toBe(false);
    expect(isInsidePolygon({ lat: 1.5, lng: 4 }, HORSESHOE)).toBe(false);
    expect(isInsidePolygon({ lat: 3.5, lng: 1.5 }, HORSESHOE)).toBe(false);
  });

  it("counts a point sitting exactly on a vertex as inside", () => {
    for (const vertex of HORSESHOE) {
      expect(isInsidePolygon({ ...vertex }, HORSESHOE)).toBe(true);
    }
  });

  it("counts a point sitting on an edge as inside", () => {
    expect(isInsidePolygon({ lat: 0, lng: 1.5 }, HORSESHOE)).toBe(true);
    expect(isInsidePolygon({ lat: 1, lng: 1.5 }, HORSESHOE)).toBe(true);
    expect(isInsidePolygon({ lat: 1.5, lng: 0 }, HORSESHOE)).toBe(true);
  });

  it("gives the same answer whether the ring is left open or explicitly closed", () => {
    const closed = [...HORSESHOE, { ...HORSESHOE[0] }];
    for (const probe of [
      { lat: 2, lng: 1.5 },
      { lat: 2, lng: 0.5 },
      { lat: 0.5, lng: 1.5 },
      { lat: 5, lng: 5 },
    ]) {
      expect(isInsidePolygon(probe, closed)).toBe(isInsidePolygon(probe, HORSESHOE));
    }
  });

  it("is unaffected by winding order", () => {
    const reversed = [...HORSESHOE].reverse();
    expect(isInsidePolygon({ lat: 2, lng: 0.5 }, reversed)).toBe(true);
    expect(isInsidePolygon({ lat: 2, lng: 1.5 }, reversed)).toBe(false);
  });

  it("handles a fence straddling the antimeridian", () => {
    const straddling: LatLng[] = [
      { lat: -1, lng: 179 },
      { lat: -1, lng: -179 },
      { lat: 1, lng: -179 },
      { lat: 1, lng: 179 },
    ];

    expect(isInsidePolygon({ lat: 0, lng: 180 }, straddling)).toBe(true);
    expect(isInsidePolygon({ lat: 0, lng: -180 }, straddling)).toBe(true);
    expect(isInsidePolygon({ lat: 0, lng: 179.5 }, straddling)).toBe(true);
    expect(isInsidePolygon({ lat: 0, lng: -179.5 }, straddling)).toBe(true);

    expect(isInsidePolygon({ lat: 0, lng: 178 }, straddling)).toBe(false);
    expect(isInsidePolygon({ lat: 0, lng: -178 }, straddling)).toBe(false);
    // The far side of the planet must not fall inside a fence in the Pacific.
    expect(isInsidePolygon({ lat: 0, lng: 0 }, straddling)).toBe(false);
    expect(isInsidePolygon(DELHI, straddling)).toBe(false);
  });

  it("handles a fence sitting on the equator", () => {
    const equatorial: LatLng[] = [
      { lat: -1, lng: -1 },
      { lat: -1, lng: 1 },
      { lat: 1, lng: 1 },
      { lat: 1, lng: -1 },
    ];
    expect(isInsidePolygon({ lat: 0, lng: 0 }, equatorial)).toBe(true);
    expect(isInsidePolygon({ lat: 0, lng: -1 }, equatorial)).toBe(true);
    expect(isInsidePolygon({ lat: 1.0001, lng: 0 }, equatorial)).toBe(false);
  });

  it("refuses a degenerate ring instead of returning an arbitrary answer", () => {
    expect(isInsidePolygon({ lat: 0, lng: 0 }, [])).toBe(false);
    expect(
      isInsidePolygon({ lat: 0, lng: 0 }, [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ]),
    ).toBe(false);
  });
});

describe("parseGeoJsonRing", () => {
  const ring = [
    [77.0, 28.0],
    [77.1, 28.0],
    [77.1, 28.1],
    [77.0, 28.1],
    [77.0, 28.0],
  ];

  it("reads a Polygon geometry and puts latitude in the latitude field", () => {
    const parsed = parseGeoJsonRing({ type: "Polygon", coordinates: [ring] });
    expect(parsed).not.toBeNull();
    // GeoJSON is [lng, lat]; getting this backwards puts the truck at sea.
    expect(parsed![0]).toEqual({ lat: 28.0, lng: 77.0 });
    expect(parsed).toHaveLength(5);
  });

  it("reads a Feature wrapping a Polygon", () => {
    const parsed = parseGeoJsonRing({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [ring] },
    });
    expect(parsed?.[2]).toEqual({ lat: 28.1, lng: 77.1 });
  });

  it("reads a bare coordinates array", () => {
    expect(parseGeoJsonRing([ring])?.[0]).toEqual({ lat: 28.0, lng: 77.0 });
    expect(parseGeoJsonRing(ring)?.[0]).toEqual({ lat: 28.0, lng: 77.0 });
  });

  it("reads an already-decoded lat/lng list", () => {
    const decoded = [
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
      { lat: 5, lng: 6 },
    ];
    expect(parseGeoJsonRing(decoded)).toEqual(decoded);
  });

  it("returns null for anything it cannot make sense of", () => {
    expect(parseGeoJsonRing(null)).toBeNull();
    expect(parseGeoJsonRing({})).toBeNull();
    expect(parseGeoJsonRing([])).toBeNull();
    expect(parseGeoJsonRing([[77, 28]])).toBeNull();
    expect(parseGeoJsonRing("POLYGON((0 0))")).toBeNull();
  });
});

describe("polylines", () => {
  const LANE: LatLng[] = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 1, lng: 1 },
  ];

  it("measures total length as the sum of its legs", () => {
    expect(polylineLengthMetres(LANE)).toBeCloseTo(DEGREE_M * 2, 0);
    expect(polylineLengthMetres([])).toBe(0);
    expect(polylineLengthMetres([{ lat: 5, lng: 5 }])).toBe(0);
  });

  it("returns null for an empty polyline rather than zero or infinity", () => {
    // Zero would read as "perfectly on route" and Infinity as "wildly off";
    // both are lies when there is simply no planned route to compare against.
    expect(distanceToPolyline({ lat: 1, lng: 1 }, [])).toBeNull();
    expect(projectOntoPolyline({ lat: 1, lng: 1 }, [])).toBeNull();
  });

  it("measures against a single-point polyline as a distance to that point", () => {
    const projection = projectOntoPolyline({ lat: 0, lng: 1 }, [{ lat: 0, lng: 0 }]);
    expect(projection?.distanceMetres).toBeCloseTo(DEGREE_M, 0);
    expect(projection?.alongMetres).toBe(0);
  });

  it("snaps a point beside the route to the perpendicular foot", () => {
    const projection = projectOntoPolyline({ lat: 0.01, lng: 0.5 }, LANE);
    expect(projection).not.toBeNull();
    expect(projection!.segmentIndex).toBe(0);
    expect(projection!.t).toBeCloseTo(0.5, 3);
    expect(projection!.snapped.lat).toBeCloseTo(0, 6);
    expect(projection!.snapped.lng).toBeCloseTo(0.5, 6);
    expect(projection!.distanceMetres).toBeCloseTo(DEGREE_M * 0.01, 0);
    expect(projection!.alongMetres).toBeCloseTo(DEGREE_M * 0.5, 0);
  });

  it("clamps a point beyond the end of a segment to the vertex", () => {
    const projection = projectOntoPolyline({ lat: 2, lng: 1 }, LANE);
    expect(projection!.segmentIndex).toBe(1);
    expect(projection!.t).toBe(1);
    expect(projection!.alongMetres).toBeCloseTo(DEGREE_M * 2, 0);
  });

  it("reports zero distance for a point exactly on the route", () => {
    expect(distanceToPolyline({ lat: 0, lng: 0.25 }, LANE)).toBeCloseTo(0, 6);
  });

  it("survives a duplicated vertex", () => {
    const doubled: LatLng[] = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    ];
    expect(distanceToPolyline({ lat: 0, lng: 0.5 }, doubled)).toBeCloseTo(0, 6);
  });

  it("walks a given distance along the route and clamps at both ends", () => {
    expect(pointAlongPolyline(LANE, -50)).toEqual(LANE[0]);
    expect(pointAlongPolyline(LANE, 0)).toEqual(LANE[0]);
    expect(pointAlongPolyline(LANE, DEGREE_M * 10)).toEqual(LANE[2]);
    expect(pointAlongPolyline([], 10)).toBeNull();

    const half = pointAlongPolyline(LANE, DEGREE_M * 0.5)!;
    expect(half.lat).toBeCloseTo(0, 6);
    expect(half.lng).toBeCloseTo(0.5, 4);
  });
});

describe("encodePolyline / decodePolyline", () => {
  it("decodes the example from Google's specification", () => {
    // The canonical fixture: (38.5,-120.2) (40.7,-120.95) (43.252,-126.453).
    const decoded = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(decoded).toHaveLength(3);
    expect(decoded[0].lat).toBeCloseTo(38.5, 5);
    expect(decoded[0].lng).toBeCloseTo(-120.2, 5);
    expect(decoded[1].lat).toBeCloseTo(40.7, 5);
    expect(decoded[1].lng).toBeCloseTo(-120.95, 5);
    expect(decoded[2].lat).toBeCloseTo(43.252, 5);
    expect(decoded[2].lng).toBeCloseTo(-126.453, 5);
  });

  it("encodes that example back to the same string", () => {
    const points: LatLng[] = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    expect(encodePolyline(points)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  });

  it("round-trips a real lane to within a metre", () => {
    const lane: LatLng[] = [DELHI, { lat: 27.8, lng: 76.6 }, JAIPUR];
    const decoded = decodePolyline(encodePolyline(lane));
    expect(decoded).toHaveLength(3);
    decoded.forEach((point, index) => {
      expect(haversineMetres(point, lane[index])).toBeLessThan(1);
    });
  });

  it("round-trips at precision 6", () => {
    const lane: LatLng[] = [DELHI, JAIPUR];
    const decoded = decodePolyline(encodePolyline(lane, 6), 6);
    expect(decoded[1].lat).toBeCloseTo(JAIPUR.lat, 6);
    expect(decoded[1].lng).toBeCloseTo(JAIPUR.lng, 6);
  });

  it("handles empty and absent input without throwing", () => {
    expect(decodePolyline("")).toEqual([]);
    expect(decodePolyline(null)).toEqual([]);
    expect(decodePolyline(undefined)).toEqual([]);
    expect(encodePolyline([])).toBe("");
  });

  it("stops cleanly on a truncated string rather than emitting a bogus point", () => {
    const full = encodePolyline([DELHI, JAIPUR]);
    const truncated = full.slice(0, full.length - 2);
    expect(decodePolyline(truncated).length).toBeLessThanOrEqual(1);
  });

  it("survives negative and zero coordinates", () => {
    const points: LatLng[] = [
      { lat: 0, lng: 0 },
      { lat: -33.8688, lng: 151.2093 },
      { lat: -0.0001, lng: -0.0001 },
    ];
    const decoded = decodePolyline(encodePolyline(points));
    decoded.forEach((point, index) => {
      expect(point.lat).toBeCloseTo(points[index].lat, 5);
      expect(point.lng).toBeCloseTo(points[index].lng, 5);
    });
  });
});

describe("bearingDegrees and destinationPoint", () => {
  /** Smallest signed angle between two compass bearings. */
  const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

  it("reads due north, east, south and west", () => {
    const here: LatLng = { lat: 20, lng: 77 };
    expect(bearingDegrees(here, { lat: 20.01, lng: 77 })).toBeCloseTo(0, 3);
    expect(bearingDegrees(here, { lat: 20, lng: 77.01 })).toBeCloseTo(90, 1);
    expect(bearingDegrees(here, { lat: 19.99, lng: 77 })).toBeCloseTo(180, 3);
    expect(bearingDegrees(here, { lat: 20, lng: 76.99 })).toBeCloseTo(270, 1);
  });

  it("round-trips: a point placed at a bearing reads back at that bearing", () => {
    const here: LatLng = { lat: 26.9, lng: 75.8 };
    for (const bearing of [0, 45, 137, 260, 359]) {
      const there = destinationPoint(here, bearing, 25_000);
      expect(haversineMetres(here, there)).toBeCloseTo(25_000, 3);
      // Compared as an angle: due north reads back as 360 − ε, which is the
      // same direction and would fail a plain numeric comparison.
      expect(apart(bearingDegrees(here, there), bearing)).toBeLessThan(0.01);
    }
  });

  it("wraps longitude when stepping across the antimeridian", () => {
    const moved = destinationPoint({ lat: 0, lng: 179.99 }, 90, 5_000);
    expect(moved.lng).toBeLessThan(0);
    expect(moved.lng).toBeGreaterThan(-180);
  });
});

describe("fitProjection", () => {
  it("places the northernmost point above the southernmost", () => {
    const project = fitProjection([DELHI, JAIPUR]);
    // SVG y grows downwards, so further north means a smaller y.
    expect(project(DELHI).y).toBeLessThan(project(JAIPUR).y);
    expect(project(DELHI).x).toBeGreaterThan(project(JAIPUR).x);
  });

  it("keeps every point inside the unit box", () => {
    const project = fitProjection([DELHI, JAIPUR, { lat: 19.076, lng: 72.877 }]);
    for (const point of [DELHI, JAIPUR, { lat: 19.076, lng: 72.877 }]) {
      const { x, y } = project(point);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it("centres a single point instead of dividing by a zero span", () => {
    const project = fitProjection([DELHI]);
    expect(project(DELHI).x).toBeCloseTo(0.5, 6);
    expect(project(DELHI).y).toBeCloseTo(0.5, 6);
  });

  it("centres when there is nothing to project", () => {
    expect(fitProjection([])(DELHI)).toEqual({ x: 0.5, y: 0.5 });
  });
});
