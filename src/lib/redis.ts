import IORedis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis: IORedis | undefined;
};

/**
 * Redis backs the BullMQ queues from Phase 2 (outbox drain, notifications,
 * GPS ingest). Connection is lazy so a developer without Redis running can
 * still work on Phase 1 without a console full of ECONNREFUSED.
 */
function createRedis() {
  const client = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6380", {
    // BullMQ requires null so blocking commands do not time out.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });

  // Without a listener, a connection failure becomes an unhandled error and
  // takes the process down. Log the first failure only — a retry loop
  // against an absent Redis would otherwise bury real errors in the log.
  let reported = false;
  client.on("error", (error) => {
    if (reported) return;
    reported = true;
    console.warn(
      `[redis] unreachable at ${process.env.REDIS_URL ?? "localhost:6380"}: ` +
        `${error.message || error.name}. Background jobs start in Phase 2; ` +
        "further connection errors are suppressed.",
    );
  });
  client.on("ready", () => {
    reported = false;
  });

  return client;
}

export const redis = globalForRedis.redis ?? createRedis();

if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;

/** True when Redis answered a PING within the timeout. */
export async function isRedisReachable(timeoutMs = 1500): Promise<boolean> {
  try {
    if (redis.status === "wait" || redis.status === "end") {
      await redis.connect();
    }
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}
