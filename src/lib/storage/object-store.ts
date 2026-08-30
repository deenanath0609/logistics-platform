import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeObjectKey } from "@/lib/storage/keys";

/**
 * The seam between "we hold these bytes" and "here is where they live".
 *
 * There is no S3 here. `S3_ENDPOINT` points at a MinIO that is not running,
 * and writing a client against a service nobody can start would be code
 * nothing exercises. So the filesystem stays the implementation — but
 * behind this interface, so the S3 adapter is a new class and one line in
 * `createObjectStore()` rather than a rewrite of every caller.
 *
 * Four members, each with a caller today: the writer puts, the two document
 * routes get and ask for a URL, and `scripts/migrate-storage-keys.ts`
 * moves. Anything richer — listing, multipart, lifecycle — would be guessed
 * from the S3 API rather than demanded, and a seam invented ahead of its
 * second implementation is usually the wrong shape.
 */
export type PutObjectInput = {
  key: string;
  bytes: Buffer;
  contentType: string;
};

export interface ObjectStore {
  /** Names the implementation, for logs and for the migration script. */
  readonly backend: "filesystem";

  put(input: PutObjectInput): Promise<void>;

  /** The bytes, or null when the object is not there. */
  get(key: string): Promise<Buffer | null>;

  /**
   * A URL the browser may fetch directly, or null when this backend has
   * none to offer.
   *
   * Callers must handle null by serving the bytes themselves — which is
   * what both routes do today, because the filesystem backend always
   * answers null. See the note on `FilesystemObjectStore.signedUrl`.
   */
  signedUrl(key: string, ttlSeconds?: number): Promise<string | null>;

  /**
   * Moves an object to a new key, for the key migration. Returns false
   * when there was nothing at `from` — an already-migrated deployment
   * re-running the script, which is not an error.
   */
  move(from: string, to: string): Promise<boolean>;
}

/**
 * Bytes on the app server's own disk.
 *
 * This is a single-node arrangement: two app servers behind a load balancer
 * would each see half the files. That is a deployment constraint, not a
 * secret — it is the reason the S3 adapter is wanted, and it is written
 * here rather than in a TODO so that whoever adds the second app server
 * finds it.
 */
export class FilesystemObjectStore implements ObjectStore {
  readonly backend = "filesystem" as const;

  constructor(private readonly root: string) {}

  /** Absolute path for a key. Never called with an unvalidated key. */
  private pathFor(key: string): string {
    assertSafeObjectKey(key);
    return path.join(this.root, ...key.split("/"));
  }

  async put(input: PutObjectInput): Promise<void> {
    const destination = this.pathFor(input.key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, input.bytes);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      // Missing is an ordinary answer here: a POD captured before the
      // volume was attached, or a document a worker has not rendered yet.
      // Anything else is a real fault and must not be swallowed into a 404.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Always null, and honestly so.
   *
   * A signed URL earns its keep when it points somewhere the app server is
   * not — the browser fetches from S3, the bytes never cross this process,
   * and the signature is what stands in for the session. None of that is
   * available with the bytes on this disk. Signing a URL back to our own
   * route would buy exactly nothing and cost something real: the signature
   * would become a bearer token that outlives sign-out, works from any
   * browser, and reaches a handler that must then either re-check the
   * session anyway (so the signature was decoration) or skip it (so a
   * pasted link is a leak). `SIGNED_URL_TTL_SECONDS` stays in the
   * environment for the backend that can use it.
   */
  async signedUrl(): Promise<string | null> {
    return null;
  }

  async move(from: string, to: string): Promise<boolean> {
    const source = this.pathFor(from);
    const destination = this.pathFor(to);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await rename(source, destination);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
