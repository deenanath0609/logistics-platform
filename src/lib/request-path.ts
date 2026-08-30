/**
 * The header the requested path travels on, server-side.
 *
 * Next's App Router gives a layout its `params` and nothing else — there is
 * no server-side `usePathname`, and no built-in header carries the path on
 * an initial document request (`next-url` appears only on client-side
 * navigations, so relying on it would gate a screen on the second visit and
 * not the first). A guard that has to answer "which module owns this
 * screen?" therefore needs the path put somewhere it can read, which is what
 * `src/proxy.ts` does and the only reason that file exists.
 *
 * Nothing else lives in this module on purpose. It is imported by the proxy,
 * which is bundled for the edge runtime, so a single `next/headers` import
 * anywhere in its graph would be dragged in with it. Reading the header is
 * `currentPathname()` in `modules/guard.ts` instead.
 */
export const PATHNAME_HEADER = "x-pathname";
