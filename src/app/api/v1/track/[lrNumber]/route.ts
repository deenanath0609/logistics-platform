import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  PUBLIC_EVENT_SELECT,
  PUBLIC_SHIPMENT_SELECT,
  toPublicTracking,
} from "@/lib/webhooks/public-payload";
import { withApiKey, ok, fail } from "../../_lib/guard";

export const dynamic = "force-dynamic";

const lrSchema = z.string().trim().min(4).max(40).regex(/^[A-Za-z0-9/-]+$/);

/**
 * GET /api/v1/track/:lrNumber — the payload a partner may show anyone.
 *
 * This is the response that ends up embedded in a customer's own website,
 * so it is deliberately thinner than the shipment endpoint: status,
 * cities, dates, package count and the event history. No branch, no
 * vehicle, no driver, no staff member, no money, and no contact details.
 * `toPublicTracking` is the single place that decides that, and a test
 * asserts the result contains none of the forbidden keys.
 *
 * Thin is not the same as unowned: the lookup is by LR number, which is
 * only unique within a carrier, so it is filtered to the organisation that
 * issued the key. The tenant extension already scopes it — and the key row
 * itself is tenant-scoped, so a key can only authenticate on its own
 * carrier's host — but the filter is written out here because an LR number
 * arriving from the internet is exactly the input that must never be able
 * to reach across carriers.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ lrNumber: string }> },
): Promise<Response> {
  return withApiKey(request, "tracking.read", async (api) => {
    const { lrNumber } = await context.params;

    const parsed = lrSchema.safeParse(lrNumber);
    if (!parsed.success) {
      return fail("invalid_request", "That is not a valid LR number.", api.requestId, {
        field: "lrNumber",
      });
    }

    const shipment = await prisma.shipment.findFirst({
      where: { orgId: api.key.orgId, lrNumber: parsed.data, deletedAt: null },
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
    return ok(toPublicTracking(rest, events), api.requestId, {
      // Tracking is high volume and the answer is the same for everyone
      // asking in the same minute.
      headers: { "Cache-Control": "private, max-age=30" },
    });
  });
}
