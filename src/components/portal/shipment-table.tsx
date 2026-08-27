import Link from "next/link";
import { format } from "date-fns";
import { FileCheck2 } from "lucide-react";
import type { PortalShipmentRow } from "@/lib/portal/queries";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { PortalStatusPill } from "./status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** The shipment list, shared by the overview and the full list page. */
export function PortalShipmentTable({
  rows,
  emptyTitle = "No shipments yet",
  emptyDescription,
}: {
  rows: PortalShipmentRow[];
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (rows.length === 0) {
    return (
      <TableFrame>
        <EmptyState title={emptyTitle} description={emptyDescription} />
      </TableFrame>
    );
  }

  return (
    <TableFrame>
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHead>LR number</TableHead>
            <TableHead>Lane</TableHead>
            <TableHead>Consignee</TableHead>
            <TableHead className="text-right">Pkgs</TableHead>
            <TableHead>Booked</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-mono text-xs font-medium">
                <Link href={`/portal/shipments/${row.id}`} className="hover:underline">
                  {row.lrNumber}
                </Link>
                {row.reference && (
                  <span className="block text-[0.65rem] text-muted-foreground">
                    {row.reference}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-sm">
                {row.fromCity} → {row.toCity}
              </TableCell>
              <TableCell className="text-sm">{row.consigneeName}</TableCell>
              <TableCell className="text-right tabular">
                {row.packageCount}
              </TableCell>
              <TableCell className="font-mono text-xs tabular text-muted-foreground">
                {format(row.bookedAt, "dd MMM yy")}
              </TableCell>
              <TableCell className="font-mono text-xs tabular text-muted-foreground">
                {row.deliveredAt
                  ? format(row.deliveredAt, "dd MMM yy")
                  : row.expectedDeliveryAt
                    ? format(row.expectedDeliveryAt, "dd MMM yy")
                    : "—"}
              </TableCell>
              <TableCell>
                <PortalStatusPill label={row.status} tone={row.tone} />
              </TableCell>
              <TableCell>
                {row.hasPod && (
                  <FileCheck2
                    className="size-4 text-ok"
                    aria-label="Proof of delivery available"
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableFrame>
  );
}
