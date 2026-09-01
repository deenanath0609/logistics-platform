import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Bike, PackageCheck, WifiOff } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { grantableRoles } from "@/lib/rbac/grant-guard";
import {
  countFieldStaff,
  loadFieldStaffRoster,
  type FieldStaffRow,
} from "@/lib/fleet/field-staff-service";
import {
  QUIET_WITHIN_HOURS,
  type SyncFreshness,
} from "@/lib/fleet/field-staff";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { FilterSelect } from "@/components/fleet/filter-chips";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserFormDialog, ResetPasswordDialog } from "../../admin/users/user-form";
import {
  updateUser,
  createUser,
  resetPassword,
  deactivateUser,
  reactivateUser,
} from "../../admin/users/actions";
import { StaffStatusDialog } from "./staff-status-dialog";

/**
 * ── Why this lives under /fleet and not /admin ───────────────────────────
 *
 * `/admin/users` is the organisation-administration lens: every login,
 * roles, password policy, who may see what. It is the right home for
 * "grant Priya the accounts role" and the wrong home for "who is out with
 * parcels right now".
 *
 * The Fleet group already answers the second question for everything else
 * that moves — vehicles, drivers, document expiries. Delivery and pickup
 * boys are the missing row in that group, and the person who opens it is a
 * branch manager at seven in the morning, not an administrator.
 *
 * The permission split lines up with that. `user.read` is an ordinary read
 * that every branch manager holds; `user.manage` is marked sensitive and
 * they do not. So this screen *reads* for the branch and *writes* only for
 * an admin, which is exactly the audience it was asked for, with no new
 * permission invented to get there.
 *
 * `/admin/users` is untouched: the same rows, a different lens.
 * ────────────────────────────────────────────────────────────────────────
 */

export const metadata: Metadata = { title: "Field staff" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;
const PATH = "/fleet/field-staff";

const rupees = (value: string) => `₹${Number(value).toLocaleString("en-IN")}`;

const FRESHNESS: Record<
  SyncFreshness,
  { label: string; className: string; hint: string }
> = {
  FRESH: {
    label: "synced",
    className: "text-ok",
    hint: "The handset has written to us within the last shift.",
  },
  QUIET: {
    label: "quiet",
    className: "text-muted-foreground",
    hint: "Nothing since yesterday. Normal on a rest day.",
  },
  STALE: {
    label: "not synced",
    className: "text-warn",
    hint: `Nothing for more than ${QUIET_WITHIN_HOURS} hours — a flat phone, a lost handset, or somebody who has stopped coming in.`,
  },
  NEVER: {
    label: "never used",
    className: "text-warn",
    hint: "This account has never done anything on the field app.",
  },
};

function LastSync({ row }: { row: FieldStaffRow }) {
  const tone = FRESHNESS[row.freshness];
  return (
    <span
      className={`flex items-center gap-1.5 text-xs ${tone.className}`}
      title={tone.hint}
    >
      {(row.freshness === "STALE" || row.freshness === "NEVER") && (
        <WifiOff className="size-3.5" />
      )}
      {row.lastActivityAt
        ? formatDistanceToNow(row.lastActivityAt, { addSuffix: true })
        : tone.label}
    </span>
  );
}

/** What the person is carrying right now, in one cell. */
function Carrying({ row }: { row: FieldStaffRow }) {
  if (!row.openRun && row.openPickups === 0) {
    return <span className="text-xs text-muted-foreground">idle</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {row.openRun && (
        <Link
          href={`/delivery/runs/${row.openRun.id}`}
          className="flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs hover:bg-muted"
          title={`${row.openRun.status.toLowerCase()} — open it`}
        >
          <Bike className="size-3.5" />
          <span className="font-mono">{row.openRun.number}</span>
          <span className="tabular text-muted-foreground">
            {row.openRun.stopsRemaining}/{row.openRun.totalStops} left
          </span>
        </Link>
      )}
      {/* The cell shows the newest open run, and its stop count and COD
          belong to that one. A second unfinished run is said rather than
          hidden — it is usually yesterday's, and it is the thing somebody
          has to chase. */}
      {row.openRunCount > 1 && (
        <Badge
          variant="outline"
          className="text-warn"
          title="Older runs still open. Open the delivery board to see them."
        >
          +{row.openRunCount - 1} older
        </Badge>
      )}
      {row.openPickups > 0 && (
        <Badge variant="secondary" className="gap-1">
          <PackageCheck />
          <span className="tabular">{row.openPickups}</span>
          <span>pickup{row.openPickups === 1 ? "" : "s"}</span>
        </Badge>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <p className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p className="tabular text-lg font-semibold">{value}</p>
    </div>
  );
}

export default async function FieldStaffPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    branch?: string;
    presence?: string;
    page?: string;
  }>;
}) {
  const actor = await requirePermission("user.read");
  const writable = can(actor, "user.manage");
  const { q, branch, presence, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const filters = { q, branchId: branch, presence };

  const [rows, total, branches, roles] = await Promise.all([
    loadFieldStaffRoster(actor, {
      ...filters,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    countFieldStaff(actor, filters),
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null, ...branchScope(actor, "id") },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.role.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        scope: true,
        description: true,
      },
    }),
  ]);

  // Only the roles this administrator may actually pass on. `createUser`
  // and `updateUser` already refuse an escalation — correctly — but the
  // picker offered every active role in the organisation, so a branch
  // administrator adding a delivery boy was shown ACCOUNTS and Super
  // Admin and found out on submit. The refusal stays; the trap does not.
  const grantable = await grantableRoles(actor, roles);

  // Counted from the rows on screen rather than the whole network, because
  // the numbers have to agree with the table underneath them — a tile that
  // disagrees with the list below it is worse than no tile.
  const onDuty = rows.filter((row) => row.openRun || row.openPickups > 0).length;
  const outOfTouch = rows.filter(
    (row) =>
      !row.isDeactivated &&
      (row.freshness === "STALE" || row.freshness === "NEVER"),
  ).length;

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Field staff"
        description="Delivery and pickup boys, and what each one is carrying right now. Removing someone deactivates the account — their delivery history keeps their name."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search name, mobile, code" />
            {writable && (
              <UserFormDialog
                mode="create"
                action={createUser}
                roles={grantable}
                branches={branches}
                defaultFieldUser
                createLabel="New field user"
              />
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterSelect
          param="branch"
          label="All branches"
          value={branch}
          options={branches.map((b) => ({
            value: b.id,
            label: `${b.code} — ${b.name}`,
          }))}
        />
        <FilterSelect
          param="presence"
          label="Active only"
          value={presence}
          options={[
            { value: "inactive", label: "Deactivated only" },
            { value: "all", label: "Active and deactivated" },
          ]}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          <Tile label="On the ground" value={onDuty} />
          <Tile label="Out of touch" value={outOfTouch} />
        </div>
      </div>

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "No field staff here"}
            description={
              q
                ? "Try a mobile number or part of a name."
                : "Delivery and pickup boys are the users with the field-user switch on. Add one, or widen the branch filter."
            }
          />
        ) : (
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Carrying now</TableHead>
                <TableHead className="text-right">COD in hand</TableHead>
                <TableHead>Last sync</TableHead>
                <TableHead>Status</TableHead>
                {writable && (
                  <TableHead className="w-32 text-right">Actions</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={row.isDeactivated ? "opacity-60" : ""}
                >
                  <TableCell className="font-medium">
                    {row.name}
                    {row.employeeCode && (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {row.employeeCode}
                      </span>
                    )}
                    <span className="block font-mono text-xs text-muted-foreground">
                      {row.mobile}
                    </span>
                  </TableCell>

                  <TableCell className="text-xs">
                    {row.branch ? (
                      <span className="font-mono" title={row.branch.name}>
                        {row.branch.code}
                      </span>
                    ) : (
                      <span className="text-warn">unassigned</span>
                    )}
                  </TableCell>

                  <TableCell>
                    <Carrying row={row} />
                  </TableCell>

                  <TableCell className="text-right">
                    <span
                      className={`tabular text-sm ${
                        Number(row.codInHand) > 0
                          ? "font-medium text-warn"
                          : "text-muted-foreground"
                      }`}
                      title="Collected at the door and not yet deposited at the branch."
                    >
                      {rupees(row.codInHand)}
                    </span>
                  </TableCell>

                  <TableCell>
                    <LastSync row={row} />
                  </TableCell>

                  <TableCell>
                    <span
                      className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${
                        row.isDeactivated
                          ? "bg-muted text-muted-foreground"
                          : row.status === "ACTIVE"
                            ? "bg-ok-muted text-ok"
                            : "bg-bad-muted text-bad"
                      }`}
                    >
                      {row.isDeactivated ? "Deactivated" : row.status}
                    </span>
                  </TableCell>

                  {writable && (
                    <TableCell>
                      <div className="flex items-center justify-end gap-0.5">
                        <UserFormDialog
                          mode="edit"
                          action={updateUser}
                          roles={grantable}
                          branches={branches}
                          user={{
                            id: row.id,
                            name: row.name,
                            mobile: row.mobile,
                            email: row.email,
                            employeeCode: row.employeeCode,
                            primaryBranchId: row.primaryBranchId,
                            status: row.status,
                            isFieldUser: true,
                            roleIds: row.roleIds,
                          }}
                        />
                        <ResetPasswordDialog
                          userId={row.id}
                          userName={row.name}
                          action={resetPassword}
                        />
                        <StaffStatusDialog
                          mode={row.isDeactivated ? "reactivate" : "deactivate"}
                          userId={row.id}
                          userName={row.name}
                          branchLabel={row.branch?.code ?? "no branch"}
                          codInHand={row.codInHand}
                          blockedReason={row.deactivationBlockedReason}
                          action={
                            row.isDeactivated ? reactivateUser : deactivateUser
                          }
                        />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        baseParams={{ q, branch, presence }}
        pathname={PATH}
      />
    </>
  );
}
