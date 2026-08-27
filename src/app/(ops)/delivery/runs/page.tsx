import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { deliveryRunScope } from "@/lib/delivery/runs";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { RunStatusPill } from "@/components/delivery/run-status-pill";
import { NewRunForm } from "./new-run-form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Delivery runs" };
export const dynamic = "force-dynamic";

function localDay(value: string | undefined): Date {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default async function DeliveryRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const user = await requirePermission("delivery.read");
  const { date } = await searchParams;
  const runDate = localDay(date);
  const canAssign = can(user, "delivery.assign");

  const [runs, waiting] = await Promise.all([
    prisma.deliveryRun.findMany({
      where: { runDate, ...deliveryRunScope(user) },
      orderBy: [{ status: "asc" }, { number: "asc" }],
      select: {
        id: true,
        number: true,
        status: true,
        totalTasks: true,
        completedTasks: true,
        failedTasks: true,
        codExpected: true,
        codCollected: true,
        startedAt: true,
        agent: { select: { id: true, name: true, mobile: true } },
        branch: { select: { code: true } },
      },
    }),
    // What is sitting at the destination hub with nobody assigned to it.
    // This is the number a branch manager actually cares about at 07:00.
    prisma.shipment.count({
      where: {
        deletedAt: null,
        currentStatus: "RECEIVED_AT_HUB",
        isOnHold: false,
        ...branchScope(user, "currentBranchId"),
      },
    }),
  ]);

  const [branches, agents, vehicles] = canAssign
    ? await Promise.all([
        prisma.branch.findMany({
          where: { isActive: true, deletedAt: null, ...branchScope(user, "id") },
          orderBy: { code: "asc" },
          select: { id: true, code: true, name: true },
        }),
        prisma.user.findMany({
          where: {
            status: "ACTIVE",
            deletedAt: null,
            isFieldUser: true,
            ...branchScope(user, "primaryBranchId"),
          },
          orderBy: { name: "asc" },
          select: { id: true, name: true, mobile: true },
        }),
        prisma.vehicle.findMany({
          where: { isActive: true, deletedAt: null, ...branchScope(user, "branchId") },
          orderBy: { registrationNumber: "asc" },
          select: { id: true, registrationNumber: true },
        }),
      ])
    : [[], [], []];

  const previous = new Date(runDate);
  previous.setDate(previous.getDate() - 1);
  const next = new Date(runDate);
  next.setDate(next.getDate() + 1);

  return (
    <>
      <PageHeader
        eyebrow="Last mile"
        title="Delivery runs"
        description="One agent, one day, an ordered list of doors. The COD total on each run is what that agent is accountable for at day end."
        actions={
          canAssign ? (
            <NewRunForm
              branches={branches.map((b) => ({ id: b.id, label: `${b.code} · ${b.name}` }))}
              agents={agents.map((a) => ({ id: a.id, label: a.name, hint: a.mobile }))}
              vehicles={vehicles.map((v) => ({ id: v.id, label: v.registrationNumber }))}
              defaultBranchId={user.primaryBranch?.id ?? branches[0]?.id ?? ""}
              defaultDate={isoDay(runDate)}
            />
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg border bg-card p-1">
          <Link
            href={`/delivery/runs?date=${isoDay(previous)}`}
            className="rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ←
          </Link>
          <span className="px-2 font-mono text-xs font-medium tabular">
            {format(runDate, "EEE dd MMM yyyy")}
          </span>
          <Link
            href={`/delivery/runs?date=${isoDay(next)}`}
            className="rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            →
          </Link>
        </div>

        <span className="rounded-md bg-info-muted px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-wider text-info">
          {waiting} awaiting delivery at your branches
        </span>

        <Link
          href="/delivery/cod"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Day-end COD →
        </Link>
      </div>

      <TableFrame>
        {runs.length === 0 ? (
          <EmptyState
            title="No runs on this date"
            description={
              canAssign
                ? "Build one for an agent, then add the shipments sitting at the hub."
                : "Nothing has been planned for this day yet."
            }
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Stops</TableHead>
                <TableHead className="text-right">Done</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">COD due</TableHead>
                <TableHead className="text-right">COD collected</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const expected = Number(run.codExpected);
                const collected = Number(run.codCollected);
                const short = expected - collected;

                return (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Link
                        href={`/delivery/runs/${run.id}`}
                        className="font-mono text-xs font-medium hover:underline"
                      >
                        {run.number}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">
                      {run.agent.name}
                      <span className="ml-2 font-mono text-[0.65rem] text-muted-foreground">
                        {run.agent.mobile}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {run.branch.code}
                    </TableCell>
                    <TableCell className="text-right tabular">{run.totalTasks}</TableCell>
                    <TableCell className="text-right tabular text-ok">
                      {run.completedTasks}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {run.failedTasks > 0 ? (
                        <span className="text-bad">{run.failedTasks}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular">
                      {expected > 0 ? `₹${expected.toLocaleString("en-IN")}` : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular">
                      {expected > 0 ? (
                        <span className={short > 0 ? "text-warn" : "text-ok"}>
                          ₹{collected.toLocaleString("en-IN")}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <RunStatusPill status={run.status} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableFrame>
    </>
  );
}
