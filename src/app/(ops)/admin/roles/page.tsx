import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Lock } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Roles & permissions" };
export const dynamic = "force-dynamic";

const SCOPE_LABEL: Record<string, string> = {
  OWN: "Own records only",
  BRANCH: "Their branch",
  BRANCH_SET: "Assigned branches",
  NETWORK: "Whole network",
};

const SCOPE_TONE: Record<string, string> = {
  OWN: "bg-muted text-muted-foreground",
  BRANCH: "bg-accent text-accent-foreground",
  BRANCH_SET: "bg-info-muted text-info",
  NETWORK: "bg-warn-muted text-warn",
};

export default async function RolesPage() {
  await requirePermission("user.read");

  const [roles, totalPermissions] = await Promise.all([
    prisma.role.findMany({
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: {
        _count: { select: { permissions: true, users: true } },
      },
    }),
    prisma.permission.count(),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Roles & permissions"
        description="A role bundles permissions; its scope decides how much data those permissions reach. Both are checked in the data layer, so a missing menu item is convenience — not the boundary."
      />

      <TableFrame>
        {roles.length === 0 ? (
          <EmptyState
            title="No roles yet"
            description="Run the seed to create the standard set."
          />
        ) : (
          <Table className="min-w-[780px]">
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Data scope</TableHead>
                <TableHead className="text-right">Permissions</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((role) => (
                <TableRow key={role.id} className={role.isActive ? "" : "opacity-55"}>
                  <TableCell>
                    <Link
                      href={`/admin/roles/${role.id}`}
                      className="flex flex-col gap-0.5 hover:underline"
                    >
                      <span className="flex items-center gap-1.5 font-medium">
                        {role.name}
                        {role.isSystem && (
                          <Lock
                            className="size-3 text-muted-foreground"
                            aria-label="System role"
                          />
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {role.description}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${SCOPE_TONE[role.scope]}`}
                    >
                      {SCOPE_LABEL[role.scope] ?? role.scope}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {role._count.permissions}
                    <span className="text-muted-foreground"> / {totalPermissions}</span>
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {role._count.users}
                  </TableCell>
                  <TableCell>
                    <Badge variant={role.isActive ? "secondary" : "outline"}>
                      {role.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/roles/${role.id}`}
                      aria-label={`Open ${role.name}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight className="size-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>
    </>
  );
}
