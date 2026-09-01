"use server";
import { SHIPMENT_MODE_VALUES } from "@/lib/shipment/modes";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { createBooking, type BookingChargeInput } from "@/lib/shipment/booking";

export type BookingFormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
};

const optional = (max = 200) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable(),
  );

const phone = (label: string) =>
  z.string().trim().regex(/^\d{10}$/, `${label} must be 10 digits`);

const pincode = (label: string) =>
  z.string().trim().regex(/^\d{6}$/, `${label} must be 6 digits`);

const schema = z.object({
  mode: z.enum(SHIPMENT_MODE_VALUES),
  serviceTypeId: z.string().min(1, "Choose a service"),
  originBranchId: z.string().min(1, "Choose an origin"),
  destinationBranchId: z.string().min(1, "Choose a destination"),

  consignorId: optional(40),
  consignorName: z.string().trim().min(2, "Required").max(120),
  consignorCompany: optional(120),
  consignorPhone: phone("Consignor phone"),
  consignorEmail: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().email("Enter a valid email").nullable(),
  ),
  consignorAddress: z.string().trim().min(4, "Required").max(300),
  consignorCityId: z.string().min(1, "Choose a city"),
  consignorPincode: pincode("Consignor PIN"),
  consignorGstin: optional(20),

  consigneeName: z.string().trim().min(2, "Required").max(120),
  consigneeCompany: optional(120),
  consigneePhone: phone("Consignee phone"),
  consigneeEmail: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().email("Enter a valid email").nullable(),
  ),
  consigneeAddress: z.string().trim().min(4, "Required").max(300),
  consigneeCityId: z.string().min(1, "Choose a city"),
  consigneePincode: pincode("Consignee PIN"),
  consigneeLandmark: optional(120),
  consigneeGstin: optional(20),

  packageCount: z.coerce.number().int().min(1, "At least one package").max(9999),
  packageTypeId: optional(40),
  actualWeight: z.coerce.number().positive("Enter the weight"),
  declaredValue: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0).nullable(),
  ),
  goodsDescription: z.string().trim().min(2, "Describe the goods").max(300),
  specialInstructions: optional(300),
  isFragile: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),

  paymentType: z.enum(["PAID", "TO_PAY", "TBB", "COD"]),
  codAmount: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0).nullable(),
  ),
  isReverseCharge: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),

  customerReference: optional(60),
  ewayBillNumber: optional(30),
  invoiceNumber: optional(40),
  invoiceValue: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0).nullable(),
  ),
  pickupRequired: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),
});

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Charge lines arrive as `charge:<chargeTypeId>` inputs. Only non-zero
 * amounts become rows — a booking screen listing fourteen charge heads
 * should not write fourteen zero-value lines.
 */
async function readCharges(formData: FormData): Promise<BookingChargeInput[]> {
  const entries = [...formData.entries()].filter(
    ([key, value]) => key.startsWith("charge:") && Number(value) > 0,
  );
  if (entries.length === 0) return [];

  const chargeTypeIds = entries.map(([key]) => key.slice("charge:".length));
  const chargeTypes = await prisma.chargeType.findMany({
    where: { id: { in: chargeTypeIds } },
    include: { taxRate: { select: { id: true, ratePercent: true } } },
  });
  const byId = new Map(chargeTypes.map((c) => [c.id, c]));

  return entries.flatMap(([key, value]) => {
    const chargeType = byId.get(key.slice("charge:".length));
    if (!chargeType) return [];

    const amount = Number(value);
    return [
      {
        chargeTypeId: chargeType.id,
        basis: "FLAT" as const,
        rate: amount,
        quantity: 1,
        amount,
        taxRateId: chargeType.taxRate?.id ?? null,
        taxPercent: chargeType.taxRate
          ? Number(chargeType.taxRate.ratePercent)
          : null,
        isManual: true,
      },
    ];
  });
}

export async function bookShipment(
  _prev: BookingFormState,
  formData: FormData,
): Promise<BookingFormState> {
  let destination: string;

  try {
    const actor = await authorize("shipment.create");

    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const data = parsed.data;

    /**
     * The origin is the one branch on this form the clerk does not get to
     * choose freely.
     *
     * `originBranchId` arrives as form data, and the select used to list
     * every branch in the network, so a Gurugram booking clerk could raise
     * a consignment whose origin is the Jaipur hub. That is not a harmless
     * mislabel: the shipment appears on Jaipur's list as freight they are
     * expected to have taken in, the pickup goes to the Gurugram address,
     * and no scan will ever reconcile the two. The destination stays open —
     * a consignment is addressed to wherever it is going.
     *
     * Checked here rather than in `createBooking` because the service has
     * four callers and only this one lets a person pick. The portal derives
     * both branches from the account and the PIN codes, the bulk importer
     * checks the file's rows, and the partner API books against the key.
     */
    if (!coversBranch(actor, data.originBranchId)) {
      return {
        error: "You can only book at a branch you work at.",
        fieldErrors: { originBranchId: "Outside the branches you cover" },
      };
    }

    // Where the booking was *taken*, which is this clerk's own counter.
    // Falling back to the origin is for a network-scoped user with no home
    // branch, and that origin has just been checked.
    const bookingBranchId = actor.primaryBranch?.id ?? data.originBranchId;
    if (!coversBranch(actor, bookingBranchId)) {
      return { error: "You can only book at a branch you work at." };
    }

    /**
     * The account being billed, if one was named.
     *
     * The picker is scoped — `page.tsx` filters the customer list by
     * `branchScope` — but `consignorId` arrives as form data like anything
     * else, and `createBooking` only asks whether the account can carry the
     * charge, never whose account it is. So posting another branch's
     * customer id billed that branch's credit account for freight it never
     * handed over, and the consignment then showed on that customer's
     * portal. The same reasoning as the origin branch above: checked here
     * because this is the only caller where a person picks.
     */
    if (data.consignorId) {
      const consignor = await prisma.customer.findUnique({
        where: { id: data.consignorId },
        select: { branchId: true },
      });
      if (!consignor) {
        return {
          error: "That customer account no longer exists.",
          fieldErrors: { consignorId: "Not found" },
        };
      }
      // An account with no owning branch belongs to the network, and only a
      // network-scoped user sees it — the same rule `/customers` applies on
      // both its list and its detail page.
      const inScope =
        actor.branchIds === null ||
        (consignor.branchId !== null && coversBranch(actor, consignor.branchId));
      if (!inScope) {
        return {
          error: "That customer account is outside the branches you cover.",
          fieldErrors: { consignorId: "Out of scope" },
        };
      }
    }

    const charges = await readCharges(formData);

    const result = await createBooking(
      { ...data, bookingBranchId, charges },
      actor,
    );

    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    revalidatePath("/shipments");
    destination = `/shipments/${result.shipmentId}?booked=1`;
  } catch (error) {
    if (error instanceof PermissionError) {
      return { error: "You do not have permission to book shipments." };
    }
    console.error("[booking action]", error);
    return { error: "Booking failed. Nothing was saved." };
  }

  // Outside the try: redirect works by throwing, and catching it here
  // would turn a successful booking into an error message.
  redirect(destination);
}
