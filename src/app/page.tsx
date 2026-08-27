import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentCustomerUser } from "@/lib/auth/customer-session";

export default async function RootPage() {
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
