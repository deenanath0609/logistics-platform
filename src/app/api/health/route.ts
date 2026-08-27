import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isRedisReachable } from "@/lib/redis";

export const dynamic = "force-dynamic";

type Check = {
  ok: boolean;
  latencyMs: number;
  /** Optional checks report their state but never fail the endpoint. */
  required: boolean;
  detail?: string;
};

async function timed(
  required: boolean,
  fn: () => Promise<unknown>,
): Promise<Check> {
  const started = performance.now();
  try {
    await fn();
    return { ok: true, required, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      required,
      latencyMs: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Liveness for the deploy pipeline and the ops "is the system alive?" tile.
 *
 * Postgres is required. Redis (Phase 2) and PostGIS (Phase 7) are reported
 * so their absence is visible, but do not mark the service unhealthy while
 * those phases are still ahead.
 */
export async function GET() {
  const [database, cache, postgis] = await Promise.all([
    timed(true, () => prisma.$queryRaw`SELECT 1`),
    timed(false, async () => {
      if (!(await isRedisReachable())) throw new Error("unreachable");
    }),
    timed(false, () => prisma.$queryRaw`SELECT postgis_version()`),
  ]);

  const checks = { database, cache, postgis };
  const requiredOk = Object.values(checks)
    .filter((c) => c.required)
    .every((c) => c.ok);
  const allOk = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    {
      status: allOk ? "healthy" : requiredOk ? "degraded" : "unhealthy",
      service: "logistics-platform",
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: requiredOk ? 200 : 503 },
  );
}
