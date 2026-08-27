import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
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

export const metadata: Metadata = { title: "Cities" };
export const dynamic = "force-dynamic";

export default async function CitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requirePermission("master.read");
  const { q } = await searchParams;

  const rows = await prisma.city.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { code: { contains: q, mode: "insensitive" } },
            { state: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : undefined,
    orderBy: [{ name: "asc" }],
    include: {
      state: { select: { name: true, code: true } },
      _count: { select: { pincodes: true, branches: true } },
    },
  });

  return (
    <>
      <PageHeader
        eyebrow="Network"
        title="Cities"
        description="City codes appear on labels, manifests, and the customer-facing tracking page — the consignee sees “Reached Jaipur”, not a branch name."
        actions={<SearchInput placeholder="Search city, code, state" />}
      />

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title={q ? `Nothing matches “${q}”` : "No cities yet"}
            description={
              q ? "Try a shorter search." : "Load the city master before Phase 2."
            }
          />
        ) : (
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>City</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Pincodes</TableHead>
                <TableHead className="text-right">Branches</TableHead>
                <TableHead>Coordinates</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={row.isActive ? "" : "opacity-55"}>
                  <TableCell className="font-mono text-xs font-medium">
                    {row.code}
                  </TableCell>
                  <TableCell className="font-medium">
                    {row.name}
                    {row.isMetro && (
                      <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-accent-foreground">
                        Metro
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.state.name}
                    <span className="ml-1 font-mono text-muted-foreground">
                      {row.state.code}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row._count.pincodes}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {row._count.branches}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.latitude && row.longitude
                      ? `${Number(row.latitude).toFixed(4)}, ${Number(row.longitude).toFixed(4)}`
                      : "—"}
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
        Cities and pincodes are bulk-imported rather than typed in — the import
        tool arrives with the full ~19,000-PIN load. Editing them one at a time
        would be the wrong shape for that job.
      </p>
    </>
  );
}
