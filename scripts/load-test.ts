/**
 * How the app behaves when more than one person is using it.
 *
 *   npx tsx scripts/load-test.ts
 *   npx tsx scripts/load-test.ts --concurrency 20 --seconds 60
 *   npx tsx scripts/load-test.ts --host acme.localhost --p95 1500
 *
 * Every other script in this folder asks whether something is *correct*.
 * This one asks whether it is correct while forty people are doing it at
 * once, which is a different question with different answers: a query with
 * no index is instant on a developer's machine and a timeout on a Monday
 * morning, and a connection pool sized for one user is a queue for twenty.
 *
 * ── What it is not ──────────────────────────────────────────
 *
 * Not a benchmark. The numbers below describe this machine, on this data,
 * against a dev server if that is what is running — and a dev server
 * compiles a route on its first request, so the first sample for a screen is
 * always the slowest one this script will ever see. Run it against
 * `npm run build && npm run start` before quoting a number to anybody.
 *
 * What it is for is the shape: which screens are an order of magnitude
 * slower than the rest, whether latency climbs with concurrency or stays
 * flat, and whether anything starts *failing* rather than merely slowing —
 * a 500 under load is a defect, and it is the thing this script exists to
 * surface.
 *
 * ── Reading the result ──────────────────────────────────────
 *
 * p50 is the ordinary experience; p95 is the one people complain about; p99
 * is where the pool, the GC and the cold path show up. A wide gap between
 * p50 and p99 on one screen and not the others is a lock or an N+1, not
 * load.
 *
 * The script fails — exits non-zero — on errors, and on p95 over the budget.
 * Both thresholds are flags, because the right budget for a screen that
 * renders a month of invoices is not the right budget for a dashboard.
 */
import "dotenv/config";
import { CookieJar, hostFetch, hostFollow } from "./host-fetch";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "true");
}

const HOST = args.get("host") ?? "city-logistics.localhost";
const PORT = Number(args.get("port") ?? 3010);
const CONCURRENCY = Number(args.get("concurrency") ?? 10);
const SECONDS = Number(args.get("seconds") ?? 20);
const P95_BUDGET_MS = Number(args.get("p95") ?? 2_000);
const ERROR_BUDGET = Number(args.get("errors") ?? 0);
const MOBILE = args.get("mobile") ?? process.env.SMOKE_ADMIN_MOBILE ?? "9999999999";
const PASSWORD = args.get("password") ?? process.env.SMOKE_ADMIN_PASSWORD ?? "Admin@123";

/**
 * The mix.
 *
 * Weighted the way a working day is, not evenly: a booking clerk reloads
 * the consignment list all morning and opens the rate card twice a week.
 * An even mix would report an average nobody experiences.
 */
const SCREENS: { path: string; weight: number; label: string }[] = [
  { path: "/dashboard", weight: 3, label: "dashboard" },
  { path: "/shipments", weight: 6, label: "consignment list" },
  { path: "/shipments/new", weight: 2, label: "booking form" },
  { path: "/pickups", weight: 2, label: "pickups" },
  { path: "/hub", weight: 2, label: "hub board" },
  { path: "/dispatch/trips", weight: 2, label: "trips" },
  { path: "/delivery/runs", weight: 2, label: "delivery runs" },
  { path: "/tracking", weight: 2, label: "live map" },
  { path: "/exceptions", weight: 1, label: "exception tower" },
  { path: "/finance/invoices", weight: 2, label: "invoices" },
  { path: "/reports", weight: 1, label: "reports" },
  { path: "/customers", weight: 1, label: "customers" },
];

/** The weighted bag, expanded once so a pick is one array index. */
const BAG = SCREENS.flatMap((screen) => Array<typeof screen>(screen.weight).fill(screen));

type Sample = { label: string; ms: number; status: number };

const samples: Sample[] = [];
let requests = 0;
let errors = 0;

// ────────────────────────────────────────────────────────────

async function signIn(): Promise<CookieJar> {
  const jar = new CookieJar();

  const csrf = await hostFollow(HOST, PORT, "/api/auth/csrf", jar);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

  const body = new URLSearchParams({
    mobile: MOBILE,
    password: PASSWORD,
    csrfToken,
    callbackUrl: `http://${HOST}:${PORT}/dashboard`,
  });

  const response = await hostFetch(HOST, PORT, "/api/auth/callback/password", {
    method: "POST",
    cookie: jar.header(),
    body: body.toString(),
  });
  jar.absorb(response);

  if ((response.location ?? "").includes("error")) {
    throw new Error(`Sign-in failed for ${MOBILE}: ${response.location}`);
  }

  // Prove the session actually sticks. A jar that absorbed nothing sends
  // every request as an anonymous visitor, and a redirect to /login is fast
  // — which would produce a beautiful set of numbers describing the login
  // page rather than the application.
  const dashboard = await hostFollow(HOST, PORT, "/dashboard", jar);
  if (dashboard.finalPath.includes("/login")) {
    throw new Error("Signed in, but the session did not stick — every sample would be the login page.");
  }

  return jar;
}

/**
 * One worker, looping until the clock runs out.
 *
 * Each has its own session. Sharing one would measure a single user with
 * twenty tabs, which is not what a carrier's morning looks like and misses
 * everything session-scoped: the per-user caches, the request-level tenant
 * resolution, and any lock taken per session.
 */
async function worker(index: number, until: number): Promise<void> {
  const jar = await signIn();

  while (Date.now() < until) {
    const screen = BAG[(requests + index) % BAG.length];
    const started = Date.now();

    try {
      const response = await hostFollow(HOST, PORT, screen.path, jar);
      const ms = Date.now() - started;
      requests += 1;

      const ok = response.status === 200 && !response.finalPath.includes("/login");
      if (!ok) errors += 1;

      samples.push({ label: screen.label, ms, status: response.status });
    } catch (error) {
      requests += 1;
      errors += 1;
      samples.push({ label: screen.label, ms: Date.now() - started, status: 0 });
      // Connection refused mid-run means the server fell over, which is the
      // most important result this script can produce. Named, not swallowed.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ECONNREFUSED")) {
        console.error(`\n  The server stopped answering after ${requests} requests.`);
        return;
      }
    }
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

// ────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `\nLoad — ${CONCURRENCY} concurrent staff on ${HOST}:${PORT} for ${SECONDS}s\n` +
      `  Budget: p95 under ${P95_BUDGET_MS}ms, at most ${ERROR_BUDGET} failed request(s).\n`,
  );

  try {
    await hostFetch(HOST, PORT, "/api/health");
  } catch {
    console.error(`Nothing is listening on ${HOST}:${PORT}. Start the app first:\n  npm run dev:3010\n`);
    process.exit(1);
  }

  // One warm request per screen before the clock starts. Against a dev
  // server this is compilation; against a built one it is the connection
  // pool filling. Either way it is not what we are trying to measure, and
  // leaving it in makes the first worker look like the slow one.
  const warm = await signIn();
  for (const screen of SCREENS) {
    await hostFollow(HOST, PORT, screen.path, warm);
  }
  console.log(`  Warmed ${SCREENS.length} screens.\n`);

  const until = Date.now() + SECONDS * 1_000;
  const started = Date.now();

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_unused, index) => worker(index, until)),
  );

  const elapsed = (Date.now() - started) / 1_000;

  // ── Per screen ────────────────────────────────────────────
  console.log(
    `  ${pad("screen", 20)}${padLeft("n", 6)}${padLeft("p50", 8)}${padLeft("p95", 8)}${padLeft("p99", 8)}${padLeft("max", 8)}`,
  );
  console.log(`  ${"─".repeat(58)}`);

  for (const screen of SCREENS) {
    const times = samples.filter((s) => s.label === screen.label).map((s) => s.ms);
    if (times.length === 0) continue;

    console.log(
      `  ${pad(screen.label, 20)}${padLeft(String(times.length), 6)}` +
        `${padLeft(`${percentile(times, 50)}ms`, 8)}` +
        `${padLeft(`${percentile(times, 95)}ms`, 8)}` +
        `${padLeft(`${percentile(times, 99)}ms`, 8)}` +
        `${padLeft(`${Math.max(...times)}ms`, 8)}`,
    );
  }

  // ── Overall ───────────────────────────────────────────────
  const all = samples.map((s) => s.ms);
  const p95 = percentile(all, 95);

  console.log(
    `\n  ${requests} requests in ${elapsed.toFixed(1)}s — ` +
      `${(requests / elapsed).toFixed(1)}/s across ${CONCURRENCY} sessions\n` +
      `  p50 ${percentile(all, 50)}ms · p95 ${p95}ms · p99 ${percentile(all, 99)}ms\n` +
      `  ${errors} failed request(s)\n`,
  );

  if (errors > 0) {
    const byStatus = new Map<number, number>();
    for (const sample of samples) {
      if (sample.status === 200) continue;
      byStatus.set(sample.status, (byStatus.get(sample.status) ?? 0) + 1);
    }
    console.log(
      "  Failures by status: " +
        [...byStatus.entries()]
          .map(([status, n]) => `${status === 0 ? "no response" : status} × ${n}`)
          .join(", ") +
        "\n",
    );
  }

  const overBudget = p95 > P95_BUDGET_MS;
  const tooManyErrors = errors > ERROR_BUDGET;

  if (overBudget) console.log(`  [FAIL] p95 ${p95}ms is over the ${P95_BUDGET_MS}ms budget.`);
  if (tooManyErrors) console.log(`  [FAIL] ${errors} failed request(s), budget ${ERROR_BUDGET}.`);
  if (!overBudget && !tooManyErrors) console.log("  [PASS] within budget.");

  console.log("");
  process.exit(overBudget || tooManyErrors ? 1 : 0);
}

main().catch((error) => {
  console.error("\nThe load test could not run:\n", error);
  process.exit(1);
});
