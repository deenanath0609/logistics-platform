import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { Thread, ReplyBox, type ThreadMessage } from "@/components/complaints/thread";
import { WorkflowActions } from "@/components/complaints/workflow-actions";
import {
  ComplaintStatusPill,
  PriorityMark,
  SlaPill,
} from "@/components/complaints/pills";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/shipment/status-pill";
import {
  ageMinutes,
  breachState,
  formatAge,
  minutesRemaining,
  slaFor,
} from "@/lib/complaints/sla";
import { CATEGORY_LABEL, allowedTransitions } from "@/lib/complaints/workflow";
import { addMessageAction, transitionAction } from "../actions";

export const metadata: Metadata = { title: "Complaint" };
export const dynamic = "force-dynamic";

export default async function ComplaintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("complaint.read");
  const { id } = await params;

  const complaint = await prisma.complaint.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      category: true,
      priority: true,
      status: true,
      subject: true,
      description: true,
      createdAt: true,
      respondBy: true,
      resolveBy: true,
      firstResponseAt: true,
      resolvedAt: true,
      resolution: true,
      closedAt: true,
      reopenedAt: true,
      branchId: true,
      assignedToId: true,
      assignedTo: { select: { id: true, name: true } },
      branch: { select: { code: true, name: true } },
      customer: { select: { id: true, name: true } },
      shipment: { select: { id: true, lrNumber: true, currentStatus: true } },
      raisedByUserId: true,
      raisedByCustomerUser: { select: { name: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          body: true,
          isInternal: true,
          createdAt: true,
          authorUser: { select: { name: true } },
          authorCustomerUser: { select: { name: true } },
        },
      },
    },
  });

  if (!complaint) notFound();

  // Branch scope, with the same exception the list makes: whoever owns it
  // can open it wherever it was raised.
  const visible =
    complaint.assignedToId === user.id ||
    !complaint.branchId ||
    coversBranch(user, complaint.branchId);
  if (!visible) notFound();

  const raisedBy = await raisedByName(
    complaint.raisedByCustomerUser?.name ?? null,
    complaint.raisedByUserId,
  );
  const writable = can(user, "complaint.create");
  const now = new Date();
  const sla = breachState(complaint, now);
  const target = slaFor(complaint.category, complaint.priority);

  const transitions = allowedTransitions(complaint.status).filter((transition) =>
    can(user, transition.permission),
  );

  const assignees = writable
    ? await prisma.user.findMany({
        where: {
          orgId: user.orgId,
          status: "ACTIVE",
          deletedAt: null,
          roles: {
            some: {
              role: {
                isActive: true,
                permissions: { some: { permission: { code: "complaint.resolve" } } },
              },
            },
          },
        },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
        take: 200,
      })
    : [];

  const messages: ThreadMessage[] = complaint.messages.map((message) => ({
    id: message.id,
    body: message.body,
    isInternal: message.isInternal,
    authorName:
      message.authorUser?.name ??
      message.authorCustomerUser?.name ??
      "System",
    authorSide: message.authorCustomerUser ? "customer" : "staff",
    at: format(message.createdAt, "dd MMM yyyy, HH:mm"),
  }));

  return (
    <>
      <PageHeader
        eyebrow="Exceptions"
        title={complaint.subject}
        description={`${complaint.number} · ${CATEGORY_LABEL[complaint.category] ?? complaint.category}`}
        actions={
          <Button variant="outline" size="sm" render={<Link href="/complaints" />}>
            <ChevronLeft />
            All complaints
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <ComplaintStatusPill status={complaint.status} />
            <PriorityMark priority={complaint.priority} />
            {complaint.shipment && (
              <Link
                href={`/shipments/${complaint.shipment.id}`}
                className="flex items-center gap-1.5 font-mono text-xs underline-offset-4 hover:underline"
              >
                {complaint.shipment.lrNumber}
                <StatusPill status={complaint.shipment.currentStatus} />
              </Link>
            )}
          </div>

          <Thread
            description={complaint.description}
            raisedBy={raisedBy}
            raisedAt={format(complaint.createdAt, "dd MMM yyyy, HH:mm")}
            messages={messages}
          />

          {writable && (
            <ReplyBox
              complaintId={complaint.id}
              action={addMessageAction}
              canReply
            />
          )}
        </div>

        {/* ── Right rail: the clocks and the workflow ────────── */}
        <aside className="flex flex-col gap-6">
          <section className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              SLA
            </h2>

            <Clock
              label="Response"
              state={sla.response}
              target={formatAge(target.responseMinutes)}
              deadline={complaint.respondBy}
              completedAt={complaint.firstResponseAt}
              now={now}
            />
            <Clock
              label="Resolution"
              state={sla.resolution}
              target={formatAge(target.resolutionMinutes)}
              deadline={complaint.resolveBy}
              completedAt={complaint.resolvedAt}
              now={now}
            />

            <p className="border-t pt-2 text-xs text-muted-foreground">
              Open {formatAge(ageMinutes(complaint, now))}
              {complaint.reopenedAt &&
                ` · reopened ${format(complaint.reopenedAt, "dd MMM")}`}
            </p>
          </section>

          <section className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Details
            </h2>
            <Detail label="Owner" value={complaint.assignedTo?.name ?? "Unassigned"} />
            <Detail
              label="Customer"
              value={complaint.customer?.name ?? "No linked account"}
            />
            <Detail
              label="Branch"
              value={
                complaint.branch
                  ? `${complaint.branch.code} — ${complaint.branch.name}`
                  : "—"
              }
            />
            <Detail label="Raised by" value={raisedBy} />
            {complaint.closedAt && (
              <Detail
                label="Closed"
                value={format(complaint.closedAt, "dd MMM yyyy, HH:mm")}
              />
            )}
          </section>

          {complaint.resolution && (
            <section className="flex flex-col gap-1.5 rounded-lg border border-ok/40 bg-ok-muted p-3">
              <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-ok">
                Resolution
              </h2>
              <p className="whitespace-pre-wrap text-sm text-ok">
                {complaint.resolution}
              </p>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Workflow
            </h2>
            <WorkflowActions
              complaintId={complaint.id}
              transitions={transitions}
              assignees={assignees}
              action={transitionAction}
            />
          </section>
        </aside>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────

function Clock({
  label,
  state,
  target,
  deadline,
  completedAt,
  now,
}: {
  label: string;
  state: ReturnType<typeof breachState>["response"];
  target: string;
  deadline: Date | null;
  completedAt: Date | null;
  now: Date;
}) {
  const remaining = minutesRemaining(deadline, now);

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        <span className="font-mono text-[0.6rem] text-muted-foreground">
          target {target}
        </span>
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <SlaPill state={state} />
        <span className="font-mono text-[0.6rem] text-muted-foreground tabular">
          {completedAt
            ? format(completedAt, "dd MMM HH:mm")
            : remaining === null
              ? "—"
              : remaining >= 0
                ? `in ${formatAge(remaining)}`
                : `${formatAge(-remaining)} late`}
        </span>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{value}</span>
    </div>
  );
}

/**
 * Exactly one of the two raiser columns is set. The customer side wins the
 * label because "who complained" reads differently when it was the account
 * itself rather than a support agent logging a phone call.
 */
async function raisedByName(
  customerUserName: string | null,
  staffUserId: string | null,
): Promise<string> {
  if (customerUserName) return `${customerUserName} (customer)`;
  if (!staffUserId) return "Unknown";

  const staff = await prisma.user.findUnique({
    where: { id: staffUserId },
    select: { name: true },
  });
  return staff?.name ?? "Unknown";
}
