import { createHash } from "node:crypto";
import { prisma, type DbOrTx } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { requireTenantOrgId } from "@/lib/tenant";
import { buildObjectKey, getObjectStore } from "@/lib/storage";
import { ACCEPTED_CAPTURE_TYPES, parseDataUrl } from "./data-url";
import type { FileKind } from "@/generated/prisma/client";

/**
 * Field capture storage.
 *
 * A signature and a delivery photograph are evidence: they settle a claim
 * eighteen months later, so they are written before the delivery is
 * confirmed and never regenerated.
 *
 * Where the bytes actually go is `@/lib/storage`'s problem. This module
 * decides *what* is worth storing and records the pointer; callers below it
 * only ever see a `FileAsset.id`.
 */

/** A phone photo compressed on-device should be far under this. */
const MAX_BYTES = 5 * 1024 * 1024;

export type StoredAsset = {
  id: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
};

export type StoreAssetInput = {
  kind: FileKind;
  bytes: Buffer;
  contentType: string;
  fileName: string;
  /** e.g. ("Shipment", shipmentId) — what this evidence belongs to. */
  ownerEntity: string;
  ownerId: string;
  orgId?: string | null;
  uploadedById?: string | null;
  /** Device clock at the moment of capture, not upload. */
  capturedAt?: Date | null;
  latitude?: number | null;
  longitude?: number | null;
};

/**
 * Writes bytes and records the pointer.
 *
 * The checksum is stored so a resynced duplicate can be recognised, and so
 * a file that changes on disk can be proved to have changed.
 */
export async function storeAsset(
  input: StoreAssetInput,
  client: DbOrTx = prisma,
): Promise<StoredAsset> {
  if (input.bytes.byteLength === 0) {
    throw new Error("Refusing to store an empty file.");
  }
  if (input.bytes.byteLength > MAX_BYTES) {
    throw new Error(
      `That file is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB — compress it on the device first.`,
    );
  }

  // Resolved before the key rather than after the write, because the key
  // now begins with it: the tenant is part of where the bytes live, not a
  // column recorded alongside them.
  //
  // This is the one write in the module with no actor and no parent row to
  // take the tenant from — a caller may hand one in (they all do today), and
  // the request's own tenant is the honest answer when none arrives.
  const orgId = input.orgId ?? (await requireTenantOrgId());

  const objectKey = buildObjectKey({
    orgId,
    kind: input.kind,
    ownerId: input.ownerId,
    fileName: input.fileName,
    contentType: input.contentType,
  });
  const checksum = createHash("sha256").update(input.bytes).digest("hex");

  await getObjectStore().put({
    key: objectKey,
    bytes: input.bytes,
    contentType: input.contentType,
  });

  const asset = await client.fileAsset.create({
    data: {
      orgId,
      kind: input.kind,
      bucket: getEnv().S3_BUCKET,
      objectKey,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      checksum,
      ownerEntity: input.ownerEntity,
      ownerId: input.ownerId,
      capturedAt: input.capturedAt ?? undefined,
      latitude: input.latitude ?? undefined,
      longitude: input.longitude ?? undefined,
      uploadedById: input.uploadedById ?? undefined,
    },
    select: { id: true, objectKey: true, sizeBytes: true, contentType: true },
  });

  return asset;
}

/**
 * Stores a `data:` URL — how the signature canvas and the compressed photo
 * arrive from the field app.
 *
 * Returns null for an absent value so callers can pass an optional capture
 * straight through without branching.
 */
export async function storeDataUrl(
  dataUrl: string | null | undefined,
  input: Omit<StoreAssetInput, "bytes" | "contentType" | "fileName"> & {
    fileName: string;
  },
  client: DbOrTx = prisma,
): Promise<StoredAsset | null> {
  if (!dataUrl) return null;

  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new Error(
      `That capture is not a readable image. Send it as ${[...ACCEPTED_CAPTURE_TYPES].join(", ")}.`,
    );
  }

  return storeAsset(
    {
      ...input,
      bytes: parsed.bytes,
      contentType: parsed.contentType,
      fileName: input.fileName,
    },
    client,
  );
}

// Which types a capture may be is a policy, not a storage detail, so it
// lives in its own module and is tested there. Re-exported because callers
// have always reached it through this one.
export {
  parseDataUrl,
  isAcceptedCaptureType,
  ACCEPTED_CAPTURE_TYPES,
} from "./data-url";

