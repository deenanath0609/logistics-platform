import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { FilterChips, FilterSelect } from "@/components/fleet/filter-chips";
import {
  EscalationMark,
  ExceptionStatusPill,
  PriorityPill,
} from "@/components/exceptions/pills";
import {
  KIND_DEFS,
  KIND_ORDER,
  LIVE_STATUSES,
  ageMinutes,
  kindLabel,
} from "@/lib/exceptions/kinds";
import { formatDuration } from "@/lib/sla/policy";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ExceptionKind, Prisma } from "@/generated/prisma/client";

export const metadata: Metadata = { title: "Exception tower" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

/**
 * The exception control tower — docs/BRD.html §A.11.
 *
 * The screen a duty manager runs the shift from: everything wrong in the
 * network right now, worst first, then oldest. Every column earns its
 * place by answering one of the three questions asked out loud at a
 * handover — what is it, whose is it, and how long has it been like that.
 */

const VIEWS = {
  live: { label: "Open" },
  critical: { label: "Critical" },
  mine: { label: "Mine" },
  unassigned: { label: "Unassigned" },
  escalated: { label: "Escalated" },
  resolved: { label: "Resolved" },
} as const;

type ViewKey = keyof typeof VIEWS;

function viewFilter(view: ViewKey, userId: string): Prisma.ExceptionWhereInput {
  const live = { status: { in: LIVE_STATUSES } };

  switch (view) {
    case "critical":
      return { ...live, priority: { in: ["CRITICAL", "HIGH"] } };
    case "mine":
      return { ...live, assignedToId: userId };
    case "unassigned":
      return { ...live, assignedToId: null };
    case "escalated":
      return { ...live, escalationLevel: { gt: 0 } };
    case "resolved":
      return { status: { in: ["RESOLVED", "CLOSED", "DISMISSED"] } };
    case "live":
    default:
      return live;
  }
}

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    view?: string;
    kind?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("exception.read");

  const { q, view: viewParam, kind, page: pageParam } = await searchParams;
  const view: ViewKey =
    viewParam && viewParam in VIEWS ? (viewParam as ViewKey) : "live";
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  // Branch scope, with one deliberate exception: an exception assigned to
  // you is yours to work wherever it was raised. Routing a Delhi shortage
  // to the claims desk in Mumbai must not hide it from the person who has
  // to answer for it.
  const scope: Prisma.ExceptionWhereInput =
    user.branchIds === null
      ? {}
      : {
          OR: [
            { ownerBranchId: { in: user.branchIds } },
            { branchId: { in: user.branchIds } },
            { assignedToId: user.id },
          ],
        };

  const where: Prisma.ExceptionWhereInput = {
    AND: [
      scope,
      viewFilter(view, user.id),
      kind ? { kind: kind as ExceptionKind } : {},
      q
        ? {
            OR: [
              { number: { contains: q, mode: "insensitive" } },
              { title: { contains: q, mode: "insensitive" } },
              { shipment: { lrNumber: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {},
    ],
  };

  const [rows, total, counts] = await Promise.all([
    prisma.exception.findMany({
      where,
      // What is worst, then what has waited longest. Sorting it any other
      // way makes the duty manager do it themselves.
      orderBy: [{ priority: "desc" }, { detectedAt: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        number: true,
        kind: true,
        priority: true,
        status: true,
        title: true,
        detail: true,
        detectedAt: true,
        resolvedAt: true,
        escalationLevel: true,
        source: true,
        branchId: true,
        ownerBranchId: true,
        branch: { select: { code: true } },
        assignedTo: { select: { name: true } },
        shipment: { select: { id: true, lrNumber: true } },
      },
    }),
    prisma.exception.count({ where }),
    Promise.all(
      (Object.keys(VIEWS) as ViewKey[]).map(async (key) => ({
        key,
        label: VIEWS[key].label,
        count: await prisma.exception.count({
          where: { AND: [scope, viewFilter(key, user.id)] },
        }),
      })),
    ),
  ]);

  const now = new Date();

  // `branch` is the relation on `branchId` — where the problem was
  // *noticed* — and the column headed "Owner branch" was rendering it.
  // For everything the hub raises those two are deliberately different:
  // Delhi finds the shortage, Gurugram owes for it. Showing the finder
  // under "Owner" points the whole tower at the wrong branch, which is
  // the one thing the attribution exists to get right. There is no
  // relation on `ownerBranchId`, so the codes are looked up by id.
  const ownerIds = [
    ...new Set(
      rows
        .map((row) => row.ownerBranchId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const ownerBranches = ownerIds.length
    ? await prisma.branch.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, code: true },
      })
    : [];
  const ownerCode = new Map(ownerBranches.map((b) => [b.id, b.code]));

  return (
    <>
      <PageHeader
        eyebrow="Control tower"
        title="Exceptions"
        description="Everything wrong in the network right now, worst first and oldest first within that. Nothing closes without a resolution note."
      />

      <FilterChips
        param="view"
        selected={view}
        chips={counts.map((row) => ({
          key: row.key,
          label: row.label,
          count: row.count,
          tone:
            row.key === "critical"
              ? ("bad" as const)
              : row.key === "unassigned" || row.key === "escalated"
                ? ("warn" as const)
                : undefined,
        }))}
        extra={
          <>
            <SearchInput placeholder="Number, LR or description" />
            <FilterSelect
              param="kind"
              label="Any kind"
              value={kind}
              options={KIND_ORDER.map((value) => ({
                value,
                label: KIND_DEFS[value].label,
              }))}
            />
          </>
        }
      />

      {rows.length === 0 ? (
        <TableFrame>
          <EmptyState
            title="Nothing wrong here"
            description={
              view === "live"
                ? "No open exception in your branches. That is either a good shift or a scanner that has not run — the SLA scan runs every few minutes."
                : "No exception matches this view."
            }
          />
        </TableFrame>
      ) : (
        <>
          <TableFrame>
            <Table className="min-w-[1040px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Exception</TableHead>
                  <TableHead>What is wrong</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>LR</TableHead>
                  <TableHead>Owner branch</TableHead>
                  <TableHead>Assigned to</TableHead>
                  <TableHead className="text-right">Age</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap align-top">
                      <Link
                        href={`/exceptions/${row.id}`}
                        className="font-mono text-xs font-medium underline-offset-4 hover:underline"
                      >
                        {row.number}
                      </Link>
                      <div className="mt-1 flex items-center gap-1">
                        <PriorityPill priority={row.priority} />
                        <EscalationMark level={row.escalationLevel} />
                      </div>
                    </TableCell>

                    <TableCell className="max-w-[300px] align-top">
                      <p className="truncate text-sm font-medium">{row.title}</p>
                      {row.detail && (
                        <p className="truncate text-xs text-muted-foreground">
                          {row.detail}
                        </p>
                      )}
                    </TableCell>

                    <TableCell className="align-top text-xs text-muted-foreground">
                      {kindLabel(row.kind)}
                      <span className="block font-mono text-[0.6rem] uppercase tracking-wider">
                        {row.source}
                      </span>
                    </TableCell>

                    <TableCell className="align-top">
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

                    <TableCell className="align-top font-mono text-xs">
                      {row.ownerBranchId
                        ? (ownerCode.get(row.ownerBranchId) ?? "—")
                        : (row.branch?.code ?? "—")}
                      {/*
                        Where it was found, when that is somebody else.
                        A duty manager reading "GGN owns it, DEL found it"
                        knows who to ring and who to ask what happened.
                      */}
                      {row.branch?.code &&
                        row.ownerBranchId &&
                        row.ownerBranchId !== row.branchId && (
                          <span className="block text-[0.6rem] font-normal text-muted-foreground">
                            found at {row.branch.code}
                          </span>
                        )}
                    </TableCell>

                    <TableCell className="align-top text-xs">
                      {row.assignedTo?.name ?? (
                        <span className="text-warn">Unassigned</span>
                      )}
                    </TableCell>

                    <TableCell className="whitespace-nowrap text-right align-top font-mono text-xs tabular">
                      {formatDuration(ageMinutes(row, now))}
                    </TableCell>

                    <TableCell className="align-top">
                      <ExceptionStatusPill status={row.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            baseParams={{ q, view, kind }}
            pathname="/exceptions"
          />
        </>
      )}
    </>
  );
}
