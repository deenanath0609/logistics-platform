import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FileKind } from "@/generated/prisma/client";

/**
 * Object keys, and why the tenant is the first segment of one.
 *
 * A key used to read `pod/<shipmentId>/<uuid>.jpg`: every carrier's proof of
 * delivery in one tree, told apart only by which row happened to point at
 * which path. That made the key a bearer token for anybody who could name
 * it, and it made "this file belongs to that carrier" a fact recorded
 * nowhere but the database.
 *
 * The tenant now leads:
 *
 *     <orgId>/<folder>/<ownerId>/<uuid><ext>
 *
 * Two things follow, and they are the whole point:
 *
 *  - A key that leaks — in a log line, an error page, a support ticket —
 *    still cannot name another carrier's file, because the segment that
 *    would have to change is checked against the tenant doing the reading.
 *  - The backing store partitions by tenant for free. On the filesystem
 *    that is a directory per carrier; on S3 it is a prefix, which is also
 *    the unit an IAM policy and a lifecycle rule are written against, so
 *    the S3 adapter inherits the isolation rather than reimplementing it.
 *
 * The tenant prefix is a *second* line of defence, never the first. The
 * first is that the row naming the key was read through the tenant-scoped
 * client and checked against the record in the URL. Both are cheap; a leak
 * needs both to fail.
 */

/** One path segment: no separators, no `..`, nothing shell- or URL-shaped. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The first segments the old, un-partitioned layout could produce.
 *
 * A closed set, because `folderFor()` below is the only thing that ever
 * wrote one. It is how a legacy key is recognised without guessing at the
 * shape of a cuid. Delete this — and the `null` branch of
 * `objectKeyOrgId()` — once `scripts/migrate-storage-keys.ts` has run on
 * every deployment.
 */
const LEGACY_ROOTS = new Set(["pod", "damage", "misc"]);

export class UnsafeObjectKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`Refusing object key ${JSON.stringify(key)}: ${reason}`);
    this.name = "UnsafeObjectKeyError";
  }
}

export class CrossTenantObjectError extends Error {
  constructor(orgId: string, key: string) {
    super(
      `Object key ${JSON.stringify(key)} does not belong to organisation ${orgId}.`,
    );
    this.name = "CrossTenantObjectError";
  }
}

/** The folder a kind of file lives in, inside the tenant's prefix. */
export function folderFor(kind: FileKind): string {
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

export function extensionFor(contentType: string, fileName: string): string {
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

export type BuildObjectKeyInput = {
  orgId: string;
  kind: FileKind;
  /** The record the file is evidence for — a shipment, a batch. */
  ownerId: string;
  fileName: string;
  contentType: string;
};

/**
 * The key for a new object.
 *
 * The filename is never carried through: it is attacker-influenced on an
 * upload, and `FileAsset.fileName` already holds what to call the file when
 * it is handed back. Only the extension survives, and only from a fixed
 * list or from `path.extname`, which cannot produce a separator.
 */
export function buildObjectKey(input: BuildObjectKeyInput): string {
  const key = [
    input.orgId,
    folderFor(input.kind),
    input.ownerId,
    `${randomUUID()}${extensionFor(input.contentType, input.fileName)}`,
  ].join("/");

  assertSafeObjectKey(key);
  return key;
}

/**
 * Every segment is a plain name.
 *
 * This replaces the `destination.startsWith(STORAGE_ROOT)` check the two
 * routes used to do, which was weaker in both directions: it accepted
 * `../..` sequences that happened to normalise back inside the root, and on
 * a sibling directory named `storage-old` a prefix match would have said
 * yes. Validating the key means the backend never has to reason about
 * paths at all.
 */
export function assertSafeObjectKey(key: string): void {
  if (!key || key.length > 512) {
    throw new UnsafeObjectKeyError(key, "empty or absurdly long");
  }
  const segments = key.split("/");
  if (segments.length < 2) {
    throw new UnsafeObjectKeyError(key, "a key needs at least a prefix and a name");
  }
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      throw new UnsafeObjectKeyError(key, `segment ${JSON.stringify(segment)} is not a plain name`);
    }
  }
}

export function isSafeObjectKey(key: string): boolean {
  try {
    assertSafeObjectKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * The organisation a key names, or null when the key predates partitioning.
 *
 * Null is not "any tenant" — it is "this key says nothing", which callers
 * must handle deliberately rather than by defaulting.
 */
export function objectKeyOrgId(key: string): string | null {
  const first = key.split("/")[0];
  if (!first || LEGACY_ROOTS.has(first)) return null;
  return first;
}

/** True for a key still in the old un-partitioned layout. */
export function isLegacyObjectKey(key: string): boolean {
  return objectKeyOrgId(key) === null;
}

/**
 * The guard a reader calls before touching bytes.
 *
 * A legacy key is allowed through, and that is a deliberate, temporary
 * hole with a floor under it: the only way to reach this function is with a
 * `FileAsset` row already read through the tenant-scoped client, so the row
 * was the tenant's even when the key cannot say so. Migrating the keys
 * closes the hole; until then the check degrades to what it was before
 * rather than to nothing.
 */
export function assertObjectKeyBelongsTo(orgId: string, key: string): void {
  assertSafeObjectKey(key);
  const owner = objectKeyOrgId(key);
  if (owner !== null && owner !== orgId) {
    throw new CrossTenantObjectError(orgId, key);
  }
}
