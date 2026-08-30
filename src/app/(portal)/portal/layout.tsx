import { notFound } from "next/navigation";
import { getTenantModules } from "@/lib/modules/tenant-modules";

/**
 * The portal's outermost layout, and the only thing it does is decide
 * whether the portal exists here at all.
 *
 * It sits above `login` and `password` as well as `(app)`, because a
 * sign-in form for a product the carrier does not sell is the same leak as
 * the product itself.
 *
 * **A 404, not the "not on your plan" page.** The two refusals are for two
 * different readers. Everywhere else in the app the reader is the carrier's
 * own staff, who can go and ask whoever manages their subscription. Here
 * the reader is the carrier's *customer* — a consignor waiting on a
 * delivery. They cannot act on it, and telling them their carrier buys this
 * platform from somebody would break the white-labelling this product is
 * built around (ADR 001 §3). On a carrier without the portal module, the
 * portal simply is not there.
 *
 * Layers one and two do not reach this: portal logins are `CustomerUser`
 * rows on their own session, so narrowing a staff permission set covers
 * nothing here, and the `portal` module deliberately owns no permissions.
 * This is the only lock.
 */
export default async function PortalModuleGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const modules = await getTenantModules();
  if (!modules.has("portal")) notFound();

  return <>{children}</>;
}
