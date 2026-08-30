import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PATHNAME_HEADER } from "@/lib/request-path";
import { getTenantModules } from "@/lib/modules/tenant-modules";
import { moduleGateFor, notOnPlanHref } from "@/lib/modules/refusal";

/**
 * Layer three: refuse the URL.
 *
 * Narrowing the session's permissions already covers every screen whose
 * permission belongs to the module (`getCurrentUser`), and the nav already
 * declines to draw the link. Neither is enough on its own. A screen can be
 * guarded by a permission that core owns while living inside a module that
 * was not bought — `/delivery/cod` is read with `delivery.read`, and
 * `/masters/sla-policies` with `master.read` — and a link nobody drew is
 * still a URL anybody can type.
 *
 * Called from the ops layout, so it covers every screen underneath it,
 * including ones written after this file.
 */
export async function requireModuleForPath(): Promise<void> {
  const pathname = await currentPathname();

  // Not a soft failure. The header comes from `src/proxy.ts`, which runs on
  // every non-static request; its absence means the proxy was deleted,
  // renamed or excluded by its matcher. Carrying on would silently unlock
  // every gated screen in the product, so this breaks loudly on the first
  // page load instead of quietly forever.
  if (pathname === null) {
    throw new Error(
      "Module gating cannot read the request path. src/proxy.ts must stamp " +
        `the ${PATHNAME_HEADER} header on every request that renders a layout.`,
    );
  }

  const gate = moduleGateFor(pathname, await getTenantModules());
  if (!gate.allowed) redirect(notOnPlanHref(gate.module));
}

/** The stamped path, or null when there is no request to read one from. */
async function currentPathname(): Promise<string | null> {
  try {
    return (await headers()).get(PATHNAME_HEADER);
  } catch {
    return null;
  }
}
