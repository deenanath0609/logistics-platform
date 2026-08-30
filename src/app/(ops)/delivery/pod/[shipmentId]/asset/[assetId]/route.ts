import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, can } from "@/lib/auth/session";
import { anyBranchScope } from "@/server/repositories/scope";
import { readTenantObject, tenantObjectUrl } from "@/lib/storage";

/**
 * Serves one piece of proof of delivery.
 *
 * Signatures and delivery photographs are not public files — they show a
 * person's front door and their handwriting — so they are never written
 * under `public/`. Every read comes through here, and the handler answers
 * three separate questions before it touches a byte:
 *
 *  1. May this user read proof of delivery at all, and is the shipment
 *     within their branch scope?
 *  2. Does the *record* named in the URL claim this asset? The POD row for
 *     the shipment lists its own evidence; an id that is not one of those
 *     is not this shipment's, whoever owns it.
 *  3. Does the object key belong to this tenant? — `readTenantObject`.
 *
 * The second question is the one this handler used to get wrong. It read
 * the asset by id and compared `asset.ownerId !== shipmentId`: both halves
 * came from the same URL, so they agreed exactly when the attacker wanted
 * them to, and the guard's doc comment claimed a protection the code did
 * not provide. Tenant scoping on `FileAsset` was carrying the whole thing
 * alone. It still is the outer wall; this is now a wall of its own rather
 * than a picture of one.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ shipmentId: string; assetId: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !can(user, "pod.read")) {
    return new NextResponse("Not allowed", { status: 403 });
  }

  const { shipmentId, assetId } = await params;

  const pod = await prisma.pod.findFirst({
    where: {
      shipmentId,
      // Branch visibility only. Tenant isolation comes from the top-level
      // `where` the Prisma extension rewrites, not from this nested clause
      // — ADR 001's amendment is explicit that a relation filter is never
      // the thing keeping tenants apart. Mirrors the POD page: a proof is
      // visible at the origin, at the destination, and wherever the goods
      // currently sit.
      shipment: anyBranchScope(user, [
        "originBranchId",
        "currentBranchId",
        "destinationBranchId",
      ]),
    },
    select: {
      signatureAssetId: true,
      photoAssetId: true,
      documentAssetId: true,
      assets: { select: { fileAssetId: true } },
    },
  });

  if (!pod) return new NextResponse("Not found", { status: 404 });

  const claimed = new Set(
    [
      pod.signatureAssetId,
      pod.photoAssetId,
      pod.documentAssetId,
      ...pod.assets.map((asset) => asset.fileAssetId),
    ].filter((id): id is string => Boolean(id)),
  );

  if (!claimed.has(assetId)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const asset = await prisma.fileAsset.findUnique({
    where: { id: assetId },
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
    // The row exists but the bytes do not — an asset captured before the
    // storage volume was attached, or one still queued on a phone.
    return new NextResponse("Not yet uploaded", { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      // The stored type is echoed back, and the stored type is whatever the
      // capturing device declared — so it is only ever as trustworthy as
      // the allowlist in `lib/delivery/data-url.ts` that let it be written.
      // The two headers below are what makes that allowlist load-bearing
      // rather than advisory, and they cost nothing if it holds:
      //
      //  - `nosniff` stops the browser second-guessing the type and
      //    rendering bytes as markup because they happen to start with `<`.
      //  - `attachment` means an asset opened directly is downloaded, not
      //    executed on the carrier's own origin with the viewer's session.
      //    The POD page is unaffected: it reads these bytes through an
      //    `<img>`, which ignores Content-Disposition entirely.
      "Content-Type": asset.contentType,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="pod-${assetId}"`,
      // Private: proof of delivery must not sit in a shared cache.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
