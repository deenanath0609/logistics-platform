/**
 * The key that makes a re-commit safe.
 *
 * A clerk who commits a batch, loses the connection, and presses the
 * button again must not book two hundred consignments twice. The key is a
 * pure function of the batch and the row, so the second attempt presents
 * the same key as the first; `ShipmentEvent.idempotencyKey` is unique, and
 * the committer looks the key up before booking. Nothing about the retry
 * needs to be remembered anywhere else.
 *
 * Deliberately readable rather than hashed: when someone is staring at a
 * production event row asking where it came from, `bulk:<batch>:<row>`
 * answers the question and a digest does not.
 */
export function bulkIdempotencyKey(batchId: string, rowNumber: number): string {
  return `bulk:${batchId}:${rowNumber}`;
}

/** Reverses the key, for tracing an event back to the file it came from. */
export function parseBulkIdempotencyKey(
  key: string,
): { batchId: string; rowNumber: number } | null {
  const match = /^bulk:([^:]+):(\d+)$/.exec(key);
  if (!match) return null;
  return { batchId: match[1], rowNumber: Number(match[2]) };
}
