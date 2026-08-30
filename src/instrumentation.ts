/**
 * Server startup.
 *
 * Next.js calls `register()` once per server process, before any request is
 * handled. It used to be where the five background loops — the outbox
 * drain, webhook delivery, GPS polling and its signal-loss sweep, the SLA
 * scan and GPS retention — were switched on.
 *
 * They are not started here any more. They live in `workers/index.ts` and
 * run in a process of their own, because tying them to the web tier meant a
 * deploy stopped them, every instance duplicated them, and none of them
 * could be scaled or restarted without restarting the site. See
 * docs/adr/002-background-worker.md.
 *
 * ─── The failure this file has to prevent ──────────────────────────────
 *
 * Moving work out of a process is easy; noticing that nobody moved it *in*
 * anywhere is not. A developer who runs `npm run dev` and no worker gets a
 * system that looks perfect and delivers nothing — every notification stays
 * QUEUED, no webhook fires, no GPS fix arrives, no SLA breach is found.
 * Nothing on screen says so.
 *
 * So the web server is loud about it instead of quiet:
 *
 *  · it says at boot, every boot, that background jobs are not in this
 *    process and how to start them;
 *  · and it watches the outbox for a backlog, which is proof rather than a
 *    reminder, and shouts once a minute for as long as it lasts.
 *
 * The escape hatch is `RUN_JOBS_IN_WEB=true`, which puts all five back here
 * for a single-instance deployment or a quick local run. It is opt-in, and
 * it warns, because setting it on two instances silently doubles every poll
 * and every scan.
 */
export async function register() {
  // The edge runtime has no timers and no database access. The work itself
  // lives in `instrumentation-node.ts`, behind a single dynamic import, so
  // that Turbopack keeps the database driver out of the edge bundle — see
  // the comment at the top of that file for what happens otherwise.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startNodeInstrumentation } = await import("./instrumentation-node");
  await startNodeInstrumentation();
}
