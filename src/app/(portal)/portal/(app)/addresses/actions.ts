"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  authorizeCustomer,
  canWrite,
  CustomerAuthError,
  type CustomerSession,
} from "@/lib/auth/customer-session";
import { customerOwnedFilter } from "@/lib/portal/visibility";

export type AddressState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

const PATH = "/portal/addresses";

const optional = (max = 200) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable(),
  );

const schema = z.object({
  label: z.string().trim().min(1, "Give it a name").max(60),
  kind: z.enum(["PICKUP", "DELIVERY", "BILLING"]),
  contactName: optional(120),
  phone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().regex(/^\d{10}$/, "Ten digits").nullable(),
  ),
  address: z.string().trim().min(4, "Required").max(300),
  cityId: z.string().min(1, "Choose a city"),
  pincode: z.string().trim().regex(/^\d{6}$/, "Six digits"),
  landmark: optional(120),
  isDefault: z
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
 * Confirms an address id belongs to the signed-in account.
 *
 * Returns the id rather than a boolean so the caller has to use the
 * checked value, not the one that came off the form.
 */
async function ownAddressId(
  session: CustomerSession,
  id: string,
): Promise<string | null> {
  const row = await prisma.customerAddress.findFirst({
    where: { id, ...customerOwnedFilter(session) },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function saveAddress(
  _prev: AddressState,
  formData: FormData,
): Promise<AddressState> {
  try {
    const session = await authorizeCustomer();
    if (!canWrite(session)) {
      return { error: "Your login can view addresses but not change them." };
    }

    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const postedId = String(formData.get("id") ?? "");
    const data = parsed.data;

    let savedId: string;

    if (postedId) {
      const id = await ownAddressId(session, postedId);
      if (!id) return { error: "That address no longer exists." };

      await prisma.customerAddress.update({ where: { id }, data });
      savedId = id;
    } else {
      // `customerId` comes from the session, never from the form. There is
      // no way to spell "someone else's account" here.
      const created = await prisma.customerAddress.create({
        data: { ...data, ...customerOwnedFilter(session) },
        select: { id: true },
      });
      savedId = created.id;
    }

    // Only one default per kind, or the booking screen has to guess.
    if (data.isDefault) {
      await prisma.customerAddress.updateMany({
        where: {
          ...customerOwnedFilter(session),
          kind: data.kind,
          id: { not: savedId },
        },
        data: { isDefault: false },
      });
    }

    revalidatePath(PATH);
    revalidatePath("/portal/book");
    return { ok: true, message: postedId ? "Address updated." : "Address added." };
  } catch (error) {
    if (error instanceof CustomerAuthError) {
      return { error: "Your session has expired. Sign in again." };
    }
    console.error("[portal address]", error);
    return { error: "Something went wrong. Nothing was saved." };
  }
}

/**
 * Retires an address rather than deleting it — shipments and pickup
 * requests point at these rows, and history must not lose its addresses.
 */
export async function retireAddress(
  _prev: AddressState,
  formData: FormData,
): Promise<AddressState> {
  try {
    const session = await authorizeCustomer();
    if (!canWrite(session)) {
      return { error: "Your login cannot change addresses." };
    }

    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected." };

    const result = await prisma.customerAddress.updateMany({
      where: { id, ...customerOwnedFilter(session) },
      data: { isActive: false, isDefault: false },
    });

    if (result.count === 0) return { error: "That address no longer exists." };

    revalidatePath(PATH);
    return { ok: true, message: "Address removed." };
  } catch (error) {
    if (error instanceof CustomerAuthError) {
      return { error: "Your session has expired. Sign in again." };
    }
    console.error("[portal address retire]", error);
    return { error: "Something went wrong." };
  }
}
