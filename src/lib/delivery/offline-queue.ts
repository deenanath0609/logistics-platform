"use client";

/**
 * The offline queue.
 *
 * A delivery agent in a basement car park has no signal and cannot wait for
 * one. So every field action is written to IndexedDB first, confirmed to the
 * agent immediately, and synced afterwards — invisibly, and possibly hours
 * later when the phone next sees a tower.
 *
 * Two things make that safe:
 *
 *  - **A client-generated UUID as `idempotencyKey`.** The same action may
 *    reach the server several times. `appendShipmentEvent` and the unique
 *    index on `DeliveryAttempt(orgId, idempotencyKey)` make the second
 *    arrival a no-op rather than a second delivery. The key is unique per
 *    tenant rather than globally, because two carriers' queues generating
 *    the same key is a collision, not a duplicate.
 *  - **`occurredAt` from the device clock.** The timeline sorts on when the
 *    act happened, not when the server heard about it. The server records
 *    the drift between the two and flags anything implausible.
 *
 * This is deliberately not a service worker. Installability, precaching and
 * the manifest are handled separately; this module is only the durable
 * outbox and its retry loop.
 */

export type QueuedKind =
  | "DELIVER"
  | "FAILED_ATTEMPT"
  | "START_RUN"
  | "COMPLETE_RUN";

export type QueuedAction = {
  /** The `idempotencyKey`. Generated here, never by the server. */
  id: string;
  kind: QueuedKind;
  /** Serialisable body, including any captured data URLs. */
  payload: Record<string, unknown>;
  /** Device clock at the moment of the act, ISO 8601. */
  occurredAt: string;
  createdAt: number;
  attempts: number;
  /** Epoch ms before which no retry should be made. */
  nextAttemptAt: number;
  lastError?: string;
  /** A permanent failure. Shown to the agent; never retried on its own. */
  blocked?: boolean;
};

export type SendOutcome =
  | { ok: true }
  /** The server refused it for good — a bad reason code, a closed run. */
  | { ok: false; retry: false; error: string }
  /** Offline, a 500, a timeout. Try again later. */
  | { ok: false; retry: true; error: string };

export type QueueStatus = {
  pending: number;
  blocked: number;
  syncing: boolean;
  online: boolean;
  lastSyncedAt: number | null;
};

const DB_NAME = "citylogistics-field";
const DB_VERSION = 1;
const STORE = "delivery-queue";

/** 2s, 4s, 8s … capped. A run lasts hours; retrying forever is correct. */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const MAX_ATTEMPTS = 25;

// ────────────────────────────────────────────────────────────
// Storage
// ────────────────────────────────────────────────────────────

/**
 * Server rendering and private-mode browsers with IndexedDB switched off
 * both land here. The queue degrades to memory rather than throwing, which
 * keeps the screen usable — it just cannot survive a reload.
 */
const memoryFallback = new Map<string, QueuedAction>();
let useMemory = typeof indexedDB === "undefined";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function putAction(action: QueuedAction): Promise<void> {
  if (useMemory) {
    memoryFallback.set(action.id, action);
    return;
  }
  try {
    await withStore("readwrite", (store) => store.put(action) as IDBRequest<IDBValidKey>);
  } catch {
    useMemory = true;
    memoryFallback.set(action.id, action);
  }
}

async function deleteAction(id: string): Promise<void> {
  if (useMemory) {
    memoryFallback.delete(id);
    return;
  }
  try {
    await withStore("readwrite", (store) => store.delete(id) as IDBRequest<undefined>);
  } catch {
    memoryFallback.delete(id);
  }
}

export async function listQueue(): Promise<QueuedAction[]> {
  if (useMemory) {
    return [...memoryFallback.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  try {
    const all = await withStore("readonly", (store) => store.getAll() as IDBRequest<QueuedAction[]>);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    useMemory = true;
    return [...memoryFallback.values()];
  }
}

// ────────────────────────────────────────────────────────────
// Status, for the sync badge
// ────────────────────────────────────────────────────────────

let status: QueueStatus = {
  pending: 0,
  blocked: 0,
  syncing: false,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  lastSyncedAt: null,
};

const listeners = new Set<(status: QueueStatus) => void>();

export function subscribe(listener: (status: QueueStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

export function getStatus(): QueueStatus {
  return status;
}

function publish(patch: Partial<QueueStatus>) {
  status = { ...status, ...patch };
  for (const listener of listeners) listener(status);
}

async function refreshCounts() {
  const queue = await listQueue();
  publish({
    pending: queue.filter((action) => !action.blocked).length,
    blocked: queue.filter((action) => action.blocked).length,
  });
}

// ────────────────────────────────────────────────────────────
// Transport
// ────────────────────────────────────────────────────────────

let send: ((action: QueuedAction) => Promise<SendOutcome>) | null = null;

/**
 * Hands the queue its transport. Called once by the field shell, which is
 * where the server actions live — the queue itself stays ignorant of them
 * so it can be tested and reused.
 */
export function configureQueue(
  transport: (action: QueuedAction) => Promise<SendOutcome>,
): void {
  send = transport;
  void flush();
}

// ────────────────────────────────────────────────────────────
// Enqueue
// ────────────────────────────────────────────────────────────

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Ancient WebView on a rugged handset. Random enough to be unique across
  // one agent's day, which is all this key has to survive.
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Records an action and confirms it immediately.
 *
 * Returns the key the server will deduplicate on, so the caller can show
 * the stop as done the instant the agent taps — which is the whole point.
 */
export async function enqueue(
  kind: QueuedKind,
  payload: Record<string, unknown>,
  options: { occurredAt?: Date; idempotencyKey?: string } = {},
): Promise<string> {
  const action: QueuedAction = {
    id: options.idempotencyKey ?? newIdempotencyKey(),
    kind,
    payload,
    occurredAt: (options.occurredAt ?? new Date()).toISOString(),
    createdAt: Date.now(),
    attempts: 0,
    nextAttemptAt: 0,
  };

  await putAction(action);
  await refreshCounts();
  void flush();

  return action.id;
}

/** Drops a permanently failed action once the agent has acknowledged it. */
export async function discard(id: string): Promise<void> {
  await deleteAction(id);
  await refreshCounts();
}

/** Puts a blocked action back in the loop after the agent fixed the input. */
export async function retryNow(id: string): Promise<void> {
  const queue = await listQueue();
  const action = queue.find((item) => item.id === id);
  if (!action) return;
  await putAction({ ...action, blocked: false, attempts: 0, nextAttemptAt: 0 });
  await refreshCounts();
  void flush();
}

// ────────────────────────────────────────────────────────────
// Sync
// ────────────────────────────────────────────────────────────

let flushing = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function backoffFor(attempts: number): number {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
  // Jitter, so a depot full of agents coming back into signal at the same
  // traffic light does not arrive as one spike.
  return delay + Math.random() * delay * 0.25;
}

/**
 * Drains the queue oldest first.
 *
 * Strictly sequential: a failed attempt recorded before a delivery on the
 * same shipment must reach the server in that order, or the state machine
 * refuses the second one.
 */
export async function flush(): Promise<void> {
  if (flushing || !send) return;
  if (typeof navigator !== "undefined" && !navigator.onLine) return;

  flushing = true;
  publish({ syncing: true });

  try {
    const queue = await listQueue();
    const now = Date.now();

    for (const action of queue) {
      if (action.blocked) continue;
      if (action.nextAttemptAt > now) {
        scheduleFlush(action.nextAttemptAt - now);
        continue;
      }

      let outcome: SendOutcome;
      try {
        outcome = await send(action);
      } catch (error) {
        outcome = {
          ok: false,
          retry: true,
          error: error instanceof Error ? error.message : "Network error",
        };
      }

      if (outcome.ok) {
        await deleteAction(action.id);
        publish({ lastSyncedAt: Date.now() });
        continue;
      }

      const attempts = action.attempts + 1;
      const blocked = !outcome.retry || attempts >= MAX_ATTEMPTS;

      await putAction({
        ...action,
        attempts,
        blocked,
        lastError: outcome.error,
        nextAttemptAt: blocked ? 0 : Date.now() + backoffFor(attempts),
      });

      if (blocked) continue;

      // Stop on the first retriable failure. Everything behind it is
      // probably going to fail for the same reason, and order matters.
      scheduleFlush(backoffFor(attempts));
      break;
    }
  } finally {
    flushing = false;
    publish({ syncing: false });
    await refreshCounts();
  }
}

function scheduleFlush(delayMs: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, Math.max(500, delayMs));
}

let wired = false;

/** Starts the retry loop. Idempotent — safe to call from every mount. */
export function startQueue(): () => void {
  if (typeof window === "undefined") return () => {};

  void refreshCounts();

  if (wired) return () => {};
  wired = true;

  const onOnline = () => {
    publish({ online: true });
    void flush();
  };
  const onOffline = () => publish({ online: false });

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  // Coming back to the app after it was backgrounded is the most common
  // moment for a phone to have regained signal without firing `online`.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void flush();
  });

  const interval = setInterval(() => void flush(), 30_000);
  void flush();

  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    clearInterval(interval);
    wired = false;
  };
}
