import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronRight, MapPin, Phone, Package } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { sequencePickups } from "@/lib/pickup/assignment";

export const metadata: Metadata = { title: "Collections" };
export const dynamic = "force-dynamic";

/**
 * The pickup executive's day.
 *
 * The counterpart to `/delivery` and deliberately the same shape: one
 * screen, one list, worked from the top, with everything a person needs
 * before they ring a bell — who, where, how many boxes and what was
 * promised — visible without opening anything.
 *
 * The order comes from `sequencePickups`, which is the branch's default
 * rather than a route: priority first, then the slot the consignor was
 * given, then pincode so nearby stops cluster, then age so a request does
 * not sit forever behind newer ones.
 */
export default async function FieldPickupsPage() {
  const user = await requirePermission("pickup.execute");

  // Today, plus anything still open from yesterday. A pickup that failed
  // late is on this list first thing, which is when it is most likely to
  // succeed — and a person who worked past midnight has not lost their run.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setDate(from.getDate() - 1);

  const assignments = await prisma.pickupAssignment.findMany({
    where: {
      supersededAt: null,
      status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      // A wider role — a branch manager checking a round — sees the
      // branch's work. An executive's own scope resolves to themselves.
      ...(can(user, "pickup.assign") ? {} : { assignedToId: user.id }),
      request: {
        requestedDate: { gte: from },
        status: { notIn: ["CANCELLED", "COMPLETED"] },
        // Branch-scoped as well as person-scoped, and the two are not the
        // same thing. A network-scoped dispatcher can assign a stop at one
        // branch to an executive who covers another; without this the stop
        // appeared on their list and then 404'd when they tapped it,
        // because the task screen checks `coversBranch` and this did not.
        // A list that shows work its owner cannot open is worse than one
        // that shows nothing.
        ...branchScope(user, "branchId"),
      },
    },
    orderBy: [{ sequence: "asc" }, { assignedAt: "asc" }],
    select: {
      id: true,
      sequence: true,
      status: true,
      startedAt: true,
      assignedTo: { select: { name: true } },
      attempts: { select: { attemptNumber: true }, orderBy: { attemptNumber: "desc" }, take: 1 },
      request: {
        select: {
          id: true,
          number: true,
          contactName: true,
          phone: true,
          address: true,
          landmark: true,
          pincode: true,
          slot: true,
          priority: true,
          requestedDate: true,
          expectedPackages: true,
          goodsDescription: true,
          notes: true,
          createdAt: true,
          city: { select: { name: true } },
          shipment: { select: { lrNumber: true } },
        },
      },
    },
  });

  const ordered = sequencePickups(
    assignments.map((a) => ({
      id: a.id,
      slot: a.request.slot,
      priority: a.request.priority,
      pincode: a.request.pincode,
      createdAt: a.request.createdAt,
      requestedDate: a.request.requestedDate,
      expectedPackages: a.request.expectedPackages,
    })),
  );
  const byId = new Map(assignments.map((a) => [a.id, a]));
  const stops = ordered.map((o) => byId.get(o.id)!).filter(Boolean);

  const done = stops.filter((s) => s.status === "IN_PROGRESS").length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
          Collections · {format(today, "EEE d MMM")}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {stops.length === 0
            ? "Nothing to collect"
            : `${stops.length} ${stops.length === 1 ? "stop" : "stops"}`}
        </h1>
        {done > 0 && (
          <p className="text-sm text-muted-foreground">{done} in progress</p>
        )}
      </header>

      {stops.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing is assigned to you right now. New collections appear here as
          soon as the branch assigns them — no need to refresh.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {stops.map((stop, index) => {
            const attempt = stop.attempts[0]?.attemptNumber ?? 0;

            return (
              <li key={stop.id}>
                <Link
                  href={`/pickups/task/${stop.id}`}
                  className="flex items-start gap-3 rounded-lg border bg-card p-4 active:bg-accent"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-sm font-semibold text-primary">
                    {index + 1}
                  </span>

                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{stop.request.contactName}</span>
                      {stop.status === "IN_PROGRESS" && (
                        <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-warn">
                          On the way
                        </span>
                      )}
                      {attempt > 0 && (
                        <span className="rounded-sm bg-bad-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-bad">
                          Attempt {attempt + 1}
                        </span>
                      )}
                    </div>

                    <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                      <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span className="min-w-0">
                        {stop.request.address}
                        {stop.request.landmark ? `, near ${stop.request.landmark}` : ""}
                        <br />
                        {stop.request.city.name}{" "}
                        <span className="font-mono">{stop.request.pincode}</span>
                      </span>
                    </p>

                    <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1 font-mono">
                        <Phone className="size-3" aria-hidden />
                        {stop.request.phone}
                      </span>
                      {stop.request.expectedPackages !== null && (
                        <span className="flex items-center gap-1">
                          <Package className="size-3" aria-hidden />
                          {stop.request.expectedPackages} expected
                        </span>
                      )}
                      <span className="font-mono uppercase tracking-wider">
                        {stop.request.slot.toLowerCase()}
                      </span>
                    </p>
                  </div>

                  <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
