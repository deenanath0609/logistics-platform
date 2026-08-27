import type { Metadata } from "next";
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

export const metadata: Metadata = { title: "Zones" };
export const dynamic = "force-dynamic";

export default async function ZonesPage() {
  await requirePermission("master.read");

  const rows = await prisma.zone.findMany({
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
    include: {
      _count: { select: { pincodes: true } },
      pincodes: {
        take: 6,
        select: { pincode: { select: { city: { select: { name: true } } } } },
      },
    },
  });

  return (
    <>
      <PageHeader
        eyebrow="Network"
        title="Zones"
        description="Zones group pincodes for rating and SLA. A lane is a zone pair — Delhi NCR to West India — which is far fewer rows to maintain than every city pair."
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState title="No zones yet" />
        ) : (
          <Table className="min-w-[700px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Pincodes</TableHead>
                <TableHead>Covers</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const cities = [
                  ...new Set(row.pincodes.map((p) => p.pincode.city.name)),
                ];
                return (
                  <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                    <TableCell className="font-mono text-xs font-medium">
                      {row.code}
                    </TableCell>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-right tabular">
                      {row._count.pincodes}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {cities.join(", ") || "—"}
                      {row._count.pincodes > row.pincodes.length && " …"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.isActive ? "secondary" : "outline"}>
                        {row.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        Zone membership is edited alongside rate cards in Phase 6, where the
        consequence of a change — what it does to pricing — is visible in the
        same screen.
      </p>
    </>
  );
}
