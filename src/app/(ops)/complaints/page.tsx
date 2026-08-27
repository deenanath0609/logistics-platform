import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";

import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { FilterChips, FilterSelect } from "@/components/fleet/filter-chips";
import { NewComplaintDialog } from "@/components/complaints/new-complaint";
import {
  ComplaintStatusPill,
  PriorityMark,
  SlaPill,
} from "@/components/complaints/pills";
import {
  ageMinutes,
  breachState,
  formatAge,
  minutesRemaining,
} from "@/lib/complaints/sla";
import { CATEGORY_LABEL, LIVE, PRIORITY_LABEL } from "@/lib/complaints/workflow";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createComplaintAction } from "./actions";

export const metadata: Metadata = { title: "Complaints" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const VIEWS = {
  live: { label: "Open", statuses: LIVE },
  unassigned: { label: "Unassigned", statuses: LIVE },
  mine: { label: "Mine", statuses: LIVE },
  resolved: { label: "Resolved", statuses: ["RESOLVED"] as const },
  closed: { label: "Closed", statuses: ["CLOSED"] as const },
} as const;

type ViewKey = keyof typeof VIEWS;

export default async function ComplaintsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    view?: string;
    category?: string;
    priority?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("complaint.read");
  const writable = can(user, "complaint.create");

  const { q, view: viewParam, category, priority, page: pageParam } = await searchParams;
  const view: ViewKey =
    viewParam && viewParam in VIEWS ? (viewParam as ViewKey) : "live";
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  // Branch scope applies, with one deliberate exception: a complaint
  // assigned to you is yours to work on wherever it was raised. Without
  // that, routing a Delhi complaint to the claims desk in Mumbai would
  // hide it from the person who has to answer it.
  const scope =
    user.branchIds === null
      ? {}
      : {
          OR: [branchScope(user, "branchId"), { assignedToId: user.id }],
        };

  const where = {
    ...scope,
    ...viewFilter(view, user.id),
    ...(category ? { category: category as never } : {}),
    ...(priority ? { priority: priority as never } : {}),
    ...(q
      ? {
          OR: [
            { number: { contains: q, mode: "insensitive" as const } },
            { subject: { contains: q, mode: "insensitive" as const } },
            { shipment: { lrNumber: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [rows, total, counts] = await Promise.all([
    prisma.complaint.findMany({
      where,
      // Priority first, then oldest: the duty manager's reading order is
      // "what is worst" then "what has waited longest", and the list should
      // not make them sort it themselves.
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        number: true,
        category: true,
        priority: true,
        status: true,
        subject: true,
        createdAt: true,
        respondBy: true,
        resolveBy: true,
        firstResponseAt: true,
        resolvedAt: true,
        assignedTo: { select: { name: true } },
        branch: { select: { code: true } },
        customer: { select: { name: true } },
        shipment: { select: { id: true, lrNumber: true } },
      },
    }),
    prisma.complaint.count({ where }),
    Promise.all(
      (Object.keys(VIEWS) as ViewKey[]).map(async (key) => ({
        key,
        label: VIEWS[key].label,
        count: await prisma.complaint.count({
          where: { ...scope, ...viewFilter(key, user.id) },
        }),
      })),
    ),
  ]);

  const now = new Date();
  const assignees = writable ? await loadAssignees(user.orgId) : [];

  return (
    <>
      <PageHeader
        eyebrow="Exceptions"
        title="Complaints"
        description="Every complaint carries two clocks: how long the customer waited to hear from a person, and how long they waited for an answer. Nothing closes without a resolution note."
        actions={
          writable && (
            <NewComplaintDialog
              action={createComplaintAction}
              assignees={assignees}
            />
          )
        }
      />

      <FilterChips
        param="view"
        selected={view}
        chips={counts.map((row) => ({
          key: row.key,
          label: row.label,
          count: row.count,
          tone: row.key === "unassigned" ? ("warn" as const) : undefined,
        }))}
        extra={
          <>
            <SearchInput placeholder="Number, subject or LR" />
            <FilterSelect
              param="category"
              label="Any category"
              value={category}
              options={Object.entries(CATEGORY_LABEL).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <FilterSelect
              param="priority"
              label="Any priority"
              value={priority}
              options={Object.entries(PRIORITY_LABEL).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </>
        }
      />

      {rows.length === 0 ? (
        <TableFrame>
          <EmptyState
            title="Nothing here"
            description="No complaint matches this view."
          />
        </TableFrame>
      ) : (
        <>
          <TableFrame>
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>LR</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead>Response</TableHead>
                  <TableHead>Resolution</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const sla = breachState(row, now);
                  const age = ageMinutes(row, now);

                  return (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap">
                        <Link
                          href={`/complaints/${row.id}`}
                          className="font-mono text-xs font-medium underline-offset-4 hover:underline"
                        >
                          {row.number}
                        </Link>
                        <div className="mt-0.5">
                          <PriorityMark priority={row.priority} />
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[260px]">
                        <p className="truncate text-sm font-medium">{row.subject}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {row.customer?.name ?? "No account"}
                          {row.branch && ` · ${row.branch.code}`}
                        </p>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {CATEGORY_LABEL[row.category] ?? row.category}
                      </TableCell>
                      <TableCell>
                        {row.shipment ? (
                          <Link
                            href={`/shipments/${row.shipment.id}`}
                            className="font-mono text-xs underline-offset-4 hover:underline"
                          >
                            {row.shipment.lrNumber}
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.assignedTo?.name ?? (
                          <span className="text-warn">Unassigned</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs tabular">
                        {formatAge(age)}
                      </TableCell>
                      <TableCell>
                        <SlaPill state={sla.response} />
                        <p className="mt-0.5 font-mono text-[0.6rem] text-muted-foreground tabular">
                          {due(row.respondBy, row.firstResponseAt, now)}
                        </p>
                      </TableCell>
                      <TableCell>
                        <SlaPill state={sla.resolution} />
                        <p className="mt-0.5 font-mono text-[0.6rem] text-muted-foreground tabular">
                          {due(row.resolveBy, row.resolvedAt, now)}
                        </p>
                      </TableCell>
                      <TableCell>
                        <ComplaintStatusPill status={row.status} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableFrame>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            baseParams={{ q, view, category, priority }}
            pathname="/complaints"
          />
        </>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────

function viewFilter(view: ViewKey, userId: string) {
  switch (view) {
    case "unassigned":
      return { status: { in: [...LIVE] }, assignedToId: null };
    case "mine":
      return { status: { in: [...LIVE] }, assignedToId: userId };
    case "resolved":
      return { status: "RESOLVED" as const };
    case "closed":
      return { status: "CLOSED" as const };
    case "live":
    default:
      return { status: { in: [...LIVE] } };
  }
}

/** "in 3 h" while running, "2 d 4 h late" once it has gone. */
function due(deadline: Date | null, completedAt: Date | null, now: Date): string {
  if (!deadline) return "—";
  if (completedAt) return format(completedAt, "dd MMM HH:mm");

  const remaining = minutesRemaining(deadline, now);
  if (remaining === null) return "—";
  return remaining >= 0
    ? `in ${formatAge(remaining)}`
    : `${formatAge(-remaining)} late`;
}

async function loadAssignees(orgId: string) {
  return prisma.user.findMany({
    where: {
      orgId,
      status: "ACTIVE",
      deletedAt: null,
      roles: {
        some: {
          role: {
            isActive: true,
            permissions: {
              some: { permission: { code: "complaint.resolve" } },
            },
          },
        },
      },
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
    take: 200,
  });
}
