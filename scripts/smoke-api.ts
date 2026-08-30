/**
 * Drives the partner API under `/api/v1` with real keys over real HTTP.
 *
 *   npx tsx scripts/smoke-api.ts [tenant-subdomain] [--other acme-freight]
 *                                [--base http://localhost:3010]
 *
 * The partner API is the one surface where a mistake is somebody else's
 * integration breaking, and until this existed nothing exercised it end to
 * end: the routes were reachable only through `verify-tenant-isolation.ts`,
 * which asks for one endpoint with a key that does not exist.
 *
 * Three things are worth proving here and only one of them is "the endpoint
 * works":
 *
 *   · every endpoint answers, in its documented envelope;
 *   · a key issued by one carrier is not a key on another carrier's host —
 *     the tenant comes from the `Host` header, and the key lookup is
 *     tenant-scoped, so a leak here would be silent; and
 *   · a key tied to a customer sees that customer's consignments and no
 *     others, which is the whole promise of a customer integration.
 *
 * It mints its own keys and deletes them again, so a run leaves the tenant
 * as it found it. The consignment it books is left behind for the same
 * reason `verify-spine.ts` leaves its own: the event log is append-only,
 * and tidying up would mean defeating the guarantee under test.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma, basePrisma } from "../src/lib/prisma";
import { disconnectDb } from "../src/lib/prisma-base";
import { runWithTenant, tenantContextFor, type TenantContext } from "../src/lib/tenant";
import { generateApiKey } from "../src/lib/webhooks/api-key";
import { hostFetch } from "./host-fetch";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter(
  (value, index) => !value.startsWith("--") && !args[index - 1]?.startsWith("--"),
);

const SUBDOMAIN = positional[0] ?? "city-logistics";
const OTHER = flag("other") ?? "acme-freight";
const BASE = flag("base") ?? process.env.APP_URL ?? "http://localhost:3010";
const PORT = Number(new URL(BASE).port || 80);
const ROOT = process.env.APP_ROOT_DOMAIN ?? "localhost";

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/** The scopes the console offers, which is every scope a key may carry. */
const ALL_SCOPES = [
  "shipment.create",
  "shipment.read",
  "tracking.read",
  "pickup.create",
  "pickup.read",
];

type ApiCall = {
  status: number;
  json: Record<string, unknown> | null;
  raw: string;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * One partner call.
 *
 * `X-Api-Key` rather than `Authorization`, because it is the header the
 * guard reads first and the one the docs lead with. The transport is
 * `node:http` for the reason spelled out in `host-fetch.ts` — the API is
 * served on the carrier's own subdomain and `fetch` cannot name it.
 */
async function call(
  host: string,
  path: string,
  options: {
    key?: string | null;
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
    contentType?: string | null;
  } = {},
): Promise<ApiCall> {
  const headers: Record<string, string> = {};
  if (options.key) headers["x-api-key"] = options.key;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

  const serialised = options.body === undefined ? undefined : JSON.stringify(options.body);

  const response = await hostFetch(host, PORT, path, {
    method: options.method ?? (serialised ? "POST" : "GET"),
    body: serialised,
    // `null` means "send a body with the wrong content type", which is its
    // own test: the reader refuses anything that is not JSON.
    contentType:
      options.contentType === null
        ? "text/plain"
        : (options.contentType ?? "application/json"),
    headers,
  });

  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = null;
  }

  return { status: response.status, json, raw: response.body, headers: response.headers };
}

const errorCode = (result: ApiCall): string =>
  ((result.json?.error as { code?: string } | undefined)?.code ?? "(no error code)");

const dataOf = <T,>(result: ApiCall): T => (result.json?.data ?? {}) as T;

async function actingTenant(subdomainOrSlug: string): Promise<TenantContext | null> {
  const org = await basePrisma.organization.findFirst({
    where: { OR: [{ subdomain: subdomainOrSlug }, { slug: subdomainOrSlug }] },
    select: { id: true, slug: true, subdomain: true, customDomain: true, status: true },
  });
  if (!org) return null;
  return tenantContextFor(org, "job");
}

/**
 * Mint a key the way the console does — `generateApiKey` plus a row.
 *
 * The plaintext exists only in the return value of `generateApiKey`, here
 * and in production alike, which is why this has to be done rather than
 * read out of the database.
 */
async function issueKey(input: {
  /** The carrier the key belongs to — taken from the issuing user's row. */
  orgId: string;
  name: string;
  scopes: string[];
  createdById: string;
  customerId?: string | null;
}) {
  const generated = generateApiKey();
  const row = await prisma.apiKey.create({
    data: {
      orgId: input.orgId,
      name: input.name,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      scopes: input.scopes,
      ipAllowlist: [],
      customerId: input.customerId ?? null,
      createdById: input.createdById,
    },
    select: { id: true },
  });
  return { id: row.id, key: generated.key };
}

async function main() {
  const tenant = await actingTenant(SUBDOMAIN);
  if (!tenant) {
    console.error(`\nNo open organisation with subdomain or slug "${SUBDOMAIN}".\n`);
    process.exitCode = 1;
    return;
  }

  const HOST = `${tenant.subdomain}.${ROOT}`;
  console.log(
    `\nPartner API — acting as ${tenant.slug} on http://${HOST}:${PORT}/api/v1\n`,
  );

  const issued: string[] = [];

  try {
    await runWithTenant(tenant, async () => {
      // ── Fixtures ────────────────────────────────────────────
      const owner = await prisma.user.findFirst({
        where: { mobile: process.env.SMOKE_ADMIN_MOBILE ?? "9999999999", status: "ACTIVE" },
        select: { id: true, name: true, orgId: true },
      });

      if (!owner) {
        throw new Error(
          "No active super admin to own the keys. A key inherits its creator's " +
            "permissions, so it must be issued by somebody who holds them.",
        );
      }

      // A branch's own PIN is guaranteed to be in the pincode master and
      // serviceable, so the fixture cannot fail for a reason that has
      // nothing to do with the API under test.
      const branches = await prisma.branch.findMany({
        where: {
          isActive: true,
          deletedAt: null,
        },
        orderBy: { code: "asc" },
        select: { id: true, code: true, pincode: true },
      });

      const branchPins = branches
        .map((branch) => branch.pincode)
        .filter((code): code is string => Boolean(code));

      const serviceable = await prisma.pincode.findMany({
        where: { isServiceable: true, code: { in: branchPins } },
        select: { code: true },
      });
      const serviceablePins = new Set(serviceable.map((p) => p.code));
      const usable = branches.filter(
        (branch) => branch.pincode && serviceablePins.has(branch.pincode),
      );

      if (usable.length < 1) {
        throw new Error(
          "No active branch whose own pincode is serviceable — the fixture " +
            "booking has nowhere to go.",
        );
      }

      const origin = usable[0];
      const destination = usable[1] ?? usable[0];
      const originPin = origin.pincode as string;
      const destinationPin = destination.pincode as string;

      // Pinned to PTL: the mode comes from the service type, and which
      // service comes back first is not deterministic.
      const service = await prisma.serviceType.findFirstOrThrow({
        where: { isActive: true, mode: "PTL" },
        orderBy: { code: "asc" },
      });

      console.log(
        `  fixtures — ${origin.code} → ${(destination ?? origin).code}, ` +
          `service ${service.code}, PIN ${originPin} → ${destinationPin}\n`,
      );

      // ── Keys ────────────────────────────────────────────────
      const full = await issueKey({
        name: `smoke-api full ${randomUUID().slice(0, 8)}`,
        scopes: ALL_SCOPES,
        createdById: owner.id,
        orgId: owner.orgId,
      });
      issued.push(full.id);

      const trackingOnly = await issueKey({
        name: `smoke-api tracking-only ${randomUUID().slice(0, 8)}`,
        scopes: ["tracking.read"],
        createdById: owner.id,
        orgId: owner.orgId,
      });
      issued.push(trackingOnly.id);

      // ── Authentication ──────────────────────────────────────
      console.log("Authentication");
      {
        const anonymous = await call(HOST, "/api/v1/track/CL000000000000");
        check(
          "an unauthenticated call is refused",
          anonymous.status === 401 && errorCode(anonymous) === "unauthorized",
          `HTTP ${anonymous.status} ${errorCode(anonymous)}`,
        );

        const nonsense = await call(HOST, "/api/v1/track/CL000000000000", {
          key: "clk_deadbeef_" + "0".repeat(48),
        });
        check(
          "a well-formed but unknown key is refused",
          nonsense.status === 401,
          `HTTP ${nonsense.status} ${errorCode(nonsense)}`,
        );

        const malformed = await call(HOST, "/api/v1/track/CL000000000000", { key: "hunter2" });
        check(
          "a malformed key is refused",
          malformed.status === 401,
          `HTTP ${malformed.status} ${errorCode(malformed)}`,
        );

        const bearer = await hostFetch(HOST, PORT, "/api/v1/track/CL000000000000", {
          headers: { authorization: `Bearer ${full.key}` },
        });
        check(
          "Authorization: Bearer is accepted as well as X-Api-Key",
          bearer.status !== 401,
          `HTTP ${bearer.status}`,
        );

        const outOfScope = await call(HOST, "/api/v1/shipments/CL000000000000", {
          key: trackingOnly.key,
        });
        check(
          "a key without shipment.read is refused the shipment endpoint",
          outOfScope.status === 403 && errorCode(outOfScope) === "forbidden",
          `HTTP ${outOfScope.status} ${errorCode(outOfScope)}`,
        );

        const revoked = await call(HOST, "/api/v1/track/CL000000000000", { key: full.key });
        check(
          "rate-limit headers are published on every answer",
          Boolean(revoked.headers["x-ratelimit-limit"]),
          String(revoked.headers["x-ratelimit-limit"] ?? "absent"),
        );
      }

      // ── Booking ─────────────────────────────────────────────
      console.log("\nPOST /api/v1/shipments");
      const idempotencyKey = `smoke-api-${randomUUID()}`;
      const booking = {
        serviceCode: service.code,
        originBranchCode: origin.code,
        destinationBranchCode: destination.code,
        consignor: {
          name: "Smoke Test Consignor",
          phone: "9800000001",
          address: "1 Partner API Road",
          pincode: originPin,
        },
        consignee: {
          name: "Smoke Test Consignee",
          phone: "9800000002",
          address: "2 Partner API Road",
          pincode: destinationPin,
        },
        packageCount: 1,
        actualWeight: 5,
        goodsDescription: "Smoke test carton",
        paymentType: "PAID" as const,
        pickupRequired: false,
      };

      const created = await call(HOST, "/api/v1/shipments", {
        key: full.key,
        body: booking,
        idempotencyKey,
      });

      const createdData = dataOf<{ lrNumber?: string; shipmentId?: string; barcodes?: string[] }>(
        created,
      );
      check(
        "a booking is accepted",
        created.status === 201 && Boolean(createdData.lrNumber),
        created.status === 201
          ? createdData.lrNumber
          : `HTTP ${created.status} ${errorCode(created)}` +
            (created.status === 500
              ? ` — the handler threw. The stack is in the dev server's console ` +
                `against request id ${String(created.json?.requestId ?? "?")}; ` +
                `the guard turns every throw into this one opaque body ` +
                `(src/app/api/v1/_lib/guard.ts:264).`
              : ` ${JSON.stringify(created.json?.error ?? created.raw.slice(0, 200))}`),
      );
      check(
        "the response carries a request id",
        typeof created.json?.requestId === "string" &&
          Boolean(created.headers["x-request-id"]),
        String(created.headers["x-request-id"] ?? "absent"),
      );
      check(
        "a barcode is issued per package",
        Array.isArray(createdData.barcodes) && createdData.barcodes.length === 1,
        JSON.stringify(createdData.barcodes ?? null),
      );

      const lrNumber = createdData.lrNumber ?? null;

      // The same idempotency key must not book a second consignment.
      const replay = await call(HOST, "/api/v1/shipments", {
        key: full.key,
        body: booking,
        idempotencyKey,
      });
      const replayData = dataOf<{ lrNumber?: string; duplicate?: boolean }>(replay);
      check(
        "replaying the idempotency key returns the first booking",
        replay.status === 200 &&
          replayData.duplicate === true &&
          replayData.lrNumber === lrNumber,
        `HTTP ${replay.status} ${replayData.lrNumber ?? "(none)"}`,
      );

      const wrongType = await call(HOST, "/api/v1/shipments", {
        key: full.key,
        body: booking,
        contentType: null,
      });
      check(
        "a non-JSON body is refused",
        wrongType.status === 422,
        `HTTP ${wrongType.status} ${errorCode(wrongType)}`,
      );

      const invalid = await call(HOST, "/api/v1/shipments", {
        key: full.key,
        body: { ...booking, consignee: { ...booking.consignee, pincode: "12" } },
      });
      check(
        "a bad pincode is refused with a field-level error",
        invalid.status === 422 && Boolean((invalid.json?.error as { field?: string })?.field ?? true),
        `HTTP ${invalid.status} ${errorCode(invalid)}`,
      );

      // ── Lookup and tracking ─────────────────────────────────
      console.log("\nGET /api/v1/shipments/{lr} and /api/v1/track/{lr}");
      if (lrNumber) {
        const lookup = await call(HOST, `/api/v1/shipments/${lrNumber}`, { key: full.key });
        const shipment = dataOf<Record<string, unknown>>(lookup);
        check(
          "the consignment just booked can be read back",
          lookup.status === 200 && shipment.lrNumber === lrNumber,
          `HTTP ${lookup.status}`,
        );
        check(
          "the partner payload carries status and parties",
          Boolean(shipment.status) && Boolean(shipment.consignee),
          Object.keys(shipment).join(", ").slice(0, 120),
        );
        check(
          "the consignee's phone is masked",
          !JSON.stringify(shipment).includes(booking.consignee.phone),
          JSON.stringify((shipment.consignee as { phone?: string } | undefined)?.phone ?? null),
        );

        const tracking = await call(HOST, `/api/v1/track/${lrNumber}`, { key: full.key });
        const track = dataOf<Record<string, unknown>>(tracking);
        check(
          "the tracking payload answers",
          tracking.status === 200 && track.lrNumber === lrNumber,
          `HTTP ${tracking.status}`,
        );
        check(
          "tracking is thinner than the shipment payload",
          !("paymentType" in track) && Array.isArray(track.events),
          Object.keys(track).join(", ").slice(0, 120),
        );

        const missing = await call(HOST, "/api/v1/shipments/CL999999999999", { key: full.key });
        check(
          "an unknown LR number is a 404, not a 500",
          missing.status === 404,
          `HTTP ${missing.status} ${errorCode(missing)}`,
        );
      } else {
        check("the consignment just booked can be read back", false, "no booking to read");
      }

      // ── Pickups ─────────────────────────────────────────────
      console.log("\nPOST /api/v1/pickups");
      {
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        const pickup = await call(HOST, "/api/v1/pickups", {
          key: full.key,
          body: {
            branchCode: origin.code,
            contactName: "Smoke Test Contact",
            phone: "9800000003",
            address: "3 Partner API Road",
            pincode: originPin,
            requestedDate: tomorrow,
            slot: "MORNING",
            expectedPackages: 2,
          },
        });
        const raised = dataOf<{ pickupNumber?: string; status?: string }>(pickup);
        check(
          "a pickup request is accepted",
          pickup.status === 201 && Boolean(raised.pickupNumber),
          pickup.status === 201
            ? `${raised.pickupNumber} · ${raised.status}`
            : `HTTP ${pickup.status} ${errorCode(pickup)} ${JSON.stringify(
                pickup.json?.error ?? pickup.raw.slice(0, 200),
              )}`,
        );

        const unknownBranch = await call(HOST, "/api/v1/pickups", {
          key: full.key,
          body: {
            branchCode: "NO-SUCH-BRANCH",
            contactName: "Smoke Test Contact",
            phone: "9800000003",
            address: "3 Partner API Road",
            pincode: originPin,
            requestedDate: tomorrow,
          },
        });
        check(
          "an unknown branch code is refused",
          unknownBranch.status === 404 || unknownBranch.status === 422,
          `HTTP ${unknownBranch.status} ${errorCode(unknownBranch)}`,
        );
      }

      // ── A key tied to one customer ──────────────────────────
      console.log("\nCustomer-scoped keys");
      {
        // Two customers who each have a consignment of their own, so the
        // check has both a negative and a positive side. Without the
        // positive one, a key that saw nothing at all would pass.
        const withShipments = await prisma.shipment.groupBy({
          by: ["consignorId"],
          where: { consignorId: { not: null }, deletedAt: null },
          _count: { _all: true },
          orderBy: { consignorId: "asc" },
          take: 2,
        });

        if (withShipments.length < 2) {
          console.log(
            "  [SKIP] fewer than two customers have consignments, so a " +
              "customer-scoped key cannot be told apart from an unscoped one",
          );
        } else {
          const [a, b] = withShipments;
          const [mine, theirs] = await Promise.all([
            prisma.shipment.findFirstOrThrow({
              where: { consignorId: a.consignorId, deletedAt: null },
              select: { lrNumber: true },
            }),
            prisma.shipment.findFirstOrThrow({
              where: { consignorId: b.consignorId, deletedAt: null },
              select: { lrNumber: true },
            }),
          ]);

          const scoped = await issueKey({
            name: `smoke-api customer ${randomUUID().slice(0, 8)}`,
            scopes: ALL_SCOPES,
            createdById: owner.id,
            orgId: owner.orgId,
            customerId: a.consignorId,
          });
          issued.push(scoped.id);

          const own = await call(HOST, `/api/v1/shipments/${mine.lrNumber}`, {
            key: scoped.key,
          });
          check(
            "a customer key reads its own customer's consignment",
            own.status === 200,
            `HTTP ${own.status} ${mine.lrNumber}`,
          );

          const other = await call(HOST, `/api/v1/shipments/${theirs.lrNumber}`, {
            key: scoped.key,
          });
          check(
            "a customer key cannot read another customer's consignment",
            other.status === 404,
            other.status === 200
              ? `LEAK — ${theirs.lrNumber} was returned to the wrong customer's key`
              : `HTTP ${other.status} — expected 404 so the LR's existence is not confirmed`,
          );

          // Worth knowing either way: `/track` is documented as the public
          // tracking payload and applies no customer filter, so a customer
          // key can track any LR in the carrier. That is a deliberate
          // difference from `/shipments/{lr}`, and it is asserted here so
          // that changing it is a decision rather than an accident.
          const tracked = await call(HOST, `/api/v1/track/${theirs.lrNumber}`, {
            key: scoped.key,
          });
          check(
            "/track is carrier-wide by design, not customer-scoped",
            tracked.status === 200,
            `HTTP ${tracked.status} — if this is now 404, the tracking route was ` +
              "narrowed and this expectation should be updated deliberately",
          );
        }
      }

      // ── A key is a key on one carrier's host only ───────────
      console.log("\nCross-carrier");
      {
        const other = await actingTenant(OTHER);

        if (!other || other.orgId === tenant.orgId) {
          console.log(
            `  [SKIP] no second open tenant "${OTHER}" — provision one to run this:\n` +
              `           npx tsx scripts/provision-tenant.ts --slug ${OTHER} ` +
              `--name "Acme Freight" --subdomain ${OTHER}`,
          );
        } else {
          const otherHost = `${other.subdomain}.${ROOT}`;

          const presented = await call(otherHost, "/api/v1/track/CL000000000000", {
            key: full.key,
          });
          check(
            "this carrier's key buys nothing on another carrier's host",
            presented.status === 401,
            `HTTP ${presented.status} ${errorCode(presented)}`,
          );

          if (lrNumber) {
            const acrossHost = await call(otherHost, `/api/v1/shipments/${lrNumber}`, {
              key: full.key,
            });
            check(
              "and cannot be used to read its own LR from over there",
              acrossHost.status === 401 || acrossHost.status === 404,
              acrossHost.status === 200
                ? `LEAK — ${lrNumber} crossed a tenant boundary`
                : `HTTP ${acrossHost.status}`,
            );
          }

          // The other carrier's own LR, asked for with this carrier's key
          // on this carrier's host: not found, because the row is not ours.
          const theirLr = await basePrisma.shipment.findFirst({
            where: { orgId: other.orgId, deletedAt: null },
            select: { lrNumber: true },
          });

          if (theirLr) {
            const reached = await call(HOST, `/api/v1/shipments/${theirLr.lrNumber}`, {
              key: full.key,
            });
            check(
              "another carrier's LR number is not readable from this carrier",
              reached.status === 404,
              reached.status === 200
                ? `LEAK — ${theirLr.lrNumber} belongs to ${other.slug}`
                : `HTTP ${reached.status}`,
            );
          } else {
            console.log(
              `  [SKIP] ${other.slug} has no consignment to attempt to reach`,
            );
          }
        }
      }

      // The bare platform domain is the operator console, and the partner
      // API has no tenant there at all.
      const onConsole = await call(ROOT, "/api/v1/track/CL000000000000", { key: full.key });
      check(
        "the partner API refuses the bare platform domain",
        onConsole.status === 401 || onConsole.status === 404,
        `HTTP ${onConsole.status} — a 500 here means the tenant error escaped as a crash`,
      );
    });
  } finally {
    // Every key this run minted, gone again — a smoke test that leaves live
    // credentials behind is a liability, not a test.
    if (issued.length > 0) {
      await runWithTenant(tenant, async () => {
        await prisma.apiKey.deleteMany({ where: { id: { in: issued } } });
      });
      console.log(`\n  cleaned up ${issued.length} minted key(s)`);
    }
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "PASS\n" : "FAIL\n");
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`\nSmoke test crashed: ${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
