import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronRight, MapPin, Phone } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { deliveryRunScope } from "@/lib/delivery/runs";
import {
  fromStoredDate,
  shiftStoredDay,
  storedToday,
} from "@/lib/delivery/calendar";
import { TaskStatusPill } from "@/components/delivery/run-status-pill";
import { RunControls } from "@/components/delivery/run-controls";

export const metadata: Metadata = { title: "Today" };
export const dynamic = "force-dynamic";

/**
 * The agent's day.
 *
 * One screen, one run, one list worked from the top. Everything a person
 * standing on a pavement needs before they knock — who, where, how many
 * boxes, how much money — is visible without opening anything.
 */
export default async function FieldDeliveryPage() {
  const user = await requirePermission("delivery.read");

  // `runDate` is `@db.Date` — a UTC calendar day. Built from local
  // midnight, this window slid a day and an agent starting before 05:30 IST
  // could be shown yesterday's run as today's. See lib/delivery/calendar.ts.
  const horizon = shiftStoredDay(storedToday(), -1);

  const run = await prisma.deliveryRun.findFirst({
    // OWN scope resolves to "this agent's run". A wider role sees the
    // branch's runs and lands on the most recent one.
    where: { runDate: { gte: horizon }, status: { in: ["PLANNED", "STARTED"] }, ...deliveryRunScope(user) },
    orderBy: [{ runDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      number: true,
      status: true,
      runDate: true,
      totalTasks: true,
      completedTasks: true,
      failedTasks: true,
      codExpected: true,
      codCollected: true,
      branch: { select: { code: true, name: true } },
      tasks: {
        orderBy: [{ status: "asc" }, { priority: "desc" }, { sequence: "asc" }],
        select: {
          id: true,
          sequence: true,
          status: true,
          priority: true,
          attemptNumber: true,
          codAmount: true,
          shipment: {
            select: {
              lrNumber: true,
              packageCount: true,
              consigneeName: true,
              consigneePhone: true,
              consigneeAddress: true,
              consigneeLandmark: true,
              consigneePincode: true,
              specialInstructions: true,
              attemptCount: true,
            },
          },
        },
      },
    },
  });

  if (!run) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-20 text-center">
        <MapPin className="size-8 text-muted-foreground" />
        <p className="text-base font-medium">Nothing assigned yet</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Your branch has not built your run for today. Check with the desk
          before you set off.
        </p>
      </div>
    );
  }

  const pending = run.tasks.filter(
    (task) => task.status === "PENDING" || task.status === "OUT_FOR_DELIVERY",
  );
  const done = run.tasks.filter(
    (task) => task.status !== "PENDING" && task.status !== "OUT_FOR_DELIVERY",
  );

  const codExpected = Number(run.codExpected);
  const codCollected = Number(run.codCollected);

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      {/* Run summary */}
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
              {run.branch.code} · {format(fromStoredDate(run.runDate), "EEE dd MMM")}
            </p>
            <p className="font-mono text-lg font-semibold tracking-tight">
              {run.number}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular leading-none">
              {pending.length}
            </p>
            <p className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
              left
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <Tally label="Stops" value={run.totalTasks} />
          <Tally label="Delivered" value={run.completedTasks} tone="ok" />
          <Tally
            label="Attempted"
            value={run.failedTasks}
            tone={run.failedTasks > 0 ? "bad" : undefined}
          />
        </div>

        {codExpected > 0 && (
          <div className="flex items-baseline justify-between rounded-lg bg-warn-muted px-3 py-2">
            <span className="font-mono text-[0.65rem] uppercase tracking-wider text-warn">
              Cash you owe the branch
            </span>
            <span className="text-base font-semibold tabular text-warn">
              ₹{codCollected.toLocaleString("en-IN")}
              <span className="ml-1 text-xs font-normal opacity-70">
                of ₹{codExpected.toLocaleString("en-IN")}
              </span>
            </span>
          </div>
        )}

        <RunControls
          runId={run.id}
          status={run.status}
          pendingStops={pending.length}
        />
      </section>

      {/* Stops */}
      {pending.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            To deliver
          </h2>
          {pending.map((task) => (
            <TaskCard key={task.id} task={task} started={run.status === "STARTED"} />
          ))}
        </section>
      )}

      {done.length > 0 && (
        <section className="flex flex-col gap-3 pt-2">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Done — {done.length}
          </h2>
          {done.map((task) => (
            <TaskCard key={task.id} task={task} started muted />
          ))}
        </section>
      )}
    </div>
  );
}

function Tally({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "bad";
}) {
  const toneClass = tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : "";
  return (
    <div className="rounded-lg bg-muted px-2 py-2">
      <p className={`text-lg font-semibold tabular leading-none ${toneClass}`}>
        {value}
      </p>
      <p className="mt-1 font-mono text-[0.55rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

type CardTask = {
  id: string;
  sequence: number;
  status: "PENDING" | "OUT_FOR_DELIVERY" | "DELIVERED" | "FAILED" | "RETURNED" | "CANCELLED";
  priority: number;
  attemptNumber: number;
  codAmount: unknown;
  shipment: {
    lrNumber: string;
    packageCount: number;
    consigneeName: string;
    consigneePhone: string;
    consigneeAddress: string;
    consigneeLandmark: string | null;
    consigneePincode: string;
    specialInstructions: string | null;
    attemptCount: number;
  };
};

/**
 * One stop.
 *
 * Navigate and call sit outside the main tap target, because both get used
 * from a moving vehicle and neither should ever be hit by accident when
 * reaching for the stop itself.
 */
function TaskCard({
  task,
  started,
  muted,
}: {
  task: CardTask;
  started: boolean;
  muted?: boolean;
}) {
  const cod = Number(task.codAmount ?? 0);
  const address = `${task.shipment.consigneeAddress}, ${task.shipment.consigneePincode}`;
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

  return (
    <article
      className={`overflow-hidden rounded-xl border bg-card ${muted ? "opacity-70" : ""}`}
    >
      <Link
        href={`/delivery/task/${task.id}`}
        className="flex items-start gap-3 p-4 active:bg-muted"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-sm font-semibold tabular">
          {task.sequence}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold leading-tight">
              {task.shipment.consigneeName}
            </span>
            <TaskStatusPill status={task.status} />
          </span>

          <span className="text-sm leading-snug text-muted-foreground">
            {task.shipment.consigneeAddress}
            {task.shipment.consigneeLandmark
              ? ` · near ${task.shipment.consigneeLandmark}`
              : ""}
          </span>

          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 font-mono text-[0.7rem] text-muted-foreground">
            <span>{task.shipment.lrNumber}</span>
            <span>{task.shipment.packageCount} pkg</span>
            {task.attemptNumber > 1 && (
              <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 uppercase tracking-wider text-warn">
                attempt {task.attemptNumber}
              </span>
            )}
          </span>

          {cod > 0 && (
            <span className="mt-1 inline-flex w-fit items-baseline gap-1.5 rounded-md bg-warn-muted px-2 py-1">
              <span className="font-mono text-[0.6rem] uppercase tracking-wider text-warn">
                Collect
              </span>
              <span className="text-sm font-semibold tabular text-warn">
                ₹{cod.toLocaleString("en-IN")}
              </span>
            </span>
          )}

          {task.shipment.specialInstructions && (
            <span className="mt-1 rounded-md bg-info-muted px-2 py-1 text-xs text-info">
              {task.shipment.specialInstructions}
            </span>
          )}
        </span>

        <ChevronRight className="mt-1 size-5 shrink-0 text-muted-foreground" />
      </Link>

      {!muted && (
        <div className="grid grid-cols-2 border-t">
          <a
            href={mapsHref}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-12 items-center justify-center gap-2 border-r text-sm font-medium active:bg-muted"
          >
            <MapPin className="size-4" />
            Navigate
          </a>
          <a
            href={`tel:${task.shipment.consigneePhone}`}
            className="flex min-h-12 items-center justify-center gap-2 text-sm font-medium active:bg-muted"
          >
            <Phone className="size-4" />
            Call
          </a>
        </div>
      )}

      {!started && !muted && (
        <p className="border-t bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          Scan out at the branch before you set off — tap “Start run” above.
        </p>
      )}
    </article>
  );
}
