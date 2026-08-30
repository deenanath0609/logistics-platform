import { NextResponse, type NextRequest } from "next/server";
import {
  grantIsUsable,
  impersonationCookie,
  loadOpenGrant,
  readHandoffToken,
} from "@/lib/platform/impersonation-session";
import { recordGrantEntry } from "@/lib/platform/impersonation";
import { orgForHost } from "@/lib/tenant/resolve";

/**
 * Where a support session is actually entered.
 *
 * This route runs on the **carrier's** host, not the console's, and that
 * is the entire reason it exists: the console cannot set a host-only
 * cookie on `acme.<root>` from `admin.<root>`, so the operator's browser
 * carries a one-minute hand-off token here and trades it for the session
 * cookie in a single response.
 *
 * It holds no business logic — verify, exchange, audit, redirect — and
 * every one of those steps re-reads the grant row rather than believing
 * the token. In particular the organisation is taken from the **host**
 * and the grant is checked against it, so a link minted for one carrier
 * and replayed on another's subdomain lands on a 404 rather than on a
 * downgraded session.
 *
 * Deliberately not deletable-by-accident: it lives in the `(platform)`
 * route group but outside `platform/layout.tsx`, whose
 * `requirePlatformHost()` would 404 it on the only host it may run on.
 */
export const dynamic = "force-dynamic";

function refuse(): NextResponse {
  // One answer for every failure — expired, ended, forged, wrong carrier —
  // because distinguishing them here would tell a stranger with a stale
  // link which of those was true.
  return new NextResponse(
    "That support session link is not valid. Open a new session from the operator console.",
    { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get("t");

  const grantId = await readHandoffToken(token);
  if (!grantId) return refuse();

  const grant = await loadOpenGrant(grantId);
  if (!grant) return refuse();

  const org = await orgForHost(request.headers.get("host"));
  if (!org) return refuse();
  if (org.status === "CLOSED") return refuse();
  if (!grantIsUsable(grant, org.id)) return refuse();

  const cookie = await impersonationCookie(grant);
  if (!cookie) return refuse();

  // Recorded before the redirect leaves, so the trail says "entered" even
  // if the operator closes the tab on the next page.
  await recordGrantEntry(grant);

  // The token is spent here and never appears in the app's own URLs again:
  // the redirect target carries nothing.
  const response = NextResponse.redirect(new URL("/dashboard", request.url));
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
