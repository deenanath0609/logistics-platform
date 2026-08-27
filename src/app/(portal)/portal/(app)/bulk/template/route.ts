import { getCurrentCustomerUser } from "@/lib/auth/customer-session";
import { buildTemplateCsv } from "@/lib/bulk/template";

export const dynamic = "force-dynamic";

/**
 * The blank booking template, for a portal customer.
 *
 * The same file the branch counter downloads, generated on request from
 * the same column declaration the validator reads. A second, customer-only
 * copy would be a copy, and a copy goes stale.
 *
 * Guarded by the portal session rather than by a staff permission:
 * `can()` does not compile against a `CustomerSession`, and that is the
 * point of the split.
 */
export async function GET(): Promise<Response> {
  const customer = await getCurrentCustomerUser();
  if (!customer) return new Response("Forbidden", { status: 403 });

  return new Response(buildTemplateCsv(), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="city-logistics-booking-template.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
