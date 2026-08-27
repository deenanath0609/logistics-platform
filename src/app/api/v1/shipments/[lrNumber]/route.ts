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
 * A key tied to a customer sees only that customer's consignments, and an
 * LR belonging to somebody else answers 404 rather than 403: telling a
 * caller that a number exists but is not theirs is itself a disclosure.
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

    const shipment = await prisma.shipment.findFirst({
      where: {
        lrNumber: parsed.data,
        deletedAt: null,
        ...(api.key.customerId ? { consignorId: api.key.customerId } : {}),
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
