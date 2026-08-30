import { z } from "zod";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { nextNumber } from "@/lib/numbering/number-series";
import { recordAudit } from "@/server/services/audit";
import { coversBranch } from "@/server/repositories/scope";
import { normalisePhone } from "@/lib/bulk/validate";
import { withApiKey, ok, fail } from "../_lib/guard";
import { fieldErrors, readJson } from "../_lib/respond";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/pickups — ask us to collect.
 *
 * Two shapes are accepted, because both are real: a collection against an
 * LR already booked, and a blind request raised before the customer knows
 * what they are shipping. The second is why `lrNumber` is optional and why
 * an address is required in its absence.
 */

const schema = z.object({
  /** Collect an existing booking. Omit for a blind pickup. */
  lrNumber: z.string().trim().max(40).nullish(),
  branchCode: z.string().trim().min(1).max(20),

  contactName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(10).max(20),
  address: z.string().trim().min(4).max(300),
  pincode: z.string().trim().regex(/^\d{6}$/, "Six digits"),
  landmark: z.string().trim().max(120).nullish(),

  requestedDate: z.iso.date("Use YYYY-MM-DD"),
  slot: z.enum(["MORNING", "AFTERNOON", "EVENING", "ANYTIME"]).default("ANYTIME"),
  expectedPackages: z.number().int().min(1).max(9999).nullish(),
  expectedWeight: z.number().min(0).max(30000).nullish(),
  goodsDescription: z.string().trim().max(300).nullish(),
  notes: z.string().trim().max(300).nullish(),
});

export async function POST(request: Request): Promise<Response> {
  return withApiKey(request, "pickup.create", async (api) => {
    const body = await readJson(request);
    if (!body.ok) return fail("invalid_request", body.message, api.requestId);

    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
      return fail("invalid_request", "Check the fields listed.", api.requestId, {
        fields: fieldErrors(parsed.error),
      });
    }

    const input = parsed.data;
    const phone = normalisePhone(input.phone);
    if (!/^\d{10}$/.test(phone)) {
      return fail("invalid_request", "Phone must be 10 digits.", api.requestId, {
        field: "phone",
      });
    }

    const branch = await prisma.branch.findFirst({
      where: { code: input.branchCode, isActive: true, deletedAt: null },
      select: { id: true, code: true },
    });
    if (!branch) {
      return fail("invalid_request", "Unknown branch code.", api.requestId, {
        field: "branchCode",
      });
    }
    if (!coversBranch(api.actor, branch.id)) {
      return fail(
        "forbidden",
        "That branch is outside the scope of this key.",
        api.requestId,
      );
    }

    // The city comes from the PIN master rather than from the request, so
    // a caller cannot pair a Jaipur PIN with a Delhi city and quietly
    // route the collection to the wrong branch.
    // Serviceability is a fact about a carrier, not about the PIN, so this
    // has to be the calling key's own master — and `orgId` is written out
    // for the same reason as in the sibling routes: on a key with no
    // customer attached it is the only thing bounding the lookup.
    const pincode = await prisma.pincode.findFirst({
      where: { orgId: api.key.orgId, code: input.pincode },
      select: { cityId: true, isServiceable: true },
    });
    if (!pincode) {
      return fail("invalid_request", "PIN not in the network.", api.requestId, {
        field: "pincode",
      });
    }
    if (!pincode.isServiceable) {
      return fail("invalid_request", "PIN not serviceable.", api.requestId, {
        field: "pincode",
      });
    }

    let shipmentId: string | null = null;
    if (input.lrNumber) {
      // A partner key with no customer attached is deliberately
      // organisation-wide, so on that branch the `orgId` filter is the only
      // thing bounding the lookup and is written out rather than left to the
      // tenant extension. Matches the shipments and track routes.
      const owner = api.key.customerId
        ? { consignorId: api.key.customerId }
        : {};

      const shipment = await prisma.shipment.findFirst({
        where: {
          orgId: api.key.orgId,
          lrNumber: input.lrNumber.trim(),
          deletedAt: null,
          ...owner,
        },
        select: { id: true },
      });
      if (!shipment) {
        return fail("not_found", "No shipment with that LR number.", api.requestId, {
          field: "lrNumber",
        });
      }
      shipmentId = shipment.id;
    }

    const created = await tenantTransaction(async (tx) => {
      // Numbered inside the transaction, so a request that fails to save
      // does not consume a number.
      const number = await nextNumber(
        { document: "PICKUP" },
        tx,
      );

      return tx.pickupRequest.create({
        data: {
          orgId: api.actor.orgId,
          number,
          branchId: branch.id,
          shipmentId: shipmentId ?? undefined,
          customerId: api.key.customerId ?? undefined,
          contactName: input.contactName,
          phone,
          address: input.address,
          cityId: pincode.cityId,
          pincode: input.pincode,
          landmark: input.landmark ?? undefined,
          requestedDate: new Date(`${input.requestedDate}T00:00:00.000Z`),
          slot: input.slot,
          expectedPackages: input.expectedPackages ?? undefined,
          expectedWeight: input.expectedWeight ?? undefined,
          goodsDescription: input.goodsDescription ?? undefined,
          notes: input.notes ?? undefined,
          createdById: api.actor.id,
        },
        select: {
          id: true,
          number: true,
          status: true,
          requestedDate: true,
          slot: true,
        },
      });
    });

    await recordAudit({
      user: api.actor,
      action: "CREATE",
      entity: "PickupRequest",
      entityId: created.id,
      entityRef: created.number,
      branchId: branch.id,
      after: { via: "api/v1", apiKey: api.key.keyPrefix, lrNumber: input.lrNumber },
    });

    return ok(
      {
        pickupNumber: created.number,
        status: created.status,
        requestedDate: created.requestedDate.toISOString().slice(0, 10),
        slot: created.slot,
      },
      api.requestId,
      { status: 201 },
    );
  });
}
