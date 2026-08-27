"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  authorizeCustomer,
  canWrite,
  CustomerAuthError,
} from "@/lib/auth/customer-session";
import {
  createPortalBooking,
  recordPortalBookingAuthor,
} from "@/lib/portal/booking";

export type PortalBookingState = {
  error?: string;
  fieldErrors?: Record<string, string>;
};

const optional = (max = 200) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable(),
  );

const schema = z.object({
  // The one consignor field a customer may choose — and it is an id into
  // their own address book, not free text.
  pickupAddressId: z.string().min(1, "Choose where we should collect from"),

  mode: z.enum(["FTL", "PTL", "COURIER"]),
  serviceTypeId: z.string().min(1, "Choose a service"),

  consigneeName: z.string().trim().min(2, "Required").max(120),
  consigneeCompany: optional(120),
  consigneePhone: z.string().trim().regex(/^\d{10}$/, "Ten digits"),
  consigneeEmail: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().email("Enter a valid email").nullable(),
  ),
  consigneeAddress: z.string().trim().min(4, "Required").max(300),
  consigneeCityId: z.string().min(1, "Choose a city"),
  consigneePincode: z.string().trim().regex(/^\d{6}$/, "Six digits"),
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
  isFragile: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true"),

  paymentType: z.enum(["PAID", "TO_PAY", "COD"]),
  codAmount: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0).nullable(),
  ),

  customerReference: optional(60),
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

export async function bookFromPortal(
  _prev: PortalBookingState,
  formData: FormData,
): Promise<PortalBookingState> {
  let destination: string;

  try {
    const session = await authorizeCustomer();

    // A VIEWER login may look at everything the account has and change
    // none of it.
    if (!canWrite(session)) {
      return { error: "Your login can view shipments but not book them." };
    }

    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const result = await createPortalBooking(session, parsed.data);

    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    await recordPortalBookingAuthor(session, result.shipmentId, result.lrNumber);

    revalidatePath("/portal/shipments");
    revalidatePath("/portal");
    destination = `/portal/shipments/${result.shipmentId}`;
  } catch (error) {
    if (error instanceof CustomerAuthError) {
      return { error: "Your session has expired. Sign in again." };
    }
    console.error("[portal booking]", error);
    return { error: "Booking failed. Nothing was saved." };
  }

  // Outside the try: `redirect` works by throwing, and catching it here
  // would turn a successful booking into an error message.
  redirect(destination);
}
