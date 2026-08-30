import { NextResponse, type NextRequest } from "next/server";
import {
  clearedImpersonationCookie,
  consoleUrl,
  grantIdFromCookie,
} from "@/lib/platform/impersonation-session";
import { endGrantFromTenant } from "@/lib/platform/impersonation";

/**
 * The banner's "end session" button, on the carrier's host.
 *
 * The order matters and is the point of requirement five: the **grant** is
 * ended first, and the cookie is cleared afterwards. Clearing the cookie
 * alone would leave a live grant behind — still open in the console, still
 * usable by anyone holding a copy of the token — which is a session that
 * looks ended and is not.
 *
 * POST because it changes something, and a plain HTML form so the button
 * works before any JavaScript has loaded. A banner whose escape hatch
 * depends on hydration is not an escape hatch.
 */
export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest): Promise<NextResponse> {
  const grantId = await grantIdFromCookie();

  // A grant that has already ended or expired is not an error here — the
  // operator asked to leave and they are leaving. The service returns a
  // failure in that case and it is deliberately ignored; the cookie still
  // goes.
  if (grantId) await endGrantFromTenant(grantId);

  // 303 so the browser turns the POST into a GET on the console's host.
  const response = NextResponse.redirect(await consoleUrl(), 303);
  const cookie = clearedImpersonationCookie();
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
