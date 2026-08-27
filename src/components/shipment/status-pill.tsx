import type { ShipmentStatus } from "@/generated/prisma/client";
import { STATUS_LABELS } from "@/lib/shipment/state-machine";
import { cn } from "@/lib/utils";

/**
 * Status encoded in colour as well as words, so a duty manager scanning a
 * list of 200 shipments can see where attention is needed without reading
 * every row. Tone follows meaning, not the accent palette: exceptions are
 * red because they are bad, not because red is the brand.
 */
const TONE: Record<ShipmentStatus, string> = {
  BOOKED: "bg-muted text-muted-foreground",
  PICKUP_ASSIGNED: "bg-muted text-muted-foreground",
  PICKED_UP: "bg-accent text-accent-foreground",
  RECEIVED_AT_ORIGIN: "bg-accent text-accent-foreground",
  PROCESSED: "bg-accent text-accent-foreground",
  MANIFESTED: "bg-accent text-accent-foreground",
  DISPATCHED: "bg-info-muted text-info",
  IN_TRANSIT: "bg-info-muted text-info",
  ARRIVED_AT_HUB: "bg-info-muted text-info",
  RECEIVED_AT_HUB: "bg-info-muted text-info",
  ASSIGNED_FOR_DELIVERY: "bg-warn-muted text-warn",
  OUT_FOR_DELIVERY: "bg-warn-muted text-warn",
  DELIVERED: "bg-ok-muted text-ok",
  POD_UPLOADED: "bg-ok-muted text-ok",
  CLOSED: "bg-ok-muted text-ok",
  RTO_INITIATED: "bg-bad-muted text-bad",
  RTO_IN_TRANSIT: "bg-bad-muted text-bad",
  RTO_DELIVERED: "bg-bad-muted text-bad",
  LOST: "bg-bad-muted text-bad",
  CANCELLED: "bg-bad-muted text-bad",
};

export function StatusPill({
  status,
  className,
}: {
  status: ShipmentStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider",
        TONE[status],
        className,
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
