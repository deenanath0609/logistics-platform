"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ConsoleFormState } from "@/components/platform/form-bits";
import {
  authorizeOperator,
  PlatformAuthError,
  PlatformPermissionError,
} from "@/lib/platform/session";
import { provisionTenant, type ProvisionInput } from "@/lib/platform/provisioning";
import {
  HANDOFF_COOKIE,
  HANDOFF_MAX_AGE_SECONDS,
  encodeHandoff,
} from "./handoff";

/**
 * Creating a carrier, from the console.
 *
 * Same three steps as every other action here — gate on a capability, hand
 * the work to a service, revalidate — plus one thing none of the others
 * has to do: carry a generated password to the next screen.
 */

function describe(error: unknown): string {
  if (error instanceof PlatformPermissionError) {
    return "Only an owner may provision a carrier.";
  }
  if (error instanceof PlatformAuthError) return error.message;
  console.error("[platform:provision]", error);
  return "Something went wrong. No tenant was created.";
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function optional(formData: FormData, key: string): string | null {
  return text(formData, key) || null;
}

function readInput(formData: FormData): ProvisionInput {
  return {
    name: text(formData, "name"),
    legalName: optional(formData, "legalName"),
    slug: text(formData, "slug"),
    subdomain: text(formData, "subdomain"),
    lrPrefix: text(formData, "lrPrefix"),
    planId: optional(formData, "planId"),
    templateOrgId: text(formData, "templateOrgId"),
    branch: {
      code: text(formData, "branchCode"),
      name: text(formData, "branchName"),
      city: text(formData, "branchCity"),
      address: text(formData, "branchAddress"),
      pincode: text(formData, "branchPincode"),
      phone: optional(formData, "branchPhone"),
    },
    owner: {
      name: text(formData, "ownerName"),
      mobile: text(formData, "ownerMobile"),
      email: optional(formData, "ownerEmail"),
    },
  };
}

export async function provisionTenantAction(
  _prev: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  let orgId: string;

  try {
    const actor = await authorizeOperator("tenant.write");

    const result = await provisionTenant(readInput(formData), actor);
    if (!result.ok) return { error: result.error };

    orgId = result.data.orgId;

    /*
      The owner's password exists in exactly one place after this — the
      bcrypt hash on their user row — and has to reach the detail page the
      operator is about to land on.

      A query parameter is out: it would be in the browser history, in any
      proxy log, and in the `Referer` of the next request. A module-level
      map is out too: the console runs behind more than one instance, and
      an operator whose redirect lands elsewhere would lose the only copy
      of a password nothing can regenerate.

      So it goes in a short-lived, host-only, path-scoped, httpOnly cookie
      that the browser hands back exactly once to the page that renders it.
      The page offers a "hide this" control that deletes it; ten minutes
      deletes it anyway.
    */
    const store = await cookies();
    store.set(HANDOFF_COOKIE, encodeHandoff(orgId, result.data.ownerPassword), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/platform",
      maxAge: HANDOFF_MAX_AGE_SECONDS,
    });
  } catch (error) {
    return { error: describe(error) };
  }

  revalidatePath("/platform/tenants");
  revalidatePath("/platform");
  // Outside the try: `redirect` signals by throwing, and catching it here
  // would turn a provisioned tenant into "something went wrong".
  redirect(`/platform/tenants/${orgId}`);
}

/** Clears the one-time password panel once the operator says they have it. */
export async function dismissOwnerPassword(
  orgId: string,
  _prev: ConsoleFormState,
  _formData: FormData,
): Promise<ConsoleFormState> {
  try {
    await authorizeOperator("tenant.read");
    const store = await cookies();
    store.delete({ name: HANDOFF_COOKIE, path: "/platform" });
  } catch (error) {
    return { error: describe(error) };
  }

  revalidatePath(`/platform/tenants/${orgId}`);
  return { ok: true };
}
