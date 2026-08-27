import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { requirePermission } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
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

export const metadata: Metadata = { title: "Routes" };
export const dynamic = "force-dynamic";

export default async function RoutesPage() {
  await requirePermission("master.read");

  const rows = await prisma.route.findMany({
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
    include: {
      legs: {
        orderBy: { sequence: "asc" },
        include: {
          originBranch: { select: { code: true } },
          destinationBranch: { select: { code: true } },
        },
      },
    },
  });

  return (
    <>
      <PageHeader
        eyebrow="Network"
        title="Routes"
        description="A lane broken into legs. Each leg gets its own manifest and its own inbound scan, which is what makes transit time per leg measurable — and how you find the hub that is costing you your SLA."
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState title="No routes yet" />
        ) : (
          <Table className="min-w-[820px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Legs</TableHead>
                <TableHead className="text-right">Distance</TableHead>
                <TableHead className="text-right">Transit</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                  <TableCell className="font-mono text-xs font-medium">
                    {row.code}
                  </TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      {row.legs.map((leg, i) => (
                        <span key={leg.id} className="flex items-center gap-1">
                          {i === 0 && (
                            <span className="font-mono text-xs">
                              {leg.originBranch.code}
                            </span>
                          )}
                          <ArrowRight className="size-3 text-muted-foreground" />
                          <span className="font-mono text-xs">
                            {leg.destinationBranch.code}
                          </span>
                          <span className="font-mono text-[0.6rem] text-muted-foreground">
                            {leg.distanceKm ? `${Number(leg.distanceKm)}km` : ""}
                            {leg.transitHours ? `/${leg.transitHours}h` : ""}
                          </span>
                        </span>
                      ))}
                      {row.legs.length === 0 && (
                        <span className="text-xs text-warn">no legs defined</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {row.totalDistanceKm ? `${Number(row.totalDistanceKm)} km` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {row.standardTransitHours ? `${row.standardTransitHours} h` : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.isActive ? "secondary" : "outline"}>
                      {row.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        Route editing arrives in Phase 3 with manifests and trips, where a leg
        change can be validated against the vehicles and manifests already
        running on it.
      </p>
    </>
  );
}
