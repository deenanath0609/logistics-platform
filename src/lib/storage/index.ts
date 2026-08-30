import path from "node:path";
import { getEnv } from "@/lib/env";
import { requireTenantOrgId } from "@/lib/tenant";
import { assertObjectKeyBelongsTo } from "@/lib/storage/keys";
import {
  FilesystemObjectStore,
  type ObjectStore,
} from "@/lib/storage/object-store";

export {
  buildObjectKey,
  assertObjectKeyBelongsTo,
  assertSafeObjectKey,
  isSafeObjectKey,
  isLegacyObjectKey,
  objectKeyOrgId,
  folderFor,
  extensionFor,
  CrossTenantObjectError,
  UnsafeObjectKeyError,
} from "@/lib/storage/keys";
export type { ObjectStore, PutObjectInput } from "@/lib/storage/object-store";

/**
 * Where the filesystem backend keeps its tree.
 *
 * Outside `public/` on purpose: proof of delivery shows a person's front
 * door and their handwriting, and an invoice is a commercial document.
 * Neither is world-readable, so every read goes through a route handler
 * that checks who is asking.
 */
export const STORAGE_ROOT = path.join(process.cwd(), "storage");

let store: ObjectStore | undefined;

/**
 * The process-wide object store.
 *
 * This function is the swap point. An S3 adapter is a new class
 * implementing `ObjectStore` and a branch here — on `S3_ENDPOINT` being
 * set, most likely — and nothing else in the product changes, because no
 * caller outside this directory knows what a path is.
 *
 * It deliberately does *not* branch on `S3_ENDPOINT` today. That variable
 * is set in every developer's `.env` and points at a MinIO nobody runs, so
 * selecting on it would mean every capture failing against a closed port
 * the first time somebody read the config as intent.
 */
export function getObjectStore(): ObjectStore {
  store ??= new FilesystemObjectStore(STORAGE_ROOT);
  return store;
}

/**
 * Read an object on behalf of the tenant serving this request.
 *
 * The caller has already established the two facts that matter: the
 * `FileAsset` row came back from the tenant-scoped client, and it is
 * attached to the record named in the URL. This adds the third, which is
 * the one the old code had no way to make — that the *key* belongs to this
 * tenant too. Cheap, and it is the check that survives a future caller who
 * gets one of the first two wrong.
 *
 * Returns null both for "not this tenant's" and for "not there". A reader
 * that cannot have the bytes must not be able to tell those apart: the
 * difference is the existence of somebody else's file.
 */
export async function readTenantObject(objectKey: string): Promise<Buffer | null> {
  const orgId = await requireTenantOrgId();
  if (!keyIsOurs(orgId, objectKey)) return null;

  return getObjectStore().get(objectKey);
}

/**
 * Whether this tenant may address this key at all.
 *
 * A refusal is logged rather than swallowed. Reaching this branch means a
 * `FileAsset` row survived tenant-scoped reading while pointing into
 * another carrier's tree — a bad backfill, a hand-written UPDATE, a bug in
 * a future writer. The caller is told nothing (see above), so the log line
 * is the only place it can surface.
 */
function keyIsOurs(orgId: string, objectKey: string): boolean {
  try {
    assertObjectKeyBelongsTo(orgId, objectKey);
    return true;
  } catch (error) {
    console.error("[storage] refused an object key", {
      orgId,
      objectKey,
      reason: (error as Error).message,
    });
    return false;
  }
}

/**
 * A direct URL for an object, or null when the backend has none.
 *
 * Both document routes call this first and fall back to streaming. With
 * the filesystem backend the answer is always null — see the note on
 * `FilesystemObjectStore.signedUrl` for why signing a URL to our own route
 * would be worse than not signing one — so the fallback is the live path
 * today and the redirect arrives with the S3 adapter, unchanged at the
 * call sites.
 */
export async function tenantObjectUrl(
  objectKey: string,
  ttlSeconds?: number,
): Promise<string | null> {
  const orgId = await requireTenantOrgId();
  if (!keyIsOurs(orgId, objectKey)) return null;

  return getObjectStore().signedUrl(
    objectKey,
    ttlSeconds ?? getEnv().SIGNED_URL_TTL_SECONDS,
  );
}
