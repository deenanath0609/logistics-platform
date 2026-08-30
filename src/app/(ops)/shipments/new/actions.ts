"use server";
import { SHIPMENT_MODE_VALUES } from "@/lib/shipment/modes";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authorize, PermissionError } from "@/lib/auth/session";
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
    const charges = await readCharges(formData);

    const result = await createBooking(
      {
        ...data,
        bookingBranchId: actor.primaryBranch?.id ?? data.originBranchId,
        charges,
      },
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
