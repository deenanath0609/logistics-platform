import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { can, type SessionUser } from "@/lib/auth/session";
import { LIVE_STATUSES } from "@/lib/exceptions/kinds";
import { anyBranchScope } from "@/server/repositories/scope";
import { MOVING } from "@/lib/reports/operations";
import { toDayString } from "@/lib/reports/filters";
import { cn } from "@/lib/utils";

/**
 * The "what is wrong right now" strip for the operations dashboard.
 *
 * Self-contained on purpose: the dashboard imports one component and
 * passes the user, so Phase 8 adds a section to that page rather than
 * rewriting it.
 *
 * Counts are permission-gated and branch-scoped. A branch manager sees
 * their own trouble, not the network's — a tile that says "47 breached"
 * when 46 of them belong to another region sends them looking for
 * something that is not theirs.
 *
 * Every tile is a link, and a tile that does not agree with the page it
 * opens is worse than no tile: somebody clicks 14 and counts 900. So the
 * three SLA tiles now count exactly what `/reports/in-transit-status`
 * lists — the same `MOVING` status set, the same `sla.state`, and the same
 * booking window, which is passed on the link rather than left to the
 * report's own thirty-day default. They previously counted every shipment
 * ever, delivered ones included, and pointed at the exception register,
 * which lists a different table entirely.
 */

/**
 * How far back the SLA tiles look, and what their links ask for.
 *
 * One constant so the count and the destination cannot drift. A year is
 * comfortably inside the report's 400-day range ceiling, and a consignment
 * booked longer ago than that and still in transit is not a live
 * operational item — it is a write-off, and the exception tower owns it.
 */
const SLA_TILE_WINDOW_DAYS = 365;

export async function OpsHealthStrip({ user }: { user: SessionUser }) {
  const seesExceptions = can(user, "exception.read");
  const seesReports = can(user, "report.operations");

  if (!seesExceptions && !seesReports) return null;

  const branchScope =
    user.branchIds === null ? {} : { ownerBranchId: { in: user.branchIds } };

  // The same helper the reports use, rather than a second hand-rolled copy
  // that has to be kept in step with it.
  const shipmentScope = anyBranchScope(user, [
    "originBranchId",
    "destinationBranchId",
    "currentBranchId",
  ]);

  const to = new Date();
  const from = new Date(to.getTime() - SLA_TILE_WINDOW_DAYS * 86_400_000);

  /** Open consignments in the window — the in-transit report's population. */
  const inNetwork = {
    AND: [
      { deletedAt: null },
      { bookedAt: { gte: from, lte: to } },
      { currentStatus: { in: MOVING } },
      shipmentScope,
    ],
  };

  const slaLink = (state: string) =>
    `/reports/in-transit-status?sla=${state}&from=${toDayString(from)}&to=${toDayString(to)}`;

  const [open, critical, unassigned, atRisk, breached, notCovered] =
    await Promise.all([
      seesExceptions
        ? prisma.exception.count({
            where: { ...branchScope, status: { in: LIVE_STATUSES } },
          })
        : Promise.resolve(0),
      seesExceptions
        ? prisma.exception.count({
            where: {
              ...branchScope,
              status: { in: LIVE_STATUSES },
              priority: { in: ["CRITICAL", "HIGH"] },
            },
          })
        : Promise.resolve(0),
      seesExceptions
        ? prisma.exception.count({
            where: {
              ...branchScope,
              status: { in: LIVE_STATUSES },
              assignedToId: null,
            },
          })
        : Promise.resolve(0),
      seesReports
        ? prisma.shipment.count({
            where: { AND: [inNetwork, { sla: { state: "AT_RISK" } }] },
          })
        : Promise.resolve(0),
      seesReports
        ? prisma.shipment.count({
            where: { AND: [inNetwork, { sla: { state: "BREACHED" } }] },
          })
        : Promise.resolve(0),
      // Open consignments the engine could not measure. Surfaced because
      // a growing number here means a lane is running with no promise
      // attached, and nobody finds that out from a green dashboard.
      //
      // "Open" is `MOVING`, the same list the in-transit report uses. It
      // was a hand-written `notIn` that forgot the three RTO statuses, so
      // a consignment already returned to the sender counted as open.
      seesReports
        ? prisma.shipment.count({
            where: { AND: [inNetwork, { sla: { state: "NOT_APPLICABLE" } }] },
          })
        : Promise.resolve(0),
    ]);

  const tiles = [
    seesExceptions && {
      label: "Open exceptions",
      value: open,
      href: "/exceptions",
      tone: open === 0 ? "ok" : "bad",
    },
    seesExceptions && {
      label: "Critical or high",
      value: critical,
      href: "/exceptions?view=critical",
      tone: critical === 0 ? "ok" : "bad",
    },
    seesExceptions && {
      label: "Nobody assigned",
      value: unassigned,
      href: "/exceptions?view=unassigned",
      tone: unassigned === 0 ? "ok" : "warn",
    },
    seesReports && {
      label: "In transit, at risk",
      value: atRisk,
      href: slaLink("AT_RISK"),
      tone: atRisk === 0 ? "ok" : "warn",
    },
    seesReports && {
      label: "In transit, breached",
      value: breached,
      href: slaLink("BREACHED"),
      tone: breached === 0 ? "ok" : "bad",
    },
    seesReports && {
      label: "In transit, no SLA policy",
      value: notCovered,
      href: slaLink("NOT_APPLICABLE"),
      tone: notCovered === 0 ? "ok" : "muted",
    },
  ].filter(Boolean) as Array<{
    label: string;
    value: number;
    href: string;
    tone: "ok" | "warn" | "bad" | "muted";
  }>;

  const TONE: Record<string, string> = {
    ok: "text-ok",
    warn: "text-warn",
    bad: "text-bad",
    muted: "text-muted-foreground",
  };

  return (
    <section className="mt-8 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          What is wrong right now
        </h2>
        {seesReports && (
          <Link
            href="/reports"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Report library →
          </Link>
        )}
      </div>

      {seesReports && (
        <p className="max-w-prose text-xs text-muted-foreground">
          Every tile opens the rows it counted. The SLA tiles cover
          consignments still in the network, booked in the last{" "}
          {SLA_TILE_WINDOW_DAYS} days — the same window their links carry, so
          the number here and the number there come from one query.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((tile) => (
          <Link
            key={tile.label}
            href={tile.href}
            className="group flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:border-primary/40 hover:bg-accent/40"
          >
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              {tile.label}
            </span>
            <span className={cn("text-2xl font-semibold tabular", TONE[tile.tone])}>
              {tile.value}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
