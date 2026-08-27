import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, can } from "@/lib/auth/session";

/**
 * Serves one piece of proof of delivery.
 *
 * Signatures and delivery photographs are not public files — they show a
 * person's front door and their handwriting — so they are never written
 * under `public/`. Every read goes through this handler, which checks the
 * permission and that the asset actually belongs to the shipment in the
 * URL, so a guessed id gets nothing.
 *
 * TODO(phase-5, storage): once the S3 adapter exists this becomes a
 * redirect to a short-lived signed URL (`SIGNED_URL_TTL_SECONDS`) instead
 * of streaming bytes through the app server.
 */

const STORAGE_ROOT = path.join(process.cwd(), "storage");

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ shipmentId: string; assetId: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !can(user, "pod.read")) {
    return new NextResponse("Not allowed", { status: 403 });
  }

  const { shipmentId, assetId } = await params;

  const asset = await prisma.fileAsset.findUnique({
    where: { id: assetId },
    select: {
      objectKey: true,
      contentType: true,
      ownerEntity: true,
      ownerId: true,
      deletedAt: true,
    },
  });

  if (
    !asset ||
    asset.deletedAt ||
    asset.ownerEntity !== "Shipment" ||
    asset.ownerId !== shipmentId
  ) {
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
        // Private: proof of delivery must not sit in a shared cache.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    // The row exists but the bytes do not — an asset captured before the
    // storage volume was attached, or one still queued on a phone.
    return new NextResponse("Not yet uploaded", { status: 404 });
  }
}
