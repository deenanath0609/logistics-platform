"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ConsoleFormState } from "@/components/platform/form-bits";
import { endGrant, enterUrlFor } from "@/lib/platform/impersonation";
import {
  authorizeOperator,
  PlatformAuthError,
  PlatformPermissionError,
} from "@/lib/platform/session";

/**
 * Ending a support session early.
 *
 * Any operator holding `impersonate` may end anyone's session, not only
 * their own: somebody noticing an open session into a customer they are
 * not working with has to be able to shut it there and then, and the audit
 * row records who did.
 */
export async function endSupportSession(
  grantId: string,
  _prev: ConsoleFormState,
  _formData: FormData,
): Promise<ConsoleFormState> {
  try {
    const actor = await authorizeOperator("impersonate");
    const result = await endGrant(grantId, actor);
    if (!result.ok) return { error: result.error };

    revalidatePath("/platform/impersonation");
    revalidatePath("/platform");
    return { ok: true, message: "Session ended." };
  } catch (error) {
    if (error instanceof PlatformPermissionError) {
      return { error: "Your operator role cannot manage support sessions." };
    }
    if (error instanceof PlatformAuthError) return { error: error.message };
    console.error("[platform:impersonation]", error);
    return { error: "Something went wrong. The session was not ended." };
  }
}

/**
 * Walking into the carrier's app.
 *
 * The action does nothing but gate on the capability, ask the service for
 * a link, and send the browser there. Every rule about *whether* this
 * operator may enter *this* grant lives in `enterUrlFor`, so a second
 * caller cannot be written that skips them.
 *
 * `redirect()` is called outside the `try`. It works by throwing a
 * control-flow signal, and a `catch` here would swallow it and report a
 * fault that did not happen.
 */
export async function enterSupportSession(
  grantId: string,
  _prev: ConsoleFormState,
  _formData: FormData,
): Promise<ConsoleFormState> {
  let url: string;

  try {
    const actor = await authorizeOperator("impersonate");
    const result = await enterUrlFor(grantId, actor);
    if (!result.ok) return { error: result.error };
    url = result.data;
  } catch (error) {
    if (error instanceof PlatformPermissionError) {
      return { error: "Your operator role cannot enter support sessions." };
    }
    if (error instanceof PlatformAuthError) return { error: error.message };
    console.error("[platform:impersonation]", error);
    return { error: "Something went wrong. The session was not entered." };
  }

  // Absolute and on another origin — the carrier's subdomain — because the
  // session cookie has to be set there and nowhere else.
  redirect(url);
}
