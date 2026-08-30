import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentCustomerUser } from "@/lib/auth/customer-session";
import { getPortalInvoiceAsset } from "@/lib/portal/billing";
import { readTenantObject, tenantObjectUrl } from "@/lib/storage";

/**
 * One invoice PDF, for the account it belongs to.
 *
 * The asset id is never taken from the URL. It is resolved from the
 * *invoice* id through `getPortalInvoiceAsset`, which carries the account
 * in its WHERE clause — so a guessed invoice id gets a 404, and there is
 * no path at all by which one account's login reaches another's document.
 *
 * That was already true of the lookup and remains the load-bearing check.
 * What is new is the layer under it: the object key itself now begins with
 * the tenant, and `readTenantObject` refuses a key whose prefix is not this
 * request's organisation. So a `documentAssetId` that somehow pointed at
 * another carrier's file — a bad backfill, a hand-written UPDATE — reads as
 * "not there" instead of as a PDF.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const session = await getCurrentCustomerUser();
  if (!session) return new NextResponse("Not allowed", { status: 403 });

  const { invoiceId } = await params;

  const invoice = await getPortalInvoiceAsset(session, invoiceId);
  if (!invoice) return new NextResponse("Not found", { status: 404 });

  const asset = await prisma.fileAsset.findUnique({
    where: { id: invoice.documentAssetId },
    select: { objectKey: true, contentType: true, deletedAt: true },
  });
  if (!asset || asset.deletedAt) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Null with the filesystem backend, and the fallback below is what runs.
  // When the object store can hand the browser a URL of its own, this
  // becomes the live path with no other change here.
  const direct = await tenantObjectUrl(asset.objectKey);
  if (direct) return NextResponse.redirect(direct, 302);

  const bytes = await readTenantObject(asset.objectKey);
  if (!bytes) {
    // The row exists but the bytes do not — a document still queued for
    // rendering.
    return new NextResponse("Not yet available", { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": asset.contentType,
      "Content-Disposition": `inline; filename="${invoice.number.replace(/[^\w.-]/g, "-")}.pdf"`,
      // Private: an invoice must not sit in a shared cache.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
