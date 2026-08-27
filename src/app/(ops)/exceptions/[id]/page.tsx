import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import {
  EscalationMark,
  ExceptionStatusPill,
  PriorityPill,
} from "@/components/exceptions/pills";
import { ExceptionWorkflow } from "@/components/exceptions/workflow";
import { KIND_DEFS, ageMinutes, kindLabel, transitionsFor } from "@/lib/exceptions/kinds";
import { SLA_STATE_LABEL, SLA_STATE_TONE, formatDuration } from "@/lib/sla/policy";
import { StatusPill } from "@/components/shipment/status-pill";
import {
  addNoteAction,
  assignExceptionAction,
  transitionExceptionAction,
} from "../actions";

export const metadata: Metadata = { title: "Exception" };
export const dynamic = "force-dynamic";

/**
 * One exception, with its action thread.
 *
 * The thread is the point. Status tells you where something got to;
 * the thread tells you what people actually did, which is the only thing
 * worth reading when the same consignment goes wrong again in a month.
 */
export default async function ExceptionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("exception.read");
  const { id } = await params;

  const exception = await prisma.exception.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      kind: true,
      priority: true,
      status: true,
      title: true,
      detail: true,
      detectedAt: true,
      escalateAt: true,
      escalationLevel: true,
      acknowledgedAt: true,
      resolvedAt: true,
      resolution: true,
      closedAt: true,
      source: true,
      assignedToId: true,
      branchId: true,
      ownerBranchId: true,
      branch: { select: { id: true, code: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      shipment: {
        select: {
          id: true,
          lrNumber: true,
          currentStatus: true,
          consigneeName: true,
          originBranch: { select: { code: true } },
          destinationBranch: { select: { code: true } },
          sla: {
            select: {
              state: true,
              dueAt: true,
              breachReason: true,
              varianceMinutes: true,
            },
          },
        },
      },
      actions: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          action: true,
          note: true,
          createdAt: true,
          userId: true,
        },
      },
    },
  });

  if (!exception) notFound();

  // Same rule as the list: your branches, or anything assigned to you.
  const visible =
    (exception.ownerBranchId && coversBranch(user, exception.ownerBranchId)) ||
    (exception.branchId && coversBranch(user, exception.branchId)) ||
    exception.assignedToId === user.id ||
    user.branchIds === null;

  if (!visible) notFound();

  const actorIds = [
    ...new Set(
      exception.actions
        .map((action) => action.userId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      })
    : [];
  const actorName = new Map(actors.map((actor) => [actor.id, actor.name]));

  const canAssign = can(user, "exception.assign");
  const transitions = transitionsFor(exception.status, user.permissions);

  const assignees = canAssign
    ? await prisma.user.findMany({
        where: {
          orgId: user.orgId,
          status: "ACTIVE",
          deletedAt: null,
          roles: {
            some: {
              role: {
                isActive: true,
                permissions: {
                  some: { permission: { code: "exception.resolve" } },
                },
              },
            },
          },
        },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
        take: 200,
      })
    : [];

  const def = KIND_DEFS[exception.kind];
  const now = new Date();

  return (
    <>
      <PageHeader
        eyebrow={`${kindLabel(exception.kind)} · ${exception.number}`}
        title={exception.title}
        description={exception.detail ?? undefined}
        actions={
          <Button
            variant="outline"
            size="sm"
            render={<Link href="/exceptions" />}
          >
            <ArrowLeft />
            Back to the tower
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <PriorityPill priority={exception.priority} />
        <ExceptionStatusPill status={exception.status} />
        <EscalationMark level={exception.escalationLevel} />
        <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
          Detected by {def?.detectedBy ?? exception.source}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── The thread ───────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            What has been done
          </h2>

          <ol className="flex flex-col gap-0">
            {exception.actions.map((action, index) => (
              <li key={action.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${
                      action.action === "ESCALATED"
                        ? "bg-bad"
                        : action.action === "RESOLVED" || action.action === "CLOSED"
                          ? "bg-ok"
                          : "bg-border"
                    }`}
                  />
                  {index < exception.actions.length - 1 && (
                    <span className="w-px flex-1 bg-border" />
                  )}
                </div>

                <div className="flex-1 pb-5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-mono text-[0.6rem] font-semibold uppercase tracking-wider">
                      {action.action.replace(/_/g, " ")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {action.userId
                        ? (actorName.get(action.userId) ?? "A user")
                        : "System"}
                      {" · "}
                      {format(action.createdAt, "dd MMM yyyy HH:mm")}
                    </span>
                  </div>
                  {action.note && (
                    <p className="mt-1 max-w-prose text-sm">{action.note}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          <div className="rounded-lg border bg-card p-4">
            <ExceptionWorkflow
              exceptionId={exception.id}
              transitions={transitions}
              assignees={assignees}
              currentAssigneeId={exception.assignedToId}
              canAssign={canAssign}
              transitionAction={transitionExceptionAction}
              assignAction={assignExceptionAction}
              noteAction={addNoteAction}
            />
          </div>
        </section>

        {/* ── The facts ────────────────────────────────── */}
        <aside className="flex flex-col gap-5">
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              This exception
            </h2>

            <Fact label="Opened">
              {format(exception.detectedAt, "dd MMM yyyy HH:mm")}
              <span className="ml-1 text-muted-foreground">
                ({formatDistanceToNow(exception.detectedAt, { addSuffix: true })})
              </span>
            </Fact>
            <Fact label="Age">
              {formatDuration(ageMinutes(exception, now))}
            </Fact>
            <Fact label="Owner branch">
              {exception.branch
                ? `${exception.branch.code} — ${exception.branch.name}`
                : "Not attributed"}
            </Fact>
            <Fact label="Assigned to">
              {exception.assignedTo?.name ?? "Nobody yet"}
            </Fact>
            <Fact label="Default owner">{def?.defaultOwner ?? "—"}</Fact>
            {exception.escalateAt && (
              <Fact label="Escalates">
                {format(exception.escalateAt, "dd MMM HH:mm")} if nobody acts
              </Fact>
            )}
            {exception.resolvedAt && (
              <Fact label="Resolved">
                {format(exception.resolvedAt, "dd MMM yyyy HH:mm")}
              </Fact>
            )}
            {exception.resolution && (
              <Fact label="Resolution">
                <span className="text-sm">{exception.resolution}</span>
              </Fact>
            )}
          </div>

          {exception.shipment && (
            <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
                The consignment
              </h2>

              <Link
                href={`/shipments/${exception.shipment.id}`}
                className="font-mono text-sm font-medium underline-offset-4 hover:underline"
              >
                {exception.shipment.lrNumber}
              </Link>

              <div>
                <StatusPill status={exception.shipment.currentStatus} />
              </div>

              <Fact label="Lane">
                {exception.shipment.originBranch.code} →{" "}
                {exception.shipment.destinationBranch.code}
              </Fact>
              <Fact label="Consignee">{exception.shipment.consigneeName}</Fact>

              {exception.shipment.sla && (
                <>
                  <Fact label="SLA">
                    <span
                      className={`inline-block rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider ${SLA_STATE_TONE[exception.shipment.sla.state]}`}
                    >
                      {SLA_STATE_LABEL[exception.shipment.sla.state]}
                    </span>
                  </Fact>
                  <Fact label="Due">
                    {format(exception.shipment.sla.dueAt, "dd MMM yyyy HH:mm")}
                  </Fact>
                  {exception.shipment.sla.varianceMinutes !== null && (
                    <Fact label="Against promise">
                      {exception.shipment.sla.varianceMinutes > 0
                        ? `${formatDuration(exception.shipment.sla.varianceMinutes)} late`
                        : `${formatDuration(exception.shipment.sla.varianceMinutes)} early`}
                    </Fact>
                  )}
                  {exception.shipment.sla.breachReason && (
                    <Fact label="Inferred cause">
                      {exception.shipment.sla.breachReason}
                    </Fact>
                  )}
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </span>
      <span className="text-sm">{children}</span>
    </div>
  );
}
