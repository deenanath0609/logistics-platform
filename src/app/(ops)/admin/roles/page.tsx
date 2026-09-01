import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Lock } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createRole } from "./actions";

export const metadata: Metadata = { title: "Roles & permissions" };
export const dynamic = "force-dynamic";

const SCOPE_LABEL: Record<string, string> = {
  OWN: "Own records only",
  BRANCH: "Their branch",
  BRANCH_SET: "Assigned branches",
  NETWORK: "Whole network",
};

const SCOPE_OPTIONS = [
  { value: "OWN", label: "Own records only — a field agent's own tasks" },
  { value: "BRANCH", label: "Their branch — one counter or hub" },
  { value: "BRANCH_SET", label: "Assigned branches — home branch plus any ticked on the user" },
  { value: "NETWORK", label: "Whole network — every branch" },
];

/**
 * The fields of a role itself, as opposed to what it may do. Shared by the
 * create dialog here and the edit dialog on the role's own page, so the two
 * cannot describe the same thing differently.
 *
 * `code` only exists on creation: it is what the seed, the audit trail and
 * `SUPER_ADMIN`'s special case key on, so it is chosen once.
 */
export function roleFields(creating: boolean): FieldDef[] {
  return [
    ...(creating
      ? ([
          {
            type: "text",
            name: "code",
            label: "Code",
            required: true,
            half: true,
            mono: true,
            placeholder: "REGIONAL_SUPERVISOR",
            help: "Permanent. It is what the audit trail records.",
          },
        ] as FieldDef[])
      : []),
    {
      type: "text",
      name: "name",
      label: "Name",
      required: true,
      half: !creating,
      placeholder: "Regional Supervisor",
    },
    {
      type: "select",
      name: "scope",
      label: "Data scope",
      required: true,
      options: SCOPE_OPTIONS,
      help: "How far every permission in this role reaches. Enforced in the data layer, not the menu.",
    },
    {
      type: "textarea",
      name: "description",
      label: "Description",
      placeholder: "Runs the four branches in the western cluster.",
    },
    {
      type: "switch",
      name: "isActive",
      label: "Active",
      help: "An inactive role grants nothing, on the next request, without being unassigned from anyone.",
    },
  ];
}

const SCOPE_TONE: Record<string, string> = {
  OWN: "bg-muted text-muted-foreground",
  BRANCH: "bg-accent text-accent-foreground",
  BRANCH_SET: "bg-info-muted text-info",
  NETWORK: "bg-warn-muted text-warn",
};

export default async function RolesPage() {
  const user = await requirePermission("user.read");
  const editable = can(user, "role.manage");

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
        actions={
          editable && (
            <MasterFormDialog
              title="New role"
              description="A role starts with no permissions. Create it, then open it and tick what it may do."
              fields={roleFields(true)}
              action={createRole}
              submitLabel="Create role"
              trigger={{ label: "New role", icon: "plus" }}
            />
          )
        }
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
