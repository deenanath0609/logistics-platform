import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isRedisReachable } from "@/lib/redis";

export const dynamic = "force-dynamic";

type Check = {
  ok: boolean;
  latencyMs: number;
  /** Optional checks report their state but never fail the endpoint. */
  required: boolean;
};

async function timed(
  name: string,
  required: boolean,
  fn: () => Promise<unknown>,
): Promise<Check> {
  const started = performance.now();
  try {
    await fn();
    return { ok: true, required, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    // The reason goes to the log, never to the caller.
    //
    // This endpoint answers anyone, unauthenticated, on every tenant
    // subdomain, and the messages it used to return came from Postgres and
    // Redis drivers: those carry the host, the port, the database name and
    // the username we connect as. "Whether it is up" is public; "where it
    // is and who we are to it" is a map of the estate.
    console.error(`[health] ${name} check failed`, error);
    return {
      ok: false,
      required,
      latencyMs: Math.round(performance.now() - started),
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
    timed("database", true, () => prisma.$queryRaw`SELECT 1`),
    timed("cache", false, async () => {
      if (!(await isRedisReachable())) throw new Error("unreachable");
    }),
    timed("postgis", false, () => prisma.$queryRaw`SELECT postgis_version()`),
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
