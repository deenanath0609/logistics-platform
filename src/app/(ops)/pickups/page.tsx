import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { MapPin, Phone } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { suggestExecutive, sequencePickups } from "@/lib/pickup/assignment";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { AssignDialog } from "./assign-dialog";
import { CreatePickupDialog } from "./create-dialog";
import { CancelPickupDialog } from "./cancel-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Pickups" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  REQUESTED: "bg-muted text-muted-foreground",
  ASSIGNED: "bg-accent text-accent-foreground",
  IN_PROGRESS: "bg-warn-muted text-warn",
  COMPLETED: "bg-ok-muted text-ok",
  FAILED: "bg-bad-muted text-bad",
  CANCELLED: "bg-bad-muted text-bad",
};

/**
 * The calendar day the desk is looking at, as a `date` column stores it.
 *
 * This window used to be built from local midnight, and it never matched.
 * `requestedDate` is `@db.Date`, and Prisma narrows a filter on one of those
 * to the UTC calendar day of whatever it is handed — so local midnight at
 * +5:30 went down as the *previous* day, and the desk asked for
 * `>= 30 August AND < 31 August` while meaning the 31st. Every pickup raised
 * for today was invisible on the day it mattered and appeared the morning
 * after, which is also why "0 scheduled" was the ordinary reading of a busy
 * branch.
 *
 * Taking the year, month and day the person means and rebuilding them at UTC
 * midnight is the same correction `asStoredDate` makes in
 * `lib/pickup/execute.ts`, for the same reason.
 */
function calendarDay(value?: string): Date {
  // `?date=` arrives as YYYY-MM-DD. Read the parts rather than parsing and
  // reading them back, which would put the day through the local offset
  // twice.
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (parts) {
    return new Date(
      Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])),
    );
  }

  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
  );
}

const SLOT_LABEL: Record<string, string> = {
  MORNING: "Morning",
  AFTERNOON: "Afternoon",
  EVENING: "Evening",
  ANYTIME: "Anytime",
};

export default async function PickupsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; date?: string }>;
}) {
  const user = await requirePermission("pickup.read");
  const canAssign = can(user, "pickup.assign");
  const canCreate = can(user, "pickup.create");
  const canCancel = can(user, "pickup.cancel");
  const { q, date } = await searchParams;

  // Default to today — a pickup desk works a day at a time.
  const dayStart = calendarDay(date);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const where = {
    ...branchScope(user, "branchId"),
    requestedDate: { gte: dayStart, lt: dayEnd },
    ...(q
      ? {
          OR: [
            { number: { contains: q, mode: "insensitive" as const } },
            { contactName: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
            { pincode: { contains: q } },
          ],
        }
      : {}),
  };

  const [requests, executives, branches, cities, customers] = await Promise.all([
    prisma.pickupRequest.findMany({
      where,
      orderBy: [{ priority: "desc" }, { slot: "asc" }, { pincode: "asc" }],
      include: {
        city: { select: { name: true, code: true } },
        customer: { select: { id: true, name: true, code: true } },
        shipment: { select: { id: true, lrNumber: true } },
        assignments: {
          where: { supersededAt: null },
          include: { assignedTo: { select: { id: true, name: true } } },
        },
      },
    }),
    // Pickup executives at branches this user covers, with today's load.
    prisma.user.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        isFieldUser: true,
        roles: { some: { role: { code: "PICKUP_EXEC" } } },
        ...branchScope(user, "primaryBranchId"),
      },
      select: {
        id: true,
        name: true,
        pickupAssignments: {
          where: {
            supersededAt: null,
            request: { requestedDate: { gte: dayStart, lt: dayEnd } },
          },
          select: { request: { select: { expectedPackages: true } } },
        },
      },
    }),
    // What the create dialog offers. Branch-scoped, because the action
    // rejects a branch outside the actor's scope anyway and offering one is
    // offering a mistake.
    canCreate
      ? prisma.branch.findMany({
          where: { isActive: true, deletedAt: null, ...branchScope(user, "id") },
          orderBy: { code: "asc" },
          select: { id: true, code: true, name: true },
        })
      : Promise.resolve([]),
    canCreate
      ? prisma.city.findMany({
          where: { isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, code: true, name: true },
        })
      : Promise.resolve([]),
    canCreate
      ? prisma.customer.findMany({
          where: {
            isActive: true,
            deletedAt: null,
            ...branchScope(user, "branchId"),
          },
          orderBy: { name: "asc" },
          take: 500,
          select: { id: true, code: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const loads = executives.map((executive) => ({
    userId: executive.id,
    name: executive.name,
    assigned: executive.pickupAssignments.length,
    packages: executive.pickupAssignments.reduce(
      (sum, a) => sum + (a.request.expectedPackages ?? 1),
      0,
    ),
  }));

  const suggested = suggestExecutive(loads);

  const choices = loads.map((load) => ({
    id: load.userId,
    name: load.name,
    assigned: load.assigned,
    packages: load.packages,
    suggested: load.userId === suggested?.userId,
  }));

  // Sequenced view for the run order, using the shared pure helper so the
  // list and the field app agree on what "next" means.
  const ordered = sequencePickups(
    requests.map((r) => ({
      id: r.id,
      slot: r.slot,
      priority: r.priority,
      expectedPackages: r.expectedPackages,
      pincode: r.pincode,
      requestedDate: r.requestedDate,
    })),
  );
  const orderIndex = new Map(ordered.map((p, i) => [p.id, i + 1]));
  const rows = [...requests].sort(
    (a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0),
  );

  const pending = rows.filter((r) => r.status === "REQUESTED").length;

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Pickups"
        description={`${format(dayStart, "EEEE d MMMM")} · ${rows.length} scheduled, ${pending} unassigned.`}
        actions={
          <div className="flex items-center gap-2">
            <SearchInput placeholder="Number, name, phone, PIN" />
            {canCreate && (
              <CreatePickupDialog
                branches={branches}
                cities={cities}
                customers={customers}
                defaultBranchId={user.primaryBranch?.id ?? null}
              />
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        {choices.map((choice) => (
          <div
            key={choice.id}
            className="flex items-baseline gap-2 rounded-md border bg-card px-3 py-1.5"
          >
            <span className="text-sm font-medium">{choice.name}</span>
            <span className="font-mono text-xs text-muted-foreground tabular">
              {choice.assigned} · {choice.packages} pkg
            </span>
          </div>
        ))}
        {choices.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No pickup executives at your branch yet.
          </p>
        )}
      </div>

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "Nothing scheduled today"}
            description={
              q
                ? "Try the pickup number or a phone number."
                : "Pickups raised at booking, or by a customer, appear here on their requested date."
            }
          />
        ) : (
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Pickup</TableHead>
                <TableHead>Consignor</TableHead>
                <TableHead>Where</TableHead>
                <TableHead>Slot</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead>Assigned to</TableHead>
                <TableHead>Status</TableHead>
                {(canAssign || canCancel) && (
                  <TableHead className="text-right">Action</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((request) => {
                const assignment = request.assignments[0];
                return (
                  <TableRow key={request.id}>
                    <TableCell className="tabular text-muted-foreground">
                      {orderIndex.get(request.id)}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs font-medium">
                        {request.number}
                      </span>
                      {request.shipment && (
                        <Link
                          href={`/shipments/${request.shipment.id}`}
                          className="ml-2 font-mono text-[0.65rem] text-primary hover:underline"
                        >
                          {request.shipment.lrNumber}
                        </Link>
                      )}
                      {request.priority > 0 && (
                        <span className="ml-2 rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-warn">
                          P{request.priority}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{request.contactName}</span>
                      <span className="ml-2 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                        <Phone className="size-3" />
                        {request.phone}
                      </span>
                      {request.customer && (
                        <Link
                          href={`/customers/${request.customer.id}`}
                          className="ml-2 text-xs text-muted-foreground hover:underline"
                        >
                          {request.customer.code}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[220px]">
                      <span className="flex items-start gap-1 text-xs text-muted-foreground">
                        <MapPin className="mt-0.5 size-3 shrink-0" />
                        <span className="truncate">
                          {request.city.name}{" "}
                          <span className="font-mono">{request.pincode}</span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {SLOT_LABEL[request.slot]}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-xs tabular">
                      {request.expectedPackages ?? "—"} pkg
                      {request.expectedWeight
                        ? ` · ${Number(request.expectedWeight)} kg`
                        : ""}
                    </TableCell>
                    <TableCell className="text-sm">
                      {assignment?.assignedTo.name ?? (
                        <span className="text-warn">unassigned</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${STATUS_TONE[request.status]}`}
                      >
                        {request.status.replace("_", " ")}
                      </span>
                    </TableCell>
                    {(canAssign || canCancel) && (
                      <TableCell className="text-right">
                        {["REQUESTED", "ASSIGNED", "IN_PROGRESS"].includes(
                          request.status,
                        ) && (
                          <span className="flex items-center justify-end gap-1">
                            {canAssign && (
                              <AssignDialog
                                pickupId={request.id}
                                pickupNumber={request.number}
                                executives={choices}
                                currentAssigneeId={assignment?.assignedTo.id}
                                nextSequence={orderIndex.get(request.id) ?? 0}
                              />
                            )}
                            {canCancel && (
                              <CancelPickupDialog
                                pickupId={request.id}
                                pickupNumber={request.number}
                                assigneeName={assignment?.assignedTo.name}
                              />
                            )}
                          </span>
                        )}
                      </TableCell>
                    )}
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
