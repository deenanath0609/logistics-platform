/**
 * Spherical geometry for geofencing, deviation and ETA.
 *
 * PostGIS is not installed on this database, so `ST_DWithin` and
 * `ST_Contains` are unavailable and fence evaluation happens here instead
 * (docs/BRD.html §B.6). That is not the compromise it sounds like: the
 * maths is twenty lines, it is exact for circles, and — unlike a SQL
 * predicate — it can be tested exhaustively without a database.
 *
 * Every function in this file is PURE. Nothing here reads the clock, the
 * environment, or the database. When PostGIS lands, `fencesContaining` in
 * `geofence.ts` becomes a query and these functions keep earning their
 * place in deviation, ETA and the replay screen.
 *
 * Distances are metres and angles are degrees throughout. A sphere of mean
 * radius is used rather than the WGS-84 ellipsoid: the error is under 0.3%,
 * which is a few metres on a hub fence and a couple of hundred on a
 * five-hundred-kilometre lane. Neither changes an operational decision.
 */

export type LatLng = { lat: number; lng: number };

/** IUGG mean earth radius, in metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

const DEG_TO_RAD = Math.PI / 180;

function isFinitePoint(point: LatLng | null | undefined): point is LatLng {
  return (
    point != null &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng)
  );
}

/**
 * Great-circle distance between two points, in metres.
 *
 * Haversine rather than the spherical law of cosines: the latter loses
 * precision at short distances, and short distances are exactly what a
 * fifty-metre hub fence is made of.
 */
export function haversineMetres(a: LatLng, b: LatLng): number {
  if (!isFinitePoint(a) || !isFinitePoint(b)) return Number.NaN;

  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  // Normalised so a hop across the antimeridian is a short distance rather
  // than most of the way round the planet.
  const dLng = normaliseLngDelta(b.lng - a.lng) * DEG_TO_RAD;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Folds a longitude difference into (-180, 180]. */
export function normaliseLngDelta(delta: number): number {
  let d = delta % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Is the point within `radiusMetres` of the centre?
 *
 * The boundary counts as inside. A vehicle parked exactly on the fence
 * line has arrived; treating it as outside would mean the debounce never
 * settles and the arrival never fires.
 */
export function isInsideCircle(
  point: LatLng,
  centre: LatLng,
  radiusMetres: number,
): boolean {
  if (!isFinitePoint(point) || !isFinitePoint(centre)) return false;
  if (!Number.isFinite(radiusMetres) || radiusMetres < 0) return false;
  return haversineMetres(point, centre) <= radiusMetres;
}

// ────────────────────────────────────────────────────────────
// Polygons
// ────────────────────────────────────────────────────────────

/**
 * Rewrites a ring and a test point onto one continuous longitude line.
 *
 * Ray casting compares longitudes numerically, which breaks the moment a
 * polygon straddles ±180: a fence running from 179° to -179° looks, to a
 * naive comparison, like a fence wrapping the entire globe the long way
 * round — and every point on earth falls inside it.
 *
 * The fix is to walk the ring accumulating *deltas* rather than absolute
 * longitudes, which makes the fence a narrow band at 179°–181°, and then
 * to bring the test point into the same window. Unwrapping around the
 * point instead would be simpler and wrong: it turns the fence into its
 * own complement for anyone standing on the far side of the planet.
 *
 * Assumes no single edge spans more than 180° of longitude, which is true
 * of any fence a human would draw around a place.
 */
function unwrap(
  point: LatLng,
  ring: readonly LatLng[],
): { point: LatLng; ring: LatLng[] } {
  const unwrapped: LatLng[] = [{ lat: ring[0].lat, lng: ring[0].lng }];
  for (let i = 1; i < ring.length; i++) {
    const previous = unwrapped[i - 1].lng;
    unwrapped.push({
      lat: ring[i].lat,
      lng: previous + normaliseLngDelta(ring[i].lng - previous),
    });
  }

  let min = unwrapped[0].lng;
  let max = unwrapped[0].lng;
  for (const vertex of unwrapped) {
    if (vertex.lng < min) min = vertex.lng;
    if (vertex.lng > max) max = vertex.lng;
  }
  const centre = (min + max) / 2;

  return {
    point: { lat: point.lat, lng: centre + normaliseLngDelta(point.lng - centre) },
    ring: unwrapped,
  };
}

/** Is the point on the segment a–b, within a small tolerance? */
function isOnSegment(point: LatLng, a: LatLng, b: LatLng): boolean {
  // Degrees, not metres: roughly 1 cm at the equator. Small enough that no
  // real fence is widened by it, large enough to absorb float error when a
  // vertex is compared against itself.
  const EPSILON = 1e-9;

  const cross =
    (point.lng - a.lng) * (b.lat - a.lat) - (point.lat - a.lat) * (b.lng - a.lng);
  if (Math.abs(cross) > EPSILON) return false;

  const withinLng =
    point.lng >= Math.min(a.lng, b.lng) - EPSILON &&
    point.lng <= Math.max(a.lng, b.lng) + EPSILON;
  const withinLat =
    point.lat >= Math.min(a.lat, b.lat) - EPSILON &&
    point.lat <= Math.max(a.lat, b.lat) + EPSILON;

  return withinLng && withinLat;
}

/**
 * Point-in-polygon by ray casting, boundary inclusive.
 *
 * The ring may be open or closed; the closing edge is applied either way.
 * Concave shapes are handled correctly — a bounding-box approximation is
 * not good enough for a delivery zone shaped like a horseshoe, and the
 * tests hold this to it.
 *
 * A point exactly on an edge or a vertex is INSIDE. Ray casting is
 * undefined on the boundary, and "undefined" in a geofence means a truck
 * whose arrival depends on floating-point luck, so the boundary is
 * resolved explicitly before the ray is cast.
 */
export function isInsidePolygon(point: LatLng, ring: readonly LatLng[]): boolean {
  if (!isFinitePoint(point)) return false;
  if (!Array.isArray(ring) || ring.length < 3) return false;

  const unwrapped = unwrap(point, ring);
  const vertices = unwrapped.ring;
  const probe = unwrapped.point;

  // Drop an explicit closing vertex; the loop below closes the ring itself.
  const last = vertices[vertices.length - 1];
  const first = vertices[0];
  if (
    vertices.length > 3 &&
    Math.abs(last.lat - first.lat) < 1e-12 &&
    Math.abs(last.lng - first.lng) < 1e-12
  ) {
    vertices.pop();
  }
  if (vertices.length < 3) return false;

  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    if (isOnSegment(probe, vertices[j], vertices[i])) return true;
  }

  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i];
    const b = vertices[j];
    // Half-open crossing test: a vertex is counted for the edge below it
    // and not the edge above, which is what stops a ray passing exactly
    // through a vertex being counted twice.
    const straddles = a.lat > probe.lat !== b.lat > probe.lat;
    if (!straddles) continue;

    const lngAtCrossing =
      a.lng + ((probe.lat - a.lat) / (b.lat - a.lat)) * (b.lng - a.lng);
    if (probe.lng < lngAtCrossing) inside = !inside;
  }

  return inside;
}

/**
 * Reads a GeoJSON value out of `Geofence.polygon` into a ring.
 *
 * Accepts a Polygon geometry, a Feature wrapping one, a bare coordinates
 * array, or an already-decoded `{lat,lng}` list, because a fence drawn in
 * one tool and pasted from another arrives in whichever of those shapes
 * that tool exports. Only the outer ring is used; holes are ignored, and a
 * hub fence with a hole in it is not a thing operations has ever asked for.
 *
 * GeoJSON positions are [longitude, latitude] — the reverse of how every
 * human writes a coordinate, and the single most common way to put a truck
 * in the Indian Ocean.
 */
export function parseGeoJsonRing(value: unknown): LatLng[] | null {
  if (value == null) return null;

  let coordinates: unknown = value;

  if (typeof coordinates === "object" && !Array.isArray(coordinates)) {
    const record = coordinates as Record<string, unknown>;
    if (record.type === "Feature") coordinates = record.geometry;
  }

  if (typeof coordinates === "object" && coordinates !== null && !Array.isArray(coordinates)) {
    const record = coordinates as Record<string, unknown>;
    if (record.type === "Polygon" || record.type === "MultiPolygon") {
      coordinates = record.coordinates;
    } else if (Array.isArray(record.coordinates)) {
      coordinates = record.coordinates;
    }
  }

  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;

  // Peel nesting until the first element looks like a position or a point.
  let level: unknown[] = coordinates;
  for (let depth = 0; depth < 3; depth++) {
    const head = level[0];
    if (Array.isArray(head) && typeof head[0] === "number") break;
    if (head != null && typeof head === "object" && "lat" in (head as object)) break;
    if (!Array.isArray(head)) return null;
    level = head;
  }

  const ring: LatLng[] = [];
  for (const entry of level) {
    if (Array.isArray(entry) && typeof entry[0] === "number" && typeof entry[1] === "number") {
      ring.push({ lat: entry[1], lng: entry[0] });
      continue;
    }
    if (entry != null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      if (typeof record.lat === "number" && typeof record.lng === "number") {
        ring.push({ lat: record.lat, lng: record.lng });
        continue;
      }
    }
    return null;
  }

  return ring.length >= 3 ? ring : null;
}

// ────────────────────────────────────────────────────────────
// Polylines
// ────────────────────────────────────────────────────────────

export type PolylineProjection = {
  /** Perpendicular distance from the point to the route, in metres. */
  distanceMetres: number;
  /** Index of the segment start vertex the point projects onto. */
  segmentIndex: number;
  /** Position along that segment, 0 at its start and 1 at its end. */
  t: number;
  /** The point on the route nearest the input. */
  snapped: LatLng;
  /** Distance from the start of the route to `snapped`, in metres. */
  alongMetres: number;
};

/**
 * Local metre-space around an origin.
 *
 * Segments of a road polyline are short — tens of metres to a few
 * kilometres — and over that span an equirectangular projection centred on
 * the point being tested is accurate to well under a metre. It is also the
 * only way to do a perpendicular-foot calculation without trigonometry in
 * every inner loop, and deviation runs on every ping of every vehicle.
 */
function toLocalMetres(origin: LatLng, point: LatLng): { x: number; y: number } {
  const latScale = Math.cos(origin.lat * DEG_TO_RAD);
  return {
    x: normaliseLngDelta(point.lng - origin.lng) * DEG_TO_RAD * EARTH_RADIUS_M * latScale,
    y: (point.lat - origin.lat) * DEG_TO_RAD * EARTH_RADIUS_M,
  };
}

/** Total length of a polyline, in metres. Zero for fewer than two points. */
export function polylineLengthMetres(polyline: readonly LatLng[]): number {
  if (!Array.isArray(polyline) || polyline.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < polyline.length; i++) {
    total += haversineMetres(polyline[i - 1], polyline[i]);
  }
  return total;
}

/**
 * Nearest point on a route to a position.
 *
 * Returns null for an empty polyline — the honest answer when there is no
 * planned route is "unknown", not a large number that a threshold
 * comparison will silently read as a deviation.
 */
export function projectOntoPolyline(
  point: LatLng,
  polyline: readonly LatLng[],
): PolylineProjection | null {
  if (!isFinitePoint(point)) return null;
  if (!Array.isArray(polyline) || polyline.length === 0) return null;

  if (polyline.length === 1) {
    return {
      distanceMetres: haversineMetres(point, polyline[0]),
      segmentIndex: 0,
      t: 0,
      snapped: polyline[0],
      alongMetres: 0,
    };
  }

  let best: PolylineProjection | null = null;
  let travelled = 0;

  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const segmentLength = haversineMetres(a, b);

    const localB = toLocalMetres(a, b);
    const localP = toLocalMetres(a, point);
    const lengthSquared = localB.x * localB.x + localB.y * localB.y;

    // A zero-length segment (a duplicated vertex) projects to its own start.
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, (localP.x * localB.x + localP.y * localB.y) / lengthSquared),
          );

    const snapped: LatLng = {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + normaliseLngDelta(b.lng - a.lng) * t,
    };
    const distanceMetres = haversineMetres(point, snapped);

    if (best === null || distanceMetres < best.distanceMetres) {
      best = {
        distanceMetres,
        segmentIndex: i - 1,
        t,
        snapped,
        alongMetres: travelled + segmentLength * t,
      };
    }

    travelled += segmentLength;
  }

  return best;
}

/**
 * Metres from a point to the nearest part of a route.
 *
 * Null when there is no route to measure against. Callers must treat that
 * as "cannot say", never as zero and never as infinity.
 */
export function distanceToPolyline(
  point: LatLng,
  polyline: readonly LatLng[],
): number | null {
  return projectOntoPolyline(point, polyline)?.distanceMetres ?? null;
}

// ────────────────────────────────────────────────────────────
// Encoded polylines
// ────────────────────────────────────────────────────────────

/**
 * Google's encoded polyline algorithm, both directions.
 *
 * `RouteLeg.polyline` holds lanes in this format because it is what every
 * routing provider emits and it stores a thousand-point path in a couple
 * of kilobytes. It is a documented, stable format and about forty lines of
 * bit-twiddling, which is not worth a dependency.
 *
 * Precision 5 is the default (roughly one metre); precision 6 exists and
 * some providers use it, so it is a parameter rather than a constant.
 */
export function encodePolyline(points: readonly LatLng[], precision = 5): string {
  const factor = 10 ** precision;
  let previousLat = 0;
  let previousLng = 0;
  let out = "";

  for (const point of points) {
    if (!isFinitePoint(point)) continue;
    const lat = Math.round(point.lat * factor);
    const lng = Math.round(point.lng * factor);
    out += encodeSigned(lat - previousLat);
    out += encodeSigned(lng - previousLng);
    previousLat = lat;
    previousLng = lng;
  }

  return out;
}

function encodeSigned(value: number): string {
  // Left-shift one bit and invert the whole thing when negative, so the
  // sign lives in the low bit and small deltas stay short.
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

/** Decodes an encoded polyline. Returns an empty array for empty input. */
export function decodePolyline(encoded: string | null | undefined, precision = 5): LatLng[] {
  if (typeof encoded !== "string" || encoded.length === 0) return [];

  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    const latDelta = decodeSigned();
    if (latDelta === null) break;
    const lngDelta = decodeSigned();
    if (lngDelta === null) break;
    lat += latDelta;
    lng += lngDelta;
    points.push({ lat: lat / factor, lng: lng / factor });
  }

  return points;

  function decodeSigned(): number | null {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded!.length) return null;
      byte = encoded!.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
}

// ────────────────────────────────────────────────────────────
// Presentation helpers
// ────────────────────────────────────────────────────────────

/**
 * Projects points into a 0–1 box for the schematic map.
 *
 * Equirectangular with a cosine correction on longitude, so the aspect
 * ratio of the network is roughly right rather than stretched sideways —
 * India at 25°N is squeezed by about ten percent without it. This is a
 * schematic, not a tiled map, but a schematic that misrepresents which
 * branch is further north is worse than no map at all.
 */
export function fitProjection(
  points: readonly LatLng[],
  padding = 0.06,
): (point: LatLng) => { x: number; y: number } {
  const usable = points.filter(isFinitePoint);
  if (usable.length === 0) return () => ({ x: 0.5, y: 0.5 });

  const centreLat =
    usable.reduce((sum, p) => sum + p.lat, 0) / usable.length;
  const latScale = Math.max(0.2, Math.cos(centreLat * DEG_TO_RAD));

  const xs = usable.map((p) => p.lng * latScale);
  const ys = usable.map((p) => p.lat);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;

  // One point, or a perfectly straight north–south lane, has no extent in
  // one axis. A single span for both keeps the shape honest, and the
  // fallback keeps the division finite.
  const span = Math.max(maxX - minX, maxY - minY) || 0.02;
  const inner = 1 - padding * 2;

  return (point: LatLng) => {
    if (!isFinitePoint(point)) return { x: 0.5, y: 0.5 };
    const x = padding + (0.5 + (point.lng * latScale - centreX) / span) * inner;
    // SVG y grows downwards; north must end up at the top.
    const y = padding + (0.5 - (point.lat - centreY) / span) * inner;
    return { x, y };
  };
}

/** Compass bearing from a to b, in degrees clockwise from north. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLng = normaliseLngDelta(b.lng - a.lng) * DEG_TO_RAD;

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (Math.atan2(y, x) / DEG_TO_RAD + 360) % 360;
}

/**
 * Moves a point `distanceMetres` along a bearing.
 *
 * Used by the mock provider to walk a vehicle down a lane, and by the
 * replay screen to place a marker between two fixes.
 */
export function destinationPoint(
  origin: LatLng,
  bearing: number,
  distanceMetres: number,
): LatLng {
  const angular = distanceMetres / EARTH_RADIUS_M;
  const theta = bearing * DEG_TO_RAD;
  const lat1 = origin.lat * DEG_TO_RAD;
  const lng1 = origin.lng * DEG_TO_RAD;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(theta),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    lat: lat2 / DEG_TO_RAD,
    lng: ((lng2 / DEG_TO_RAD + 540) % 360) - 180,
  };
}

/**
 * The point `metres` along a polyline from its start.
 *
 * Clamped at both ends: before the start returns the first vertex, past
 * the end returns the last. A vehicle that has overshot its destination is
 * a real situation, and it should render at the destination rather than
 * off the edge of the map.
 */
export function pointAlongPolyline(
  polyline: readonly LatLng[],
  metres: number,
): LatLng | null {
  if (!Array.isArray(polyline) || polyline.length === 0) return null;
  if (polyline.length === 1) return polyline[0];
  if (!Number.isFinite(metres) || metres <= 0) return polyline[0];

  let remaining = metres;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const segment = haversineMetres(a, b);
    if (remaining <= segment) {
      const t = segment === 0 ? 0 : remaining / segment;
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + normaliseLngDelta(b.lng - a.lng) * t,
      };
    }
    remaining -= segment;
  }

  return polyline[polyline.length - 1];
}
