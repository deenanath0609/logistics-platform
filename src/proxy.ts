import { NextResponse, type NextRequest } from "next/server";
import { PATHNAME_HEADER } from "@/lib/request-path";

/**
 * The one thing that runs before every render: it writes the requested path
 * onto the request headers.
 *
 * Tenancy is deliberately *not* resolved here. The host is read inside the
 * request instead (`tenant/resolve.ts`), where the resolution is cached and
 * a database is available; doing it in the proxy would put a query in front
 * of every static-ish request and duplicate the boundary ADR 001 puts on the
 * host. This file stays free of authentication, tenancy and any database
 * access on purpose — it copies one string.
 *
 * It exists because module gating has to happen in a server layout, and a
 * server layout cannot otherwise learn its own URL. If this file is deleted,
 * `requireModuleForPath()` throws rather than quietly letting every gated
 * screen through.
 */
export default function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATHNAME_HEADER, request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except build output and files with an extension. Route
  // handlers under /api are included: they render no layout, so the guard
  // does not run there, but stamping them costs nothing and keeps the
  // header's meaning uniform.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
