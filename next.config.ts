import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

/**
 * The tenant domains this deployment serves.
 *
 * `acme.example.com` for a carrier, the bare domain for the operator
 * console — which is why both the wildcard and the root appear. In
 * development the port is part of the host, so `localhost:3010` and
 * `acme.localhost:3010` are what a browser actually sends.
 */
const rootDomain = process.env.APP_ROOT_DOMAIN ?? "localhost";
const devPort = process.env.PORT ?? "3010";

const allowedOrigins = isProduction
  ? [rootDomain, `*.${rootDomain}`]
  : [
      rootDomain,
      `*.${rootDomain}`,
      `${rootDomain}:${devPort}`,
      `*.${rootDomain}:${devPort}`,
    ];

/**
 * Content Security Policy.
 *
 * What had to be allowed, and why — because the interesting part of a CSP
 * is its holes, and an undocumented hole gets copied forward forever:
 *
 *  - `style-src 'unsafe-inline'`. The root layout injects the tenant's
 *    palette as a `<style>` block after the stylesheet, the POD and invoice
 *    print sheets carry their own `@media print` rules, and React writes
 *    `style` attributes throughout. A nonce cannot cover the last of those
 *    at all, so the directive would be theatre.
 *  - `script-src 'unsafe-inline'`. Next inlines its own bootstrap and
 *    flight payload on every server-rendered page. The alternative is a
 *    per-request nonce from the proxy, which forces every page out of
 *    static rendering — a real cost for a defence that `'unsafe-inline'`
 *    only partially weakens here, since there is no user-authored HTML
 *    rendered anywhere in this app. Revisit it together with a nonce.
 *  - `script-src 'unsafe-eval'`, development only. React Refresh needs it.
 *  - `img-src https:`. Carrier logos and favicons are absolute URLs the
 *    platform operator types in, pointing at whatever CDN that carrier
 *    uses. Narrowing this means hosting them, which is a product change.
 *    It is also exactly why `Referrer-Policy` below is not the default.
 *  - `connect-src ws:`, development only, for hot reload.
 *
 * `frame-ancestors 'none'` is the one that does real work today: nothing
 * in this product is meant to be framed, and clickjacking an operations
 * console is how a despatch clerk cancels a consignment by accident.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${isProduction ? "" : " ws: wss:"}`,
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Belt and braces with `frame-ancestors`, for anything still reading it.
  { key: "X-Frame-Options", value: "DENY" },
  {
    /**
     * Not the browser default, deliberately.
     *
     * `logoUrl` and `faviconUrl` are tenant-controlled absolute URLs
     * rendered into every page of that tenant's app, including the
     * authenticated ones. Under the default policy every one of those page
     * views sends its origin to whatever host the carrier nominated — and
     * on a shared platform the carrier nominating the host is not always
     * the carrier being watched. `same-origin` sends a referrer to us and
     * to nobody else.
     *
     * `no-referrer` would be one step stronger and would break the
     * product: per Fetch, a "no-referrer" policy also nulls the `Origin`
     * header on non-GET requests, and that header is the whole of Next's
     * CSRF check on Server Actions. "same-origin" nulls `Origin` only when
     * the request is genuinely cross-origin, which is the case we want
     * refused anyway.
     */
    key: "Referrer-Policy",
    value: "same-origin",
  },
  {
    // Geolocation stays on: the field app stamps a delivery with where it
    // was captured, and a POD without a location is worth less in a claim.
    // Camera likewise, for `<input capture>` on the photo control.
    key: "Permissions-Policy",
    value:
      "geolocation=(self), camera=(self), microphone=(), payment=(), usb=(), magnetometer=(), gyroscope=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isProduction
    ? [
        {
          // Two years, subdomains included — a carrier's subdomain is where
          // the sessions are. Not `preload`: that is a commitment to a
          // browser vendor which is not this file's to make.
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pg", "bullmq", "ioredis"],
  // Typed routes are off deliberately: list screens build hrefs from search
  // and pagination state (`${pathname}?${params}`), which typed routes
  // cannot express without a cast at every call site.
  typedRoutes: false,

  experimental: {
    /**
     * The origins a Server Action may be invoked from.
     *
     * Worth being precise about what this does, because it is easy to read
     * as a tightening and it is not one. Next allows an action when the
     * `Origin` header matches the request's host — and behind a proxy
     * "the host" means `X-Forwarded-Host`, a header this process cannot
     * verify — *or* when the origin appears in this list. The list only
     * ever widens.
     *
     * It is set anyway, and set narrowly, because it names the hosts this
     * deployment actually serves. That keeps actions working when a proxy
     * terminates on a different name, and it means the allowance is a
     * deliberate, reviewable list rather than an accident of whatever
     * header arrived. The forged-`X-Forwarded-Host` case is not closed by
     * anything here; it is closed at the proxy, which must overwrite the
     * forwarding headers rather than append to them — the same
     * configuration `TRUSTED_PROXY_HOPS` depends on.
     */
    serverActions: { allowedOrigins },
  },

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
