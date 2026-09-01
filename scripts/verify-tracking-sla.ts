/**
 * Tracking and service levels, end to end — as the pipeline sees it and as
 * a signed-in person sees it.
 *
 *   npx tsx scripts/verify-tracking-sla.ts [--tenant city-logistics]
 *                                          [--limited acme]
 *                                          [--base http://localhost:3010]
 *
 * Three sibling scripts already cover parts of this ground and are not
 * repeated here: `verify-gps-tenancy.ts` proves whose vendor account a
 * carrier is polled through, `verify-tracking-privacy.ts` proves the public
 * consignment page leaks nothing internal, and `verify-sla.ts` proves the
 * scanner measures anything at all. What was missing was the join between
 * them — the operating process:
 *
 *   a fence is drawn round a node · a vehicle reports · the fence fires ·
 *   consignments advance · an estimate appears · a promise is measured ·
 *   the promise breaks · somebody is told
 *
 * and, at every step, the two questions a screen cannot answer for itself:
 * can the right person reach it, and is the wrong person kept out.
 *
 * ── A rule this file obeys ─────────────────────────────────────────────
 *
 * No assertion may depend on how much data happens to be in the database.
 * `verify-reweigh.ts` compared a `count()` of a whole table against a
 * `findMany({ take: 6 })` and began failing the day the table held seven
 * rows — a false alarm over a product that was working. Every check below
 * is scoped to the record it is about, and a precondition that is missing
 * is a SKIP rather than a FAIL: "there is no cancelled consignment to test
 * with" is not a defect in the SLA scanner.
 */
import "dotenv/config";
import { basePrisma, prisma } from "../src/lib/prisma";
import {
  runWithTenant,
  tenantContextFor,
  type TenantContext,
} from "../src/lib/tenant";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";
import { getEnv } from "../src/lib/env";
import type { SessionUser } from "../src/lib/auth/session";

import { isInsideFence } from "../src/lib/tracking/geofence";
import { haversineMetres } from "../src/lib/tracking/geo";
import {
  LIVE_TRIP_STATUSES,
  invalidateRouteCache,
  loadFences,
  plannedRouteForTrip,
  type TripContext,
} from "../src/lib/tracking/context";
import { loadLiveFleet, loadTripReplay } from "../src/lib/tracking/queries";
import { pollOnce } from "../src/lib/tracking/runtime";
import { isSimulated } from "../src/lib/tracking/providers";
import { recordManualArrival } from "../src/lib/tracking/manual";
import { runSlaScan, slaDedupeKey } from "../src/lib/sla/scanner";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}

const BASE = args.get("base") ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";
const SUBDOMAIN = args.get("tenant") ?? "city-logistics";
const HOST = `${SUBDOMAIN}.${ROOT}`;
/** A carrier expected to be on a smaller plan, for the gating half. */
const LIMITED = args.get("limited") ?? "acme";

const ADMIN_MOBILE = args.get("mobile") ?? "9999999999";
/** Deepak Rana on the transport desk — network scope, holds the replay. */
const DESK_MOBILE = args.get("desk") ?? "9999900006";
/** A Mumbai branch manager: branch scope, and no replay permission. */
const BRANCH_MOBILE = args.get("branch") ?? "9555000001";
const PASSWORD = args.get("password") ?? "Admin@123";

let failures = 0;
let passes = 0;
let skips = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function skip(label: string, why: string) {
  skips += 1;
  console.log(`  [SKIP] ${label} — ${why}`);
}

function heading(text: string) {
  console.log(`\n${text}`);
}

// ────────────────────────────────────────────────────────────
// Acting as a tenant, and as a person
// ────────────────────────────────────────────────────────────

async function tenantFor(subdomain: string): Promise<TenantContext | null> {
  const org = await basePrisma.organization.findFirst({
    where: { OR: [{ subdomain }, { slug: subdomain }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  if (!org) return null;
  return tenantContextFor(org, "job");
}

async function signIn(mobile: string, landing: string): Promise<CookieJar> {
  const jar = new CookieJar();

  const csrf = await hostFollow(HOST, PORT, "/api/auth/csrf", jar);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

  const response = await hostFetch(HOST, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body: new URLSearchParams({
      mobile,
      password: PASSWORD,
      csrfToken,
      callbackUrl: `${BASE}${landing}`,
    }).toString(),
  });
  jar.absorb(response);

  return jar;
}

/**
 * A session for the service layer, resolved from a real user row.
 *
 * Only for the checks that call a service directly. Everything that is
 * about a *screen* is driven over HTTP with a real cookie, because a page
 * can be broken in ways a service call cannot see.
 */
async function actorFor(mobile: string): Promise<SessionUser | null> {
  const user = await prisma.user.findFirst({
    where: { mobile, deletedAt: null },
    select: {
      id: true,
      orgId: true,
      name: true,
      mobile: true,
      email: true,
      isFieldUser: true,
      mustChangePassword: true,
      primaryBranch: { select: { id: true, code: true, name: true } },
      branchScopes: { select: { branchId: true } },
      roles: {
        select: {
          role: {
            select: {
              code: true,
              name: true,
              scope: true,
              permissions: { select: { permission: { select: { code: true } } } },
            },
          },
        },
      },
    },
  });
  if (!user) return null;

  const permissions = new Set<string>();
  const rank: Record<string, number> = { OWN: 0, BRANCH: 1, BRANCH_SET: 2, NETWORK: 3 };
  let widest: SessionUser["scope"] = "OWN";

  for (const link of user.roles) {
    for (const rp of link.role.permissions) permissions.add(rp.permission.code);
    const scope = link.role.scope as SessionUser["scope"];
    if ((rank[scope] ?? 0) > (rank[widest] ?? 0)) widest = scope;
  }

  const branchIds =
    widest === "NETWORK"
      ? null
      : [
          ...new Set(
            [
              user.primaryBranch?.id,
              ...user.branchScopes.map((s) => s.branchId),
            ].filter((id): id is string => Boolean(id)),
          ),
        ];

  return {
    id: user.id,
    orgId: user.orgId,
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    isFieldUser: user.isFieldUser,
    mustChangePassword: user.mustChangePassword,
    primaryBranch: user.primaryBranch,
    roles: user.roles.map((r) => ({
      code: r.role.code,
      name: r.role.name,
      scope: r.role.scope as SessionUser["scope"],
    })),
    permissions,
    scope: widest,
    branchIds,
  };
}

/** The same person, narrowed to a set of branches that excludes a trip. */
function scopedTo(user: SessionUser, branchIds: string[]): SessionUser {
  return { ...user, scope: "BRANCH_SET", branchIds };
}

/** The same person with a permission taken away. */
function without(user: SessionUser, code: string): SessionUser {
  const permissions = new Set(user.permissions);
  permissions.delete(code);
  return { ...user, permissions };
}

// ────────────────────────────────────────────────────────────

type LiveTrip = {
  id: string;
  number: string;
  status: string;
  orgId: string;
  vehicleId: string;
  routeId: string | null;
  originBranchId: string;
  destinationBranchId: string;
  actualDepartureAt: Date | null;
  plannedArrivalAt: Date | null;
};

async function main() {
  const tenant = await tenantFor(SUBDOMAIN);
  if (!tenant) throw new Error(`No carrier at "${SUBDOMAIN}".`);

  console.log(`\nTracking and service levels — ${tenant.slug}\n`);

  // ══════════════════════════════════════════════════════════
  // 1. The fences the whole automation rests on
  // ══════════════════════════════════════════════════════════
  //
  // Every automatic arrival in the product begins here. A fence with no
  // geometry, or one drawn so tight it excludes the node it is named
  // after, produces nothing at all — and produces it silently, which is
  // the failure mode worth a script.

  heading("Geofences — the shape of each node");

  const fenceRows = await runWithTenant(tenant, async () =>
    await prisma.geofence.findMany({
      where: { isActive: true, branchId: { not: null } },
      take: 20,
      select: {
        id: true,
        name: true,
        radiusMeters: true,
        debouncePings: true,
        branch: { select: { code: true, latitude: true, longitude: true } },
      },
    }),
  );

  const loaded = await runWithTenant(tenant, () => loadFences({ fresh: true }));

  if (fenceRows.length === 0) {
    skip("a fence encloses its own node", "no active fence wraps a branch");
    skip("a fence does not enclose the next city", "same reason");
    skip("every active fence survives loading", "same reason");
  } else {
    // Scoped to the fences just read, not to a count of the table.
    const loadedIds = new Set(loaded.map((fence) => fence.id));
    const dropped = fenceRows.filter((row) => !loadedIds.has(row.id));
    check(
      "every active fence survives loading with usable geometry",
      dropped.length === 0,
      dropped.length > 0
        ? `dropped: ${dropped.map((f) => f.name).join(", ")}`
        : `${fenceRows.length} checked`,
    );

    const placed = fenceRows.filter(
      (row) => row.branch?.latitude != null && row.branch.longitude != null,
    );

    const misses = placed.filter((row) => {
      const fence = loaded.find((f) => f.id === row.id);
      if (!fence) return true;
      return !isInsideFence(
        { lat: Number(row.branch!.latitude), lng: Number(row.branch!.longitude) },
        fence,
      );
    });

    check(
      "a fence encloses the node it is named after",
      placed.length > 0 && misses.length === 0,
      misses.length > 0
        ? `${misses.map((f) => f.name).join(", ")} exclude their own branch`
        : `${placed.length} fence(s)`,
    );

    // The opposite failure: a radius typed in kilometres rather than
    // metres swallows the region and every passing lorry arrives.
    const tooWide = placed.filter((row) => (row.radiusMeters ?? 0) > 20_000);
    check(
      "no fence is wide enough to be a region",
      tooWide.length === 0,
      tooWide.length > 0 ? tooWide.map((f) => `${f.name} ${f.radiusMeters}m`).join(", ") : "",
    );

    const noDebounce = placed.filter((row) => row.debouncePings < 1);
    check(
      "every fence demands at least one agreeing fix",
      noDebounce.length === 0,
      noDebounce.map((f) => f.name).join(", "),
    );
  }

  // ══════════════════════════════════════════════════════════
  // 2. The pull, through this carrier's own vendor
  // ══════════════════════════════════════════════════════════

  heading("The poll");

  const pollResult = await runWithTenant(tenant, () => pollOnce({ force: true }));

  if (pollResult.devices === 0) {
    skip("a forced poll reaches a vendor", "no vehicle has a GPS device id on file");
  } else {
    check(
      "a forced poll reaches at least one vendor and none refuses",
      pollResult.providers > 0 && pollResult.failures.length === 0,
      `${pollResult.providers} vendor(s), ${pollResult.failures
        .map((f) => `${f.code}: ${f.message}`)
        .join("; ")}`,
    );
    check(
      "the pass reports what it did with the fixes it got",
      pollResult.accepted + pollResult.duplicates === pollResult.fixes,
      `${pollResult.fixes} fix(es) = ${pollResult.accepted} new + ${pollResult.duplicates} duplicate`,
    );
  }

  // ══════════════════════════════════════════════════════════
  // 3. The route a trip is measured against
  // ══════════════════════════════════════════════════════════
  //
  // `plannedRouteForTrip` caches. The quality it reports says where the
  // path came from, and route-deviation detection is switched on or off by
  // it — so a quality that changes between a cold read and a cached one
  // silently stops the detector. Asserted for one trip, across the cache
  // boundary, which is exactly where it used to differ.

  heading("The planned route, before and after the cache");

  const trips: LiveTrip[] = await runWithTenant(tenant, async () =>
    await prisma.trip.findMany({
      where: { status: { in: [...LIVE_TRIP_STATUSES] } },
      orderBy: [{ actualDepartureAt: "desc" }, { createdAt: "desc" }],
      take: 5,
      select: {
        id: true,
        number: true,
        status: true,
        orgId: true,
        vehicleId: true,
        routeId: true,
        originBranchId: true,
        destinationBranchId: true,
        actualDepartureAt: true,
        plannedArrivalAt: true,
      },
    }),
  );

  if (trips.length === 0) {
    skip("route quality survives the cache", "no trip is running");
  } else {
    const subject: TripContext = { ...trips[0], status: trips[0].status };

    const cold = await runWithTenant(tenant, async () => {
      invalidateRouteCache(subject.id);
      return await plannedRouteForTrip(subject);
    });
    const warm = await runWithTenant(tenant, () => plannedRouteForTrip(subject));

    check(
      "route quality survives the cache for the trip under test",
      cold.quality === warm.quality && cold.points.length === warm.points.length,
      `${trips[0].number}: cold ${cold.quality} (${cold.points.length} pts) vs warm ${warm.quality} (${warm.points.length} pts)`,
    );
  }

  // ══════════════════════════════════════════════════════════
  // 4. The live map's read model
  // ══════════════════════════════════════════════════════════

  heading("The live map");

  const admin = await runWithTenant(tenant, () => actorFor(ADMIN_MOBILE));
  if (!admin) throw new Error(`No user with mobile ${ADMIN_MOBILE}.`);

  const fleet = await runWithTenant(tenant, () => loadLiveFleet(admin));

  // Scoped to the trips actually sampled rather than to a count of the
  // table: the fleet legitimately holds more rows than a `take: 5` sample,
  // and an assertion that compares the two starts failing the day a sixth
  // trip is dispatched.
  const onMap = new Set(fleet.vehicles.map((v) => v.trip?.id));
  const missing = trips.filter((trip) => !onMap.has(trip.id));
  check(
    "every running trip sampled has its vehicle on the live map",
    missing.length === 0,
    missing.length > 0
      ? `absent: ${missing.map((t) => t.number).join(", ")}`
      : `${trips.length} trip(s) of ${fleet.vehicles.length} on the map`,
  );

  // Every vehicle on the map carries a trip; the map exists to show trips.
  const tripless = fleet.vehicles.filter((v) => v.trip === null);
  check(
    "every vehicle on the map is on a trip",
    tripless.length === 0,
    tripless.map((v) => v.registrationNumber).join(", "),
  );

  // The estimate, or the timetable — never a blank where the trip carries
  // a planned arrival. A vehicle standing still produces no GPS estimate
  // by design, and "no estimate" on a trip that has a promised arrival on
  // its own row reads as a broken screen.
  const withPlan = fleet.vehicles.filter((v) => v.trip?.plannedArrivalAt);
  const blank = withPlan.filter((v) => v.eta === null);
  if (withPlan.length === 0) {
    skip("a trip with a planned arrival always shows one", "no sampled trip has one");
  } else {
    check(
      "a trip with a planned arrival always shows an arrival estimate",
      blank.length === 0,
      blank.length > 0
        ? `${blank.map((v) => v.registrationNumber).join(", ")} show nothing`
        : `${withPlan.length} trip(s), method(s): ${[
            ...new Set(withPlan.map((v) => v.eta?.method)),
          ].join(", ")}`,
    );
  }

  // A schedule estimate must never masquerade as a measurement.
  const schedules = fleet.vehicles.filter((v) => v.eta?.method === "schedule");
  if (schedules.length === 0) {
    skip("a timetable estimate is labelled as one", "every estimate is measured");
  } else {
    check(
      "a timetable estimate is labelled as one and claims no lateness",
      schedules.every((v) => v.eta?.confidence === "low" && v.eta?.delayMinutes === null),
      `${schedules.length} on the timetable`,
    );
  }

  // The counts on the filter chips have to add up to the fleet, or the
  // "All 8 / Moving 3 / Stopped 1" row is arithmetic nobody can follow.
  const counted =
    fleet.counts.moving + fleet.counts.stopped + fleet.counts.silent + fleet.counts.idle;
  check(
    "the filter counts partition the fleet exactly once",
    counted === fleet.vehicles.length,
    `${counted} counted against ${fleet.vehicles.length} vehicles`,
  );

  // Positions have to be near the network, not in the Gulf of Guinea — a
  // latitude and longitude swapped at an adapter boundary lands at 0,0.
  const branchPoints = fleet.branches.map((b) => b.point);
  const stray = fleet.vehicles.filter((v) => {
    if (!v.position || branchPoints.length === 0) return false;
    const nearest = Math.min(
      ...branchPoints.map((p) => haversineMetres(v.position!, p)),
    );
    return nearest > 2_000_000;
  });
  check(
    "no vehicle is plotted thousands of kilometres from the network",
    stray.length === 0,
    stray.map((v) => `${v.registrationNumber} @ ${v.position?.lat},${v.position?.lng}`).join(", "),
  );

  // ══════════════════════════════════════════════════════════
  // 5. Branch scope on the replay
  // ══════════════════════════════════════════════════════════
  //
  // The live map has always been scoped to the branches a user covers.
  // The replay — position by position, with the driver's name on it — was
  // not, so any trip id was readable by anyone holding `tracking.replay`.

  heading("Trip replay, and who may read it");

  if (trips.length === 0) {
    skip("a covering user can replay the trip", "no trip is running");
    skip("a user outside both ends cannot", "same reason");
  } else {
    const subject = trips[0];

    const covering = await runWithTenant(tenant, () =>
      loadTripReplay(
        subject.id,
        scopedTo(admin, [subject.originBranchId, subject.destinationBranchId]),
      ),
    );
    check(
      "a user covering one end of the lane can replay it",
      covering !== null && covering.trip.id === subject.id,
      subject.number,
    );

    // A branch set that is real but excludes both ends of this lane.
    const elsewhere = await runWithTenant(tenant, async () =>
      await prisma.branch.findFirst({
        where: {
          deletedAt: null,
          id: { notIn: [subject.originBranchId, subject.destinationBranchId] },
        },
        select: { id: true, code: true },
      }),
    );

    if (!elsewhere) {
      skip("a user outside both ends cannot", "the network has only these two branches");
    } else {
      const outside = await runWithTenant(tenant, () =>
        loadTripReplay(subject.id, scopedTo(admin, [elsewhere.id])),
      );
      check(
        "a user covering neither end is refused the replay",
        outside === null,
        `${elsewhere.code} against ${subject.number}`,
      );
    }

    const network = await runWithTenant(tenant, () =>
      loadTripReplay(subject.id, admin),
    );
    check(
      "a network-scoped user is unaffected by the scoping",
      network !== null,
      subject.number,
    );
  }

  // ══════════════════════════════════════════════════════════
  // 6. Recording by hand — the permission and the branch
  // ══════════════════════════════════════════════════════════
  //
  // A manual arrival writes the same GEOFENCE_ENTER a fence would, on
  // every consignment aboard. It was once reachable on a read permission,
  // which would have let a read-only account advance a whole trip. Nothing
  // below writes: each call must be refused before it reaches a write.

  heading("Recording a movement by hand");

  if (trips.length === 0) {
    skip("a read-only account cannot post an arrival", "no trip is running");
    skip("a branch that does not cover the node cannot either", "same reason");
  } else {
    const subject = trips[0];

    const readOnly = without(admin, "trip.dispatch");
    const refusedByPermission = await runWithTenant(tenant, () =>
      recordManualArrival(
        { tripId: subject.id, branchId: subject.destinationBranchId },
        readOnly,
      ),
    );
    check(
      "an account without trip.dispatch cannot post an arrival",
      refusedByPermission.ok === false,
      refusedByPermission.ok ? "IT WAS ACCEPTED" : refusedByPermission.error,
    );

    const elsewhere = await runWithTenant(tenant, async () =>
      await prisma.branch.findFirst({
        where: { deletedAt: null, id: { not: subject.destinationBranchId } },
        select: { id: true, code: true },
      }),
    );

    if (!elsewhere) {
      skip("a branch outside scope cannot post an arrival", "only one branch exists");
    } else {
      const refusedByScope = await runWithTenant(tenant, () =>
        recordManualArrival(
          { tripId: subject.id, branchId: subject.destinationBranchId },
          scopedTo(admin, [elsewhere.id]),
        ),
      );
      check(
        "a user who does not cover the node cannot post an arrival there",
        refusedByScope.ok === false,
        refusedByScope.ok ? "IT WAS ACCEPTED" : refusedByScope.error,
      );
    }
  }

  // ══════════════════════════════════════════════════════════
  // 7. The SLA scanner, on one shipment at a time
  // ══════════════════════════════════════════════════════════

  heading("Service levels");

  const measured = await runWithTenant(tenant, async () =>
    await prisma.shipmentSla.findFirst({
      where: { state: { notIn: ["NOT_APPLICABLE"] } },
      orderBy: { updatedAt: "desc" },
      select: { shipmentId: true, dueAt: true, policyId: true, state: true },
    }),
  );

  if (!measured) {
    skip("a re-scan of one shipment changes nothing", "nothing is measured yet");
  } else {
    const before = measured.dueAt.getTime();

    await runWithTenant(tenant, () =>
      runSlaScan({ shipmentId: measured.shipmentId }),
    );

    const after = await runWithTenant(tenant, async () =>
      await prisma.shipmentSla.findUnique({
        where: { shipmentId: measured.shipmentId },
        select: { dueAt: true, policyId: true },
      }),
    );

    check(
      "re-scanning one shipment leaves its promise exactly where it was",
      after !== null &&
        after.dueAt.getTime() === before &&
        after.policyId === measured.policyId,
      `due ${measured.dueAt.toISOString()} → ${after?.dueAt.toISOString()}`,
    );
    check(
      "a measured shipment carries the policy that measured it",
      Boolean(measured.policyId),
      measured.state,
    );
  }

  // A breach that nobody is told about is a breach that did not happen.
  const breached = await runWithTenant(tenant, async () =>
    await prisma.shipmentSla.findMany({
      where: { state: "BREACHED" },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { shipmentId: true },
    }),
  );

  if (breached.length === 0) {
    skip("every breach reaches the control tower", "nothing has breached");
  } else {
    const keys = breached.map((row) => slaDedupeKey("SLA_BREACHED", row.shipmentId));
    const raised = await runWithTenant(tenant, async () =>
      await prisma.exception.findMany({
        where: { dedupeKey: { in: keys } },
        select: { dedupeKey: true },
      }),
    );
    const seen = new Set(raised.map((row) => row.dedupeKey));
    const silent = keys.filter((key) => !seen.has(key));

    check(
      "every breached shipment sampled has an exception in the tower",
      silent.length === 0,
      silent.length > 0 ? `${silent.length} of ${keys.length} silent` : `${keys.length} checked`,
    );
  }

  // Cancelled freight is not late freight. The single-shipment recompute
  // is triggered by `shipment.cancelled`, and until it learned to retire
  // the row it read straight through to BREACHED and opened an exception
  // against a consignment nobody is carrying.
  const cancelled = await runWithTenant(tenant, async () =>
    await prisma.shipment.findFirst({
      where: { currentStatus: "CANCELLED", deletedAt: null },
      orderBy: { statusUpdatedAt: "desc" },
      select: { id: true, lrNumber: true },
    }),
  );

  if (!cancelled) {
    skip("a cancelled consignment is not measured", "no cancelled consignment exists");
  } else {
    await runWithTenant(tenant, () => runSlaScan({ shipmentId: cancelled.id }));

    const outcome = await runWithTenant(tenant, async () => {
      const sla = await prisma.shipmentSla.findUnique({
        where: { shipmentId: cancelled.id },
        select: { state: true, settledAt: true },
      });
      const exception = await prisma.exception.findFirst({
        where: { dedupeKey: slaDedupeKey("SLA_BREACHED", cancelled.id) },
        select: { id: true },
      });
      return { sla, exception };
    });

    check(
      "a cancelled consignment raises no SLA breach",
      outcome.exception === null,
      cancelled.lrNumber,
    );
    check(
      "and its clock is stopped rather than left running",
      outcome.sla !== null && outcome.sla.settledAt !== null,
      `${outcome.sla?.state ?? "no row"}`,
    );
  }

  // ══════════════════════════════════════════════════════════
  // 8. The screens, over HTTP, as a signed-in person
  // ══════════════════════════════════════════════════════════

  heading(`The screens — as ${ADMIN_MOBILE} on ${HOST}`);

  const jar = await signIn(ADMIN_MOBILE, "/tracking");

  const map = await hostFollow(HOST, PORT, "/tracking", jar);
  check(
    "the live map renders",
    map.status === 200 && !map.finalPath.includes("/login"),
    `HTTP ${map.status} at ${map.finalPath}`,
  );
  check(
    "and is not behind a plan for a carrier that bought tracking",
    !map.finalPath.includes("/not-on-plan"),
    map.finalPath,
  );

  // The screen must say something either way. A blank page is the failure
  // this module spent its whole life in: no device ids, no fixes, nothing
  // rendered, and no explanation of which.
  check(
    "the map is never blank — either a fleet or a reason there is none",
    map.body.includes("Network schematic") || map.body.includes("No trip is running"),
    fleet.vehicles.length > 0 ? "fleet drawn" : "empty state explained",
  );

  if (fleet.vehicles.length > 0) {
    const first = fleet.vehicles[0];
    check(
      "the vehicle under test is on the page",
      map.body.includes(first.registrationNumber),
      first.registrationNumber,
    );
  }

  // The banner says whose positions these are. It used to read
  // `GPS_PROVIDER` out of the environment, which is the platform's
  // fallback and not this carrier's answer.
  const configuredCodes = await runWithTenant(tenant, async () =>
    (
      await prisma.trackingProviderConfig.findMany({
        where: { isActive: true },
        select: { code: true },
      })
    ).map((row) => row.code),
  );
  const expectSimulated =
    configuredCodes.length > 0
      ? configuredCodes.every((code) => isSimulated(code))
      : isSimulated(getEnv().GPS_PROVIDER);

  check(
    "the simulated-positions banner matches this carrier's own vendors",
    map.body.includes("Running on simulated positions") === expectSimulated,
    configuredCodes.length > 0
      ? `rows: ${configuredCodes.join(", ")}`
      : `no rows; environment says ${getEnv().GPS_PROVIDER}`,
  );

  const fences = await hostFollow(HOST, PORT, "/tracking/geofences", jar);
  check(
    "the geofence screen renders",
    fences.status === 200 && !fences.finalPath.includes("/login"),
    `HTTP ${fences.status} at ${fences.finalPath}`,
  );
  if (fenceRows.length > 0) {
    check(
      "the fence under test is listed with its node",
      fences.body.includes(fenceRows[0].name),
      fenceRows[0].name,
    );
  }
  check(
    "and offers a way to draw a new one",
    fences.body.includes("New fence"),
    "the create control is on the page",
  );

  const providers = await hostFollow(HOST, PORT, "/tracking/providers", jar);
  check(
    "the provider screen renders",
    providers.status === 200 && !providers.finalPath.includes("/login"),
    `HTTP ${providers.status} at ${providers.finalPath}`,
  );
  check(
    "and offers the poll-now button a fitter needs",
    providers.body.includes("Poll now"),
  );

  // Secrets are reduced to a boolean at the query. Proved against the
  // rendered HTML, because a value can leak through a prop or a serialised
  // payload without the projection ever changing.
  const secrets = await runWithTenant(tenant, async () =>
    await prisma.trackingProviderConfig.findMany({
      take: 5,
      select: { code: true, apiKey: true, webhookSecret: true },
    }),
  );
  const leaked = secrets.flatMap((row) =>
    [row.apiKey, row.webhookSecret]
      .filter((value): value is string => Boolean(value) && String(value).length >= 8)
      .filter((value) => providers.body.includes(value))
      .map((value) => `${row.code}: ${value.slice(0, 4)}…`),
  );
  check(
    "no vendor secret reaches the provider screen's HTML",
    leaked.length === 0,
    leaked.join(", "),
  );

  if (trips.length > 0) {
    const replay = await hostFollow(HOST, PORT, `/tracking/trips/${trips[0].id}`, jar);
    check(
      "the trip replay renders for the trip under test",
      replay.status === 200 && replay.body.includes(trips[0].number),
      `${trips[0].number} — HTTP ${replay.status} at ${replay.finalPath}`,
    );
    check(
      "and reports how much of the trip was recorded automatically",
      replay.body.includes("How this trip"),
    );
  }

  const policies = await hostFollow(HOST, PORT, "/masters/sla-policies", jar);
  check(
    "the SLA policy screen renders",
    policies.status === 200 && !policies.finalPath.includes("/login"),
    `HTTP ${policies.status} at ${policies.finalPath}`,
  );

  const policyRow = await runWithTenant(tenant, async () =>
    await prisma.slaPolicy.findFirst({
      orderBy: { code: "asc" },
      select: { code: true },
    }),
  );
  if (policyRow) {
    check(
      "the policy under test is listed",
      policies.body.includes(policyRow.code),
      policyRow.code,
    );
  } else {
    skip("the policy under test is listed", "no SLA policy exists");
  }
  check(
    "and the lane tester is on the page",
    policies.body.includes("Test a lane") || policies.body.includes("Test this lane"),
  );

  const ladder = await hostFollow(
    HOST,
    PORT,
    "/masters/sla-policies/escalations",
    jar,
  );
  check(
    "the escalation ladder renders",
    ladder.status === 200 && !ladder.finalPath.includes("/login"),
    `HTTP ${ladder.status} at ${ladder.finalPath}`,
  );

  // ══════════════════════════════════════════════════════════
  // 9. The people who must not get in
  // ══════════════════════════════════════════════════════════

  heading("Who is kept out");

  const branchJar = await signIn(BRANCH_MOBILE, "/dashboard");
  const landed = await hostFollow(HOST, PORT, "/dashboard", branchJar);

  if (landed.finalPath.includes("/login")) {
    skip("a branch manager cannot replay a trip", `${BRANCH_MOBILE} could not sign in`);
  } else if (trips.length === 0) {
    skip("a branch manager cannot replay a trip", "no trip is running");
  } else {
    const denied = await hostFollow(
      HOST,
      PORT,
      `/tracking/trips/${trips[0].id}`,
      branchJar,
    );
    check(
      "a branch manager, who holds no replay permission, is refused the replay",
      denied.status !== 200 || !denied.body.includes(trips[0].number),
      `HTTP ${denied.status} at ${denied.finalPath}`,
    );

    const noProviders = await hostFollow(HOST, PORT, "/tracking/providers", branchJar);
    check(
      "and cannot reach the telematics configuration",
      noProviders.status !== 200 || !noProviders.body.includes("Poll now"),
      `HTTP ${noProviders.status} at ${noProviders.finalPath}`,
    );
  }

  // The transport desk is the role this module was written for: network
  // scope, live map and replay, no power to repoint the fleet.
  const deskJar = await signIn(DESK_MOBILE, "/tracking");
  const deskMap = await hostFollow(HOST, PORT, "/tracking", deskJar);

  if (deskMap.finalPath.includes("/login")) {
    skip("the transport desk can work the live map", `${DESK_MOBILE} could not sign in`);
  } else {
    check(
      "the transport desk reaches the live map",
      deskMap.status === 200,
      `HTTP ${deskMap.status} at ${deskMap.finalPath}`,
    );

    const deskProviders = await hostFollow(HOST, PORT, "/tracking/providers", deskJar);
    check(
      "but cannot repoint the fleet at another endpoint",
      deskProviders.status !== 200 || !deskProviders.body.includes("Poll now"),
      `HTTP ${deskProviders.status} at ${deskProviders.finalPath}`,
    );
  }

  // ══════════════════════════════════════════════════════════
  // 10. A carrier who did not buy these modules
  // ══════════════════════════════════════════════════════════

  heading("Plan gating");

  const limited = await tenantFor(LIMITED);
  if (!limited) {
    skip("a carrier without tracking is refused it", `no carrier at "${LIMITED}"`);
  } else {
    const { MODULES } = await import("../src/lib/modules/modules");
    const { modulesForPlan } = await import("../src/lib/modules/registry");

    const plan = await basePrisma.organization.findFirst({
      where: { OR: [{ subdomain: LIMITED }, { slug: LIMITED }] },
      select: { plan: { select: { features: true } } },
    });
    const owned = modulesForPlan(plan?.plan?.features ?? [], MODULES);

    const limitedHost = `${LIMITED}.${ROOT}`;
    const limitedJar = new CookieJar();
    const csrf = await hostFollow(limitedHost, PORT, "/api/auth/csrf", limitedJar);
    const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };
    const posted = await hostFetch(limitedHost, PORT, "/api/auth/callback/password", {
      method: "POST",
      cookie: limitedJar.header(),
      body: new URLSearchParams({
        mobile: ADMIN_MOBILE,
        password: PASSWORD,
        csrfToken,
        callbackUrl: `http://${limitedHost}:${PORT}/dashboard`,
      }).toString(),
    });
    limitedJar.absorb(posted);

    const home = await hostFollow(limitedHost, PORT, "/dashboard", limitedJar);

    if (home.finalPath.includes("/login")) {
      skip("a carrier without tracking is refused it", `${ADMIN_MOBILE} has no login at ${LIMITED}`);
    } else {
      for (const [module, path] of [
        ["tracking", "/tracking"],
        ["sla", "/masters/sla-policies"],
      ] as const) {
        if (owned.has(module)) {
          skip(`${LIMITED} is refused ${path}`, `${LIMITED} is on a plan that includes ${module}`);
          continue;
        }

        const refused = await hostFollow(limitedHost, PORT, path, limitedJar);
        check(
          `${LIMITED} is refused ${path}`,
          refused.finalPath.includes("/not-on-plan") || refused.status === 404,
          `HTTP ${refused.status} at ${refused.finalPath}`,
        );
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────
  console.log(
    `\n${passes} passed, ${failures} failed, ${skips} skipped.\n` +
      (failures === 0
        ? "Tracking and service levels behave as the process expects.\n"
        : "Tracking or service levels are not behaving as the process expects.\n"),
  );

  if (failures > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error("\nverify-tracking-sla could not finish:\n", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await basePrisma.$disconnect();
  });
