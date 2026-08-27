import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentCustomerUser } from "@/lib/auth/customer-session";
import { getPortalInvoiceAsset } from "@/lib/portal/billing";

/**
 * One invoice PDF, for the account it belongs to.
 *
 * The asset id is never taken from the URL. It is resolved from the
 * *invoice* id through `getPortalInvoiceAsset`, which carries the account
 * in its WHERE clause — so a guessed invoice id gets a 404, and there is
 * no path at all by which one account's login reaches another's document.
 *
 * TODO(storage): becomes a redirect to a short-lived signed URL
 * (`SIGNED_URL_TTL_SECONDS`) once the S3 adapter exists, instead of
 * streaming bytes through the app server.
 */

const STORAGE_ROOT = path.join(process.cwd(), "storage");

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

  // The key is generated server-side, but a traversal check costs nothing
  // and this handler reads from the filesystem.
  const destination = path.join(STORAGE_ROOT, asset.objectKey);
  if (!destination.startsWith(STORAGE_ROOT)) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const bytes = await readFile(destination);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": asset.contentType,
        "Content-Disposition": `inline; filename="${invoice.number.replace(/[^\w.-]/g, "-")}.pdf"`,
        // Private: an invoice must not sit in a shared cache.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    // The row exists but the bytes do not — a document still queued for
    // rendering.
    return new NextResponse("Not yet available", { status: 404 });
  }
}
