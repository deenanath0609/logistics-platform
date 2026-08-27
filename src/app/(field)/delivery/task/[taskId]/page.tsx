import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft, MapPin, Phone } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { deliveryTaskScope } from "@/lib/delivery/runs";
import { attemptsRemaining } from "@/lib/delivery/attempts";
import { TaskStatusPill } from "@/components/delivery/run-status-pill";
import { DoorActions } from "@/components/delivery/door-actions";

export const metadata: Metadata = { title: "Stop" };
export const dynamic = "force-dynamic";

/**
 * The door.
 *
 * Everything the agent needs while someone is standing in front of them,
 * and nothing else. Note what is *not* here: no shipment history, no
 * charges, no internal branch names. A consignee reading over a shoulder
 * should learn nothing about the network.
 */
export default async function FieldTaskPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const user = await requirePermission("delivery.execute");
  const { taskId } = await params;

  // Scoped in the query, not after it: an agent has OWN scope and must not
  // be able to read another agent's stop by guessing an id.
  const task = await prisma.deliveryTask.findFirst({
    where: { id: taskId, ...deliveryTaskScope(user) },
    select: {
      id: true,
      status: true,
      sequence: true,
      attemptNumber: true,
      codAmount: true,
      branchId: true,
      completedAt: true,
      run: { select: { id: true, number: true, agentId: true, status: true } },
      shipment: {
        select: {
          id: true,
          lrNumber: true,
          packageCount: true,
          goodsDescription: true,
          specialInstructions: true,
          isFragile: true,
          attemptCount: true,
          paymentType: true,
          codAmount: true,
          consigneeName: true,
          consigneePhone: true,
          consigneeAddress: true,
          consigneeLandmark: true,
          consigneePincode: true,
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
          reasonCodeId: true,
        },
      },
      pod: { select: { id: true, receiverName: true, deliveredAt: true } },
    },
  });

  if (!task) notFound();

  const reasonCodes = await prisma.reasonCode.findMany({
    where: { category: "DELIVERY_FAILURE", isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      code: true,
      name: true,
      description: true,
      requiresPhoto: true,
      requiresRemarks: true,
      triggersReattempt: true,
      isChargeable: true,
    },
  });

  const { shipment } = task;
  const cod =
    shipment.paymentType === "COD" ? Number(shipment.codAmount ?? 0) : 0;
  const address = `${shipment.consigneeAddress}, ${shipment.consigneePincode}`;
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

  const remaining = attemptsRemaining(
    { attemptCount: shipment.attemptCount },
    shipment.serviceType,
  );

  const settled = task.status !== "PENDING" && task.status !== "OUT_FOR_DELIVERY";

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      <Link
        href="/delivery"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground active:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Today’s run
      </Link>

      {/* Who and where */}
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xl font-semibold leading-tight">
              {shipment.consigneeName}
            </p>
            <p className="font-mono text-[0.7rem] uppercase tracking-wider text-muted-foreground">
              stop {task.sequence} · {shipment.lrNumber}
            </p>
          </div>
          <TaskStatusPill status={task.status} className="mt-1 shrink-0" />
        </div>

        <p className="text-sm leading-snug">
          {shipment.consigneeAddress}
          {shipment.consigneeLandmark && (
            <span className="text-muted-foreground">
              {" "}
              · near {shipment.consigneeLandmark}
            </span>
          )}
          <span className="ml-1 font-mono">{shipment.consigneePincode}</span>
        </p>

        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.7rem] text-muted-foreground">
          <span>{shipment.packageCount} package{shipment.packageCount > 1 ? "s" : ""}</span>
          <span>{shipment.goodsDescription}</span>
          {shipment.isFragile && (
            <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 uppercase tracking-wider text-warn">
              fragile
            </span>
          )}
        </div>

        {shipment.specialInstructions && (
          <p className="rounded-lg bg-info-muted px-3 py-2 text-sm text-info">
            {shipment.specialInstructions}
          </p>
        )}

        {cod > 0 && (
          <div className="flex items-baseline justify-between rounded-lg bg-warn-muted px-3 py-2.5">
            <span className="font-mono text-[0.65rem] uppercase tracking-wider text-warn">
              Collect before handing over
            </span>
            <span className="text-lg font-semibold tabular text-warn">
              ₹{cod.toLocaleString("en-IN")}
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <a
            href={mapsHref}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-12 items-center justify-center gap-2 rounded-lg border text-sm font-medium active:bg-muted"
          >
            <MapPin className="size-4" />
            Navigate
          </a>
          <a
            href={`tel:${shipment.consigneePhone}`}
            className="flex min-h-12 items-center justify-center gap-2 rounded-lg border text-sm font-medium active:bg-muted"
          >
            <Phone className="size-4" />
            Call
          </a>
        </div>
      </section>

      {/* Previous visits. The reason this whole module exists. */}
      {task.attempts.length > 0 || shipment.attemptCount > 0 ? (
        <section className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-warn-muted/40 p-4">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-warn">
            Attempt {task.attemptNumber} of {shipment.serviceType.maxDeliveryAttempts}
          </p>
          <p className="text-sm">
            {shipment.attemptCount === 0
              ? "First visit."
              : `${shipment.attemptCount} visit${shipment.attemptCount > 1 ? "s" : ""} already made. ${
                  remaining <= 1
                    ? "This is the last attempt before it goes back to the sender."
                    : `${remaining} attempts left.`
                }`}
          </p>
          {task.attempts.map((attempt) => (
            <p key={attempt.id} className="font-mono text-[0.7rem] text-muted-foreground">
              #{attempt.attemptNumber} · {format(attempt.attemptedAt, "dd MMM HH:mm")} ·{" "}
              {attempt.outcome === "COLLECTED" ? "delivered" : "not delivered"}
              {attempt.remarks ? ` · ${attempt.remarks}` : ""}
            </p>
          ))}
        </section>
      ) : null}

      {settled ? (
        <section className="rounded-xl border bg-card p-4">
          <p className="text-sm font-medium">
            {task.status === "DELIVERED"
              ? `Delivered${task.pod ? ` to ${task.pod.receiverName}` : ""}`
              : "Outcome already recorded"}
          </p>
          {task.completedAt && (
            <p className="font-mono text-xs text-muted-foreground">
              {format(task.completedAt, "dd MMM yyyy · HH:mm")}
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Nothing more to do here. Speak to the branch if this is wrong — a
            correction is a new entry, never an edit.
          </p>
        </section>
      ) : (
        <DoorActions
          taskId={task.id}
          lrNumber={shipment.lrNumber}
          consigneeName={shipment.consigneeName}
          codAmount={cod}
          runStarted={task.run?.status === "STARTED"}
          reasonCodes={reasonCodes.map((reason) => ({
            id: reason.id,
            code: reason.code,
            name: reason.name,
            description: reason.description,
            requiresPhoto: reason.requiresPhoto,
            requiresRemarks: reason.requiresRemarks,
            triggersReattempt: reason.triggersReattempt,
            isChargeable: reason.isChargeable,
          }))}
        />
      )}
    </div>
  );
}
