import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft, MapPin, Package, Phone } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { PickupCapture } from "@/components/pickup/pickup-capture";

export const metadata: Metadata = { title: "Collection" };
export const dynamic = "force-dynamic";

/**
 * One doorstep.
 *
 * Everything needed before knocking is above the fold, and the two things
 * that can happen — it was collected, or it was not — are the only controls
 * below it. A person doing this is standing up, holding boxes, and will not
 * scroll to find a button.
 *
 * The previous attempts are shown rather than summarised. "You came
 * yesterday and left" is a conversation that happens at the door, and the
 * executive should not be the last to know.
 */
export default async function FieldPickupTaskPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const user = await requirePermission("pickup.execute");
  const { assignmentId } = await params;

  const assignment = await prisma.pickupAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      status: true,
      startedAt: true,
      supersededAt: true,
      assignedToId: true,
      assignedTo: { select: { name: true } },
      attempts: {
        orderBy: { attemptNumber: "desc" },
        select: {
          attemptNumber: true,
          outcome: true,
          attemptedAt: true,
          remarks: true,
          packagesCollected: true,
          reasonCode: { select: { name: true } },
        },
      },
      request: {
        select: {
          id: true,
          number: true,
          branchId: true,
          status: true,
          contactName: true,
          phone: true,
          address: true,
          landmark: true,
          pincode: true,
          slot: true,
          requestedDate: true,
          expectedPackages: true,
          expectedWeight: true,
          goodsDescription: true,
          notes: true,
          city: { select: { name: true } },
          shipment: { select: { lrNumber: true } },
        },
      },
    },
  });

  if (!assignment || assignment.supersededAt) notFound();

  // Somebody else's stop. A wider role may look — a branch manager checking
  // a round — but an executive sees only their own, which is the same rule
  // the service enforces when the form is submitted.
  const own = assignment.assignedToId === user.id;
  if (!own && !can(user, "pickup.assign")) notFound();
  if (!coversBranch(user, assignment.request.branchId)) notFound();

  const reasons = await prisma.reasonCode.findMany({
    where: { category: "PICKUP_FAILURE", isActive: true },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });

  const done = assignment.status === "COMPLETED";

  return (
    <div className="flex flex-col gap-4 p-4">
      <Link
        href="/pickups/today"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ChevronLeft className="size-4" />
        All collections
      </Link>

      <header className="flex flex-col gap-1">
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
          {assignment.request.number}
          {assignment.request.shipment
            ? ` · ${assignment.request.shipment.lrNumber}`
            : " · no consignment yet"}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {assignment.request.contactName}
        </h1>
      </header>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <p className="flex items-start gap-2 text-sm">
          <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            {assignment.request.address}
            {assignment.request.landmark ? `, near ${assignment.request.landmark}` : ""}
            <br />
            {assignment.request.city.name}{" "}
            <span className="font-mono">{assignment.request.pincode}</span>
          </span>
        </p>

        <a
          href={`tel:${assignment.request.phone}`}
          className="flex items-center gap-2 text-sm font-medium text-primary"
        >
          <Phone className="size-4 shrink-0" aria-hidden />
          {assignment.request.phone}
        </a>

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Package className="size-3" aria-hidden />
            {assignment.request.expectedPackages ?? "?"} expected
          </span>
          {assignment.request.expectedWeight !== null && (
            <span>{Number(assignment.request.expectedWeight)} kg expected</span>
          )}
          <span className="font-mono uppercase tracking-wider">
            {assignment.request.slot.toLowerCase()}
          </span>
          <span>{format(assignment.request.requestedDate, "EEE d MMM")}</span>
        </div>

        {assignment.request.goodsDescription && (
          <p className="text-sm">{assignment.request.goodsDescription}</p>
        )}
        {assignment.request.notes && (
          <p className="rounded-md bg-muted px-3 py-2 text-sm">
            {assignment.request.notes}
          </p>
        )}
      </section>

      {assignment.attempts.length > 0 && (
        <section className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
            Previous visits
          </h2>
          <ul className="flex flex-col gap-2">
            {assignment.attempts.map((attempt) => (
              <li key={attempt.attemptNumber} className="text-sm">
                <span className="font-medium">
                  {attempt.outcome === "COLLECTED"
                    ? `Collected ${attempt.packagesCollected ?? "?"}`
                    : (attempt.reasonCode?.name ?? "Not collected")}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {format(attempt.attemptedAt, "d MMM HH:mm")}
                </span>
                {attempt.remarks && (
                  <p className="text-xs text-muted-foreground">{attempt.remarks}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {done ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          This collection is complete. Nothing further to do here.
        </p>
      ) : (
        <PickupCapture
          assignmentId={assignment.id}
          attemptNumber={(assignment.attempts[0]?.attemptNumber ?? 0) + 1}
          started={Boolean(assignment.startedAt)}
          expectedPackages={assignment.request.expectedPackages}
          reasons={reasons}
        />
      )}
    </div>
  );
}
