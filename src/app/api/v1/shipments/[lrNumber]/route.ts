import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  PUBLIC_EVENT_SELECT,
  PUBLIC_SHIPMENT_SELECT,
  toPartnerShipment,
} from "@/lib/webhooks/public-payload";
import { withApiKey, ok, fail } from "../../_lib/guard";

export const dynamic = "force-dynamic";

const lrSchema = z.string().trim().min(4).max(40).regex(/^[A-Za-z0-9/-]+$/);

/**
 * GET /api/v1/shipments/:lrNumber — status for the partner who booked it.
 *
 * Two kinds of key reach this endpoint and they see different things. A key
 * issued against a customer is that customer's integration and sees only
 * consignments they sent. A key issued without one belongs to the carrier's
 * own systems — their ERP or middleware — and sees the whole organisation.
 * Neither sees past the organisation that issued the key.
 *
 * An LR outside that scope answers 404 rather than 403: telling a caller
 * that a number exists but is not theirs is itself a disclosure.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ lrNumber: string }> },
): Promise<Response> {
  return withApiKey(request, "shipment.read", async (api) => {
    const { lrNumber } = await context.params;

    const parsed = lrSchema.safeParse(lrNumber);
    if (!parsed.success) {
      return fail("invalid_request", "That is not a valid LR number.", api.requestId, {
        field: "lrNumber",
      });
    }

    // An unattached key is deliberately organisation-wide, so the `orgId`
    // filter is the only thing bounding it and is written out rather than
    // left to the tenant extension: this is the one branch where losing
    // tenant context would otherwise mean no ownership filter at all. An
    // LR number is unique per carrier, never globally.
    const owner = api.key.customerId
      ? { consignorId: api.key.customerId }
      : {};

    const shipment = await prisma.shipment.findFirst({
      where: {
        orgId: api.key.orgId,
        lrNumber: parsed.data,
        deletedAt: null,
        ...owner,
      },
      select: {
        ...PUBLIC_SHIPMENT_SELECT,
        events: {
          orderBy: { occurredAt: "asc" },
          take: 100,
          select: PUBLIC_EVENT_SELECT,
        },
      },
    });

    if (!shipment) {
      return fail("not_found", "No shipment with that LR number.", api.requestId);
    }

    const { events, ...rest } = shipment;
    return ok(toPartnerShipment(rest, events), api.requestId);
  });
}
