"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  authorizeCustomer,
  canWrite,
  CustomerAuthError,
} from "@/lib/auth/customer-session";
import { cancelPortalPickup, createPortalPickup } from "@/lib/portal/pickups";

export type PickupState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

const PATH = "/portal/pickups";

const schema = z.object({
  addressId: z.string().min(1, "Choose an address"),
  requestedDate: z.coerce.date({ message: "Choose a date" }),
  slot: z.enum(["MORNING", "AFTERNOON", "EVENING", "ANYTIME"]),
  expectedPackages: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().int().min(1).max(9999).nullable(),
  ),
  expectedWeight: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z.number().min(0).nullable(),
  ),
  goodsDescription: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300).nullable(),
  ),
  notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300).nullable(),
  ),
});

/** Today's local calendar day, rebuilt at UTC midnight — see below. */
function storedToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
  );
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export async function requestPickup(
  _prev: PickupState,
  formData: FormData,
): Promise<PickupState> {
  try {
    const session = await authorizeCustomer();
    if (!canWrite(session)) {
      return { error: "Your login can view pickups but not raise them." };
    }

    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return {
        error: "Check the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    // A collection cannot be asked for in the past.
    //
    // `requestedDate` arrives from `<input type="date">` as `YYYY-MM-DD`,
    // which JavaScript parses at UTC midnight — and UTC midnight is what
    // the `@db.Date` column stores. The floor has to be built the same
    // way, which is what `storedToday` does and what
    // `new Date(); setHours(0,0,0,0)` does not: that is *local* midnight,
    // an instant that only happens to sort correctly against a stored date
    // because this deployment runs at or east of UTC. On a box behind UTC
    // it lands after the stored date for the same day and refuses today.
    //
    // The half of this that was actually failing was the form, not the
    // floor — see the note on `today` in `pickup-form.tsx`, where the
    // default value was the UTC calendar day and so read as yesterday all
    // night in IST. Both sides are now built from the same local day, and
    // the point of writing the floor this way is that the two can be
    // compared at all.
    //
    // `asStoredDate` in `lib/pickup/execute.ts` is the same trick.
    if (parsed.data.requestedDate < storedToday()) {
      return {
        error: "Choose today or a later date.",
        fieldErrors: { requestedDate: "Not in the past" },
      };
    }

    const result = await createPortalPickup(session, parsed.data);
    if (!result.ok) {
      return {
        error: result.error,
        fieldErrors: result.field ? { [result.field]: result.error } : undefined,
      };
    }

    revalidatePath(PATH);
    revalidatePath("/portal");
    return { ok: true, message: `Pickup ${result.number} requested.` };
  } catch (error) {
    if (error instanceof CustomerAuthError) {
      return { error: "Your session has expired. Sign in again." };
    }
    console.error("[portal pickup]", error);
    return { error: "Something went wrong. Nothing was saved." };
  }
}

export async function cancelPickup(
  _prev: PickupState,
  formData: FormData,
): Promise<PickupState> {
  try {
    const session = await authorizeCustomer();
    if (!canWrite(session)) {
      return { error: "Your login cannot cancel pickups." };
    }

    const id = String(formData.get("id") ?? "");
    if (!id) return { error: "Nothing selected." };

    const result = await cancelPortalPickup(session, id);
    if (!result.ok) return { error: result.error };

    revalidatePath(PATH);
    revalidatePath("/portal");
    return { ok: true, message: `Pickup ${result.number} cancelled.` };
  } catch (error) {
    if (error instanceof CustomerAuthError) {
      return { error: "Your session has expired. Sign in again." };
    }
    console.error("[portal pickup cancel]", error);
    return { error: "Something went wrong." };
  }
}
