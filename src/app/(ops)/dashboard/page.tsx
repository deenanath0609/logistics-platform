import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Building2, Users, ShieldCheck, Package, MapPin, Hash } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireUser, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { OpsHealthStrip } from "@/components/reports/ops-strip";
import { TableFrame } from "@/components/data/data-shell";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const OUTCOME_TONE: Record<string, string> = {
  SUCCESS: "bg-ok-muted text-ok",
  BAD_CREDENTIALS: "bg-bad-muted text-bad",
  OTP_FAILED: "bg-bad-muted text-bad",
  LOCKED: "bg-warn-muted text-warn",
  INACTIVE: "bg-muted text-muted-foreground",
};

export default async function DashboardPage() {
  const user = await requireUser();

  const [
    branches,
    users,
    roles,
    serviceTypes,
    pincodes,
    series,
    recentLogins,
    recentAudit,
  ] = await Promise.all([
    prisma.branch.count({ where: { isActive: true, deletedAt: null } }),
    prisma.user.count({ where: { status: "ACTIVE", deletedAt: null } }),
    prisma.role.count({ where: { isActive: true } }),
    prisma.serviceType.count({ where: { isActive: true } }),
    prisma.pincode.count({ where: { isServiceable: true } }),
    prisma.numberSeries.count({ where: { isActive: true } }),
    can(user, "audit.read")
      ? prisma.loginActivity.findMany({
          take: 8,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            identifier: true,
            outcome: true,
            createdAt: true,
            user: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    can(user, "audit.read")
      ? prisma.auditLog.findMany({
          take: 8,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            action: true,
            entity: true,
            entityRef: true,
            createdAt: true,
            user: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const tiles = [
    { label: "Branches & hubs", value: branches, icon: Building2, href: "/masters/branches" },
    { label: "Active users", value: users, icon: Users, href: "/admin/users" },
    { label: "Roles", value: roles, icon: ShieldCheck, href: "/admin/roles" },
    { label: "Service types", value: serviceTypes, icon: Package, href: "/masters/service-types" },
    { label: "Serviceable pincodes", value: pincodes, icon: MapPin, href: "/masters/pincodes" },
    { label: "Number series", value: series, icon: Hash, href: "/masters/number-series" },
  ];

  return (
    <>
      <PageHeader
        eyebrow={`Good to see you, ${user.name.split(" ")[0]}`}
        title="Network overview"
        description={
          user.branchIds === null
            ? "You have network-wide visibility."
            : `Scoped to ${user.primaryBranch?.name ?? "your assigned branches"}.`
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <Link
            key={tile.label}
            href={tile.href}
            className="group flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3.5 transition-colors hover:border-primary/40 hover:bg-accent/40"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
                {tile.label}
              </span>
              <span className="text-2xl font-semibold tabular">
                {tile.value}
              </span>
            </div>
            <tile.icon className="size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
          </Link>
        ))}
      </section>

      {/* Phase 8: the exception tower and SLA engine, summarised. */}
      <OpsHealthStrip user={user} />

      {can(user, "audit.read") && (
        <section className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              Recent sign-in activity
            </h2>
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Identifier</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentLogins.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-muted-foreground">
                        Nothing yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {recentLogins.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <span className="font-mono text-xs">
                          {row.identifier}
                        </span>
                        {row.user && (
                          <span className="ml-2 text-muted-foreground">
                            {row.user.name}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${
                            OUTCOME_TONE[row.outcome] ??
                            "bg-muted text-muted-foreground"
                          }`}
                        >
                          {row.outcome.replace(/_/g, " ")}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {formatDistanceToNow(row.createdAt, { addSuffix: true })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              Recent changes
            </h2>
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Change</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentAudit.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-muted-foreground">
                        Nothing yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {recentAudit.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Badge variant="secondary" className="mr-2 font-mono text-[0.6rem]">
                          {row.action}
                        </Badge>
                        <span className="text-xs">
                          {row.entity}
                          {row.entityRef && (
                            <span className="ml-1 font-mono text-muted-foreground">
                              {row.entityRef}
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.user?.name ?? "System"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {formatDistanceToNow(row.createdAt, { addSuffix: true })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
          </div>
        </section>
      )}
    </>
  );
}
