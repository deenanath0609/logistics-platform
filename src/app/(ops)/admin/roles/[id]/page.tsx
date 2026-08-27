import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Lock } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { PermissionMatrix } from "./permission-matrix";

export const metadata: Metadata = { title: "Role" };
export const dynamic = "force-dynamic";

const SCOPE_LABEL: Record<string, string> = {
  OWN: "Own records only",
  BRANCH: "Their branch",
  BRANCH_SET: "Assigned branches",
  NETWORK: "Whole network",
};

export default async function RoleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("user.read");
  const editable = can(user, "role.manage");
  const { id } = await params;

  const [role, permissions] = await Promise.all([
    prisma.role.findUnique({
      where: { id },
      include: {
        permissions: { select: { permission: { select: { code: true } } } },
        _count: { select: { users: true } },
      },
    }),
    prisma.permission.findMany({
      orderBy: [{ module: "asc" }, { resource: "asc" }, { action: "asc" }],
      select: {
        code: true,
        module: true,
        resource: true,
        action: true,
        description: true,
        isSensitive: true,
      },
    }),
  ]);

  if (!role) notFound();

  const granted = role.permissions.map((p) => p.permission.code);

  return (
    <>
      <Link
        href="/admin/roles"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All roles
      </Link>

      <PageHeader
        eyebrow="Role"
        title={role.name}
        description={role.description ?? undefined}
      />

      <div className="mb-6 flex flex-wrap gap-3">
        {[
          { label: "Code", value: role.code, mono: true },
          { label: "Data scope", value: SCOPE_LABEL[role.scope] ?? role.scope },
          { label: "Permissions", value: `${granted.length} / ${permissions.length}` },
          { label: "Users", value: String(role._count.users) },
        ].map((stat) => (
          <div
            key={stat.label}
            className="flex items-baseline gap-2 rounded-md border bg-card px-3 py-1.5"
          >
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              {stat.label}
            </span>
            <span
              className={`text-sm font-semibold tabular ${stat.mono ? "font-mono" : ""}`}
            >
              {stat.value}
            </span>
          </div>
        ))}
        {role.isSystem && (
          <div className="flex items-center gap-1.5 rounded-md border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            System role — cannot be deleted
          </div>
        )}
      </div>

      {!editable && (
        <p className="mb-6 rounded-md border bg-muted px-3 py-2.5 text-sm text-muted-foreground">
          You can see this role but not change it. Changing permissions needs{" "}
          <code className="font-mono text-xs">role.manage</code>.
        </p>
      )}

      <PermissionMatrix
        roleId={role.id}
        roleName={role.name}
        isSuperAdmin={role.code === "SUPER_ADMIN"}
        permissions={permissions}
        granted={granted}
        editable={editable}
      />
    </>
  );
}
