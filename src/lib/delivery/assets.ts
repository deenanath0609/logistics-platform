import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import type { FileKind, Prisma } from "@/generated/prisma/client";

/**
 * Field capture storage.
 *
 * A signature and a delivery photograph are evidence: they settle a claim
 * eighteen months later, so they are written before the delivery is
 * confirmed and never regenerated.
 *
 * TODO(phase-5, storage): this writes bytes to the local filesystem under
 * `/storage` and records the path as the `FileAsset.objectKey`. The S3/MinIO
 * adapter is not built yet — `S3_ENDPOINT` and friends are already in the
 * environment schema waiting for it. When it lands, replace `putObject`
 * below with the real client and backfill existing rows by streaming
 * `/storage/<objectKey>` into the bucket; nothing else in this module or
 * its callers changes, because callers only ever see a `FileAsset.id`.
 */

/** Where the local stopgap writes. Sits outside `public/` on purpose:
 *  proof of delivery is not world-readable. */
const STORAGE_ROOT = path.join(process.cwd(), "storage");

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
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<StoredAsset> {
  if (input.bytes.byteLength === 0) {
    throw new Error("Refusing to store an empty file.");
  }
  if (input.bytes.byteLength > MAX_BYTES) {
    throw new Error(
      `That file is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB — compress it on the device first.`,
    );
  }

  const extension = extensionFor(input.contentType, input.fileName);
  const objectKey = `${folderFor(input.kind)}/${input.ownerId}/${randomUUID()}${extension}`;
  const checksum = createHash("sha256").update(input.bytes).digest("hex");

  await putObject(objectKey, input.bytes);

  const asset = await client.fileAsset.create({
    data: {
      orgId: input.orgId ?? undefined,
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
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<StoredAsset | null> {
  if (!dataUrl) return null;

  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new Error("That capture is not a readable image.");
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

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i;

export function parseDataUrl(
  value: string,
): { contentType: string; bytes: Buffer } | null {
  const match = DATA_URL.exec(value.trim());
  if (!match) return null;

  // Only images. A field capture is a photograph or an ink signature;
  // accepting anything else would make this an upload endpoint.
  if (!match[1].startsWith("image/")) return null;

  try {
    return { contentType: match[1], bytes: Buffer.from(match[2], "base64") };
  } catch {
    return null;
  }
}

/** The local stopgap. Replaced wholesale by the S3 adapter — see the TODO. */
async function putObject(objectKey: string, bytes: Buffer): Promise<void> {
  const destination = path.join(STORAGE_ROOT, objectKey);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

function folderFor(kind: FileKind): string {
  switch (kind) {
    case "POD_SIGNATURE":
    case "POD_PHOTO":
    case "PACKAGE_PHOTO":
      return "pod";
    case "DAMAGE_PHOTO":
      return "damage";
    default:
      return "misc";
  }
}

function extensionFor(contentType: string, fileName: string): string {
  const fromName = path.extname(fileName).toLowerCase();
  if (fromName) return fromName;

  switch (contentType) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/jpeg":
      return ".jpg";
    default:
      return "";
  }
}
