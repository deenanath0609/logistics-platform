import type { Metadata } from "next";
import { formatDistanceToNow } from "date-fns";
import { Smartphone, Lock } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState, Pagination } from "@/components/data/data-shell";
import { SearchInput } from "@/components/data/search-input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserFormDialog, ResetPasswordDialog } from "./user-form";
import { createUser, updateUser, resetPassword } from "./actions";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "bg-ok-muted text-ok",
  INACTIVE: "bg-muted text-muted-foreground",
  SUSPENDED: "bg-bad-muted text-bad",
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const actor = await requirePermission("user.read");
  const writable = can(actor, "user.manage");
  const { q, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const where = {
    deletedAt: null,
    ...branchScope(actor, "primaryBranchId"),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { mobile: { contains: q } },
            { email: { contains: q, mode: "insensitive" as const } },
            { employeeCode: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total, roles, branches] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ status: "asc" }, { name: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        primaryBranch: { select: { code: true, name: true } },
        roles: { select: { role: { select: { id: true, name: true } } } },
      },
    }),
    prisma.user.count({ where }),
    prisma.role.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true, scope: true, description: true },
    }),
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null, ...branchScope(actor, "id") },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Users"
        description={
          actor.branchIds === null
            ? "Everyone who signs in. Deactivating someone cuts their access on their next request, not at their next login."
            : "Staff at the branches you cover."
        }
        actions={
          <div className="flex items-center gap-2">
            <SearchInput placeholder="Search name, mobile, code" />
            {writable && (
              <UserFormDialog
                mode="create"
                action={createUser}
                roles={roles}
                branches={branches}
              />
            )}
          </div>
        }
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "No users visible"}
            description={
              q ? "Try a mobile number or part of a name." : undefined
            }
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Mobile</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Sign-in</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Status</TableHead>
                {writable && <TableHead className="w-24 text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={row.status === "ACTIVE" ? "" : "opacity-60"}
                >
                  <TableCell className="font-medium">
                    {row.name}
                    {row.employeeCode && (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {row.employeeCode}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.mobile}</TableCell>
                  <TableCell className="text-xs">
                    {row.primaryBranch ? (
                      <span className="font-mono">{row.primaryBranch.code}</span>
                    ) : (
                      <span className="text-warn">unassigned</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.roles.map((r) => (
                        <Badge
                          key={r.role.id}
                          variant="secondary"
                          className="text-[0.65rem]"
                        >
                          {r.role.name}
                        </Badge>
                      ))}
                      {row.roles.length === 0 && (
                        <span className="text-xs text-warn">no role</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                      title={
                        row.isFieldUser
                          ? "Signs in with a one-time code"
                          : "Signs in with a password"
                      }
                    >
                      {row.isFieldUser ? (
                        <>
                          <Smartphone className="size-3.5" /> OTP
                        </>
                      ) : (
                        <>
                          <Lock className="size-3.5" /> Password
                        </>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.lastLoginAt
                      ? formatDistanceToNow(row.lastLoginAt, { addSuffix: true })
                      : "never"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${STATUS_TONE[row.status]}`}
                    >
                      {row.status}
                    </span>
                    {row.lockedUntil && row.lockedUntil > new Date() && (
                      <span className="ml-1 rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-warn">
                        Locked
                      </span>
                    )}
                  </TableCell>
                  {writable && (
                    <TableCell>
                      <div className="flex items-center justify-end gap-0.5">
                        <UserFormDialog
                          mode="edit"
                          action={updateUser}
                          roles={roles}
                          branches={branches}
                          user={{
                            id: row.id,
                            name: row.name,
                            mobile: row.mobile,
                            email: row.email,
                            employeeCode: row.employeeCode,
                            primaryBranchId: row.primaryBranchId,
                            status: row.status,
                            isFieldUser: row.isFieldUser,
                            roleIds: row.roles.map((r) => r.role.id),
                          }}
                        />
                        <ResetPasswordDialog
                          userId={row.id}
                          userName={row.name}
                          action={resetPassword}
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
        baseParams={{ q }}
        pathname="/admin/users"
      />
    </>
  );
}
