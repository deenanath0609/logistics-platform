import { getCurrentUser, can } from "@/lib/auth/session";
import { buildTemplateCsv, templateFilename } from "@/lib/bulk/template";
import { currentTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * The blank booking template.
 *
 * Generated on request from the same column declaration the validator
 * reads, rather than served from a file in `public/`. A checked-in
 * template is a copy, and a copy goes stale — this one cannot.
 */
export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  if (!user || !can(user, "shipment.bulk_upload")) {
    return new Response("Forbidden", { status: 403 });
  }

  return new Response(buildTemplateCsv(), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${templateFilename(currentTenant()?.slug)}"`,
      "Cache-Control": "no-store",
    },
  });
}
