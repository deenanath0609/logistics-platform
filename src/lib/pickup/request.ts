import { z } from "zod";
import { tenantTransaction } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { nextNumber } from "@/lib/numbering/number-series";

/**
 * Raising a collection by hand.
 *
 * Three things raise a pickup, and only two of them used to be reachable: a
 * booking raises its own, and the portal raises one for a customer who is
 * signed in. The third is the consignor who telephones the branch, and for
 * that there was a validated, audited server action with no caller anywhere
 * in the product — no screen, no script, nothing.
 *
 * The validation and the write live here rather than in the action so that
 * both the screen and `verify-pickup-cycle.ts` go through the same code,
 * which is how `execute.ts` is arranged and for the same reason: a path
 * only the browser can reach is a path the suite cannot prove.
 *
 * A pickup raised this way carries no consignment. That is not a gap — it
 * is the case `PickupRequest.shipmentId` was made nullable for. The goods
 * are described over the telephone, and the paperwork is written when they
 * arrive at the branch.
 */

const optional = (max = 200) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable(),
  );

/**
 * Exactly what the create dialog posts.
 *
 * `requestedDate` arrives from an `<input type="date">` as `YYYY-MM-DD`,
 * which JavaScript parses at UTC midnight — which is what a `date` column
 * stores. Handing it a local midnight instead would land it on the previous
 * day at any positive offset; `asStoredDate` in `execute.ts` exists for that
 * and explains it at length.
 */
export const pickupRequestSchema = z.object({
  shipmentId: optional(40),
  customerId: optional(40),
  branchId: z.string().min(1, "Choose a branch"),
  contactName: z.string().trim().min(2, "Required").max(120),
  phone: z.string().trim().regex(/^\d{10}$/, "Ten digits"),
  address: z.string().trim().min(4, "Required").max(300),
  cityId: z.string().min(1, "Choose a city"),
  pincode: z.string().trim().regex(/^\d{6}$/, "Six digits"),
  landmark: optional(120),
  requestedDate: z.coerce.date({ message: "Enter a valid date" }),
  slot: z.enum(["MORNING", "AFTERNOON", "EVENING", "ANYTIME"]),
  priority: z.coerce.number().int().min(0).max(9),
  expectedPackages: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().int().min(1).nullable(),
  ),
  expectedWeight: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0).nullable(),
  ),
  goodsDescription: optional(300),
  notes: optional(300),
});

export type PickupRequestInput = z.infer<typeof pickupRequestSchema>;

export type RaisePickupResult =
  | { ok: true; id: string; number: string; branchId: string }
  | { ok: false; error: string };

export async function raisePickupRequest(
  input: PickupRequestInput,
  actor: SessionUser,
): Promise<RaisePickupResult> {
  if (!can(actor, "pickup.create")) {
    return { ok: false, error: "You do not have permission to raise pickups." };
  }
  if (!coversBranch(actor, input.branchId)) {
    return { ok: false, error: "That branch is outside your scope." };
  }

  const created = await tenantTransaction(async (tx) => {
    // Numbered inside the transaction, so an abandoned request does not
    // consume a number.
    const number = await nextNumber({ document: "PICKUP" }, tx);

    return tx.pickupRequest.create({
      data: { ...input, number, orgId: actor.orgId, createdById: actor.id },
      select: { id: true, number: true, branchId: true },
    });
  });

  return { ok: true, ...created };
}
