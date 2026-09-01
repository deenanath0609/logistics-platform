import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft, MapPin, Phone } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { coversBranch, branchScope } from "@/server/repositories/scope";
import { fromStoredDate } from "@/lib/delivery/calendar";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame } from "@/components/data/data-shell";
import { RunStatusPill, TaskStatusPill } from "@/components/delivery/run-status-pill";
import { StatusPill } from "@/components/shipment/status-pill";
import { AddStopsPanel } from "./add-stops";
import { StopSequencer } from "./stop-sequencer";
import { RemoveStopButton, RtoDialog } from "./stop-actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Delivery run" };
export const dynamic = "force-dynamic";

/**
 * Where a return may be started from.
 *
 * Mirrors the `RTO_INITIATED` rule in `lib/shipment/state-machine.ts`. The
 * service refuses anything else; this only decides whether offering the
 * button would be a lie.
 */
const RTO_FROM = new Set([
  "RECEIVED_AT_HUB",
  "ASSIGNED_FOR_DELIVERY",
  "OUT_FOR_DELIVERY",
]);

export default async function DeliveryRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("delivery.read");
  const { id } = await params;

  const run = await prisma.deliveryRun.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      status: true,
      runDate: true,
      startedAt: true,
      completedAt: true,
      branchId: true,
      totalTasks: true,
      completedTasks: true,
      failedTasks: true,
      codExpected: true,
      codCollected: true,
      agent: { select: { id: true, name: true, mobile: true } },
      branch: { select: { id: true, code: true, name: true } },
      tasks: {
        orderBy: [{ sequence: "asc" }],
        select: {
          id: true,
          sequence: true,
          status: true,
          priority: true,
          attemptNumber: true,
          codAmount: true,
          completedAt: true,
          shipment: {
            select: {
              id: true,
              lrNumber: true,
              currentStatus: true,
              packageCount: true,
              consigneeName: true,
              consigneePhone: true,
              consigneeAddress: true,
              consigneeLandmark: true,
              consigneePincode: true,
              paymentType: true,
              codAmount: true,
              attemptCount: true,
              serviceType: { select: { maxDeliveryAttempts: true } },
            },
          },
          attempts: {
            orderBy: { attemptedAt: "asc" },
            select: {
              id: true,
              attemptNumber: true,
              outcome: true,
              attemptedAt: true,
              remarks: true,
            },
          },
        },
      },
    },
  });

  if (!run) notFound();
  if (user.scope === "OWN" ? run.agent.id !== user.id : !coversBranch(user, run.branchId)) {
    notFound();
  }

  const canAssign = can(user, "delivery.assign") && run.status === "PLANNED";
  const canReassign = can(user, "delivery.reassign");
  const canRto = can(user, "delivery.rto");

  // The end of the attempt ladder. `nextAction` proposes RTO once the
  // allowance is spent and nothing in the product could take it — the
  // action existed with no control on any screen. This is that control's
  // reason list; operations owns the table, so it is read, never hard-coded.
  const rtoReasons = canRto
    ? await prisma.reasonCode.findMany({
        where: { category: "RTO", isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, code: true, name: true },
      })
    : [];

  // Everything physically at this branch and owed a delivery. A shipment
  // already on another run is filtered out inside `addShipmentsToRun` too —
  // this list is a convenience, that check is the guarantee.
  const candidates = canAssign
    ? await prisma.shipment.findMany({
        where: {
          deletedAt: null,
          currentStatus: "RECEIVED_AT_HUB",
          currentBranchId: run.branchId,
          isOnHold: false,
          ...branchScope(user, "currentBranchId"),
          deliveryTasks: {
            none: { status: { in: ["PENDING", "OUT_FOR_DELIVERY"] }, runId: { not: null } },
          },
        },
        orderBy: [{ attemptCount: "desc" }, { bookedAt: "asc" }],
        take: 200,
        select: {
          id: true,
          lrNumber: true,
          consigneeName: true,
          consigneeAddress: true,
          consigneePincode: true,
          packageCount: true,
          paymentType: true,
          codAmount: true,
          attemptCount: true,
          expectedDeliveryAt: true,
        },
      })
    : [];

  const codExpected = Number(run.codExpected);
  const codCollected = Number(run.codCollected);
  const outstanding = codExpected - codCollected;

  return (
    <>
      <Link
        href="/delivery/runs"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All runs
      </Link>

      <PageHeader
        eyebrow={`${run.branch.code} · ${format(fromStoredDate(run.runDate), "EEE dd MMM yyyy")}`}
        title={run.number}
        description={`${run.agent.name} · ${run.agent.mobile}`}
        actions={<RunStatusPill status={run.status} className="text-[0.7rem]" />}
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Stops" value={String(run.totalTasks)} />
        <Stat label="Delivered" value={String(run.completedTasks)} tone="ok" />
        <Stat
          label="Attempted"
          value={String(run.failedTasks)}
          tone={run.failedTasks > 0 ? "bad" : undefined}
        />
        <Stat
          label="COD accountable"
          value={`₹${codExpected.toLocaleString("en-IN")}`}
          hint={
            codExpected > 0
              ? `₹${codCollected.toLocaleString("en-IN")} collected · ₹${outstanding.toLocaleString("en-IN")} still out`
              : "Nothing to collect on this run"
          }
          tone={outstanding > 0 && run.status !== "PLANNED" ? "warn" : undefined}
        />
      </div>

      <section className="mb-8 flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Stops in sequence
          </h2>
          {canAssign && run.tasks.length > 1 && (
            <StopSequencer
              runId={run.id}
              stops={run.tasks.map((task) => ({
                id: task.id,
                label: `${task.shipment.lrNumber} · ${task.shipment.consigneeName}`,
              }))}
            />
          )}
        </div>

        <TableFrame>
          {run.tasks.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">
              No stops yet. Add what is sitting at {run.branch.code} below.
            </p>
          ) : (
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>LR</TableHead>
                  <TableHead>Consignee</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead className="text-right">Pkgs</TableHead>
                  <TableHead className="text-right">COD</TableHead>
                  <TableHead>Attempt</TableHead>
                  <TableHead>Stop</TableHead>
                  <TableHead>Shipment</TableHead>
                  {(canReassign || canRto) && <TableHead className="text-right" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="tabular text-muted-foreground">
                      {task.sequence}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/shipments/${task.shipment.id}`}
                        className="font-mono text-xs font-medium hover:underline"
                      >
                        {task.shipment.lrNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">
                      {task.shipment.consigneeName}
                      <span className="ml-2 inline-flex items-center gap-1 font-mono text-[0.65rem] text-muted-foreground">
                        <Phone className="size-2.5" />
                        {task.shipment.consigneePhone}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">
                      {task.shipment.consigneeAddress}
                      <span className="ml-1 font-mono">
                        {task.shipment.consigneePincode}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {task.shipment.packageCount}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular">
                      {task.codAmount ? (
                        <span className="text-warn">
                          ₹{Number(task.codAmount).toLocaleString("en-IN")}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {task.attemptNumber}
                      {task.attemptNumber > 1 && (
                        <span
                          className="ml-1 rounded-sm bg-warn-muted px-1 py-0.5 text-[0.55rem] uppercase tracking-wider text-warn"
                          title={`${task.shipment.attemptCount} previous failed attempt(s)`}
                        >
                          repeat
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <TaskStatusPill status={task.status} />
                    </TableCell>
                    <TableCell>
                      <StatusPill status={task.shipment.currentStatus} />
                    </TableCell>
                    {(canReassign || canRto) && (
                      <TableCell className="whitespace-nowrap text-right">
                        {canRto && RTO_FROM.has(task.shipment.currentStatus) && (
                          <RtoDialog
                            shipmentId={task.shipment.id}
                            lrNumber={task.shipment.lrNumber}
                            consigneeName={task.shipment.consigneeName}
                            attemptCount={task.shipment.attemptCount}
                            maxAttempts={
                              task.shipment.serviceType.maxDeliveryAttempts
                            }
                            reasons={rtoReasons}
                          />
                        )}
                        {canReassign && task.status === "PENDING" && (
                          <RemoveStopButton
                            taskId={task.id}
                            runId={run.id}
                            lrNumber={task.shipment.lrNumber}
                          />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableFrame>

        {run.tasks.some((task) => task.attempts.length > 0) && (
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Visits recorded on this run
            </h3>
            <ul className="flex flex-col gap-2 text-sm">
              {run.tasks.flatMap((task) =>
                task.attempts.map((attempt) => (
                  <li key={attempt.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-xs">
                      {task.shipment.lrNumber}
                    </span>
                    <span className="font-mono text-[0.65rem] text-muted-foreground tabular">
                      attempt {attempt.attemptNumber} ·{" "}
                      {format(attempt.attemptedAt, "dd MMM HH:mm")}
                    </span>
                    <span
                      className={
                        attempt.outcome === "COLLECTED" ? "text-ok" : "text-bad"
                      }
                    >
                      {attempt.outcome === "COLLECTED" ? "Delivered" : "Not delivered"}
                    </span>
                    {attempt.remarks && (
                      <span className="text-xs text-muted-foreground">
                        {attempt.remarks}
                      </span>
                    )}
                  </li>
                )),
              )}
            </ul>
            <p className="mt-3 max-w-prose text-xs text-muted-foreground">
              Every visit stays here whatever happened next. A shipment
              delivered on the second attempt still shows the first — which is
              the only way first-attempt success rate can be measured.
            </p>
          </div>
        )}
      </section>

      {canAssign && (
        <AddStopsPanel
          runId={run.id}
          branchCode={run.branch.code}
          candidates={candidates.map((shipment) => ({
            id: shipment.id,
            lrNumber: shipment.lrNumber,
            consigneeName: shipment.consigneeName,
            address: `${shipment.consigneeAddress}, ${shipment.consigneePincode}`,
            packageCount: shipment.packageCount,
            codAmount:
              shipment.paymentType === "COD" ? Number(shipment.codAmount ?? 0) : 0,
            attemptCount: shipment.attemptCount,
          }))}
        />
      )}

      {!canAssign && canReassign && run.status !== "PLANNED" && (
        <p className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          <MapPin className="size-4" />
          This run has left the branch. Stops can no longer be added or
          removed — record the outcome instead.
        </p>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn" | "bad";
}) {
  const toneClass =
    tone === "ok"
      ? "text-ok"
      : tone === "warn"
        ? "text-warn"
        : tone === "bad"
          ? "text-bad"
          : "";

  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card px-4 py-3">
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span className={`text-xl font-semibold tabular ${toneClass}`}>{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
