import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentCustomerUser } from "@/lib/auth/customer-session";
import { getEnv } from "@/lib/env";
import { isPlatformHost } from "@/lib/tenant/host";

export default async function RootPage() {
  // On the console's dedicated host there is no tenant to land on, so `/`
  // belongs to the console. Without this, typing `admin.<domain>` sent an
  // operator to the tenant login, which 404s there because `admin` resolves
  // to no carrier — a blank dead end at the address they were given.
  //
  // Not on the bare platform domain: in development that host is a carrier
  // too, and the console is one path away at `/platform`.
  const host = (await headers()).get("host");
  if (isPlatformHost(host, getEnv().APP_ROOT_DOMAIN)) redirect("/platform");

  // Staff and portal customers share a cookie shape but resolve against
  // different tables, so both have to be asked. Checking only staff sent a
  // signed-in customer back to the staff login.
  const [staff, customer] = await Promise.all([
    getCurrentUser(),
    getCurrentCustomerUser(),
  ]);

  if (staff) redirect("/dashboard");
  if (customer) redirect("/portal");
  redirect("/login");
}
