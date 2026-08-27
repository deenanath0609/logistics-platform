import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { can, type SessionUser } from "@/lib/auth/session";
import { LIVE_STATUSES } from "@/lib/exceptions/kinds";
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
 */
export async function OpsHealthStrip({ user }: { user: SessionUser }) {
  const seesExceptions = can(user, "exception.read");
  const seesReports = can(user, "report.operations");

  if (!seesExceptions && !seesReports) return null;

  const branchScope =
    user.branchIds === null ? {} : { ownerBranchId: { in: user.branchIds } };

  const shipmentScope =
    user.branchIds === null
      ? {}
      : {
          OR: [
            { originBranchId: { in: user.branchIds } },
            { destinationBranchId: { in: user.branchIds } },
            { currentBranchId: { in: user.branchIds } },
          ],
        };

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
      prisma.shipment.count({
        where: { ...shipmentScope, deletedAt: null, sla: { state: "AT_RISK" } },
      }),
      prisma.shipment.count({
        where: { ...shipmentScope, deletedAt: null, sla: { state: "BREACHED" } },
      }),
      // Open consignments the engine could not measure. Surfaced because
      // a growing number here means a lane is running with no promise
      // attached, and nobody finds that out from a green dashboard.
      prisma.shipment.count({
        where: {
          ...shipmentScope,
          deletedAt: null,
          sla: { state: "NOT_APPLICABLE" },
          currentStatus: {
            notIn: ["DELIVERED", "POD_UPLOADED", "CLOSED", "CANCELLED", "LOST"],
          },
        },
      }),
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
    {
      label: "SLA at risk",
      value: atRisk,
      href: "/reports/in-transit-status",
      tone: atRisk === 0 ? "ok" : "warn",
    },
    {
      label: "SLA breached",
      value: breached,
      href: "/reports/exception-register",
      tone: breached === 0 ? "ok" : "bad",
    },
    {
      label: "Open, no SLA policy",
      value: notCovered,
      href: "/reports/customer-on-time",
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
