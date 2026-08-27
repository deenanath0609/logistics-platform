import type { DriverStatus, VehicleStatus } from "@/generated/prisma/client";
import { cn } from "@/lib/utils";

/**
 * Fleet status in colour as well as words.
 *
 * Tone follows meaning, not the brand: a vehicle in maintenance is amber
 * because it is a problem to work around, and one that is inactive is grey
 * because it is simply not in play. Both are distinguishable at a glance
 * from the twenty trucks that are out earning.
 */

const VEHICLE_TONE: Record<VehicleStatus, string> = {
  AVAILABLE: "bg-ok-muted text-ok",
  ASSIGNED: "bg-accent text-accent-foreground",
  LOADING: "bg-accent text-accent-foreground",
  DISPATCHED: "bg-info-muted text-info",
  IN_TRANSIT: "bg-info-muted text-info",
  AT_HUB: "bg-info-muted text-info",
  UNLOADING: "bg-accent text-accent-foreground",
  MAINTENANCE: "bg-warn-muted text-warn",
  INACTIVE: "bg-muted text-muted-foreground",
};

export const VEHICLE_STATUS_LABELS: Record<VehicleStatus, string> = {
  AVAILABLE: "Available",
  ASSIGNED: "Assigned",
  LOADING: "Loading",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In transit",
  AT_HUB: "At hub",
  UNLOADING: "Unloading",
  MAINTENANCE: "Maintenance",
  INACTIVE: "Inactive",
};

const DRIVER_TONE: Record<DriverStatus, string> = {
  AVAILABLE: "bg-ok-muted text-ok",
  ON_TRIP: "bg-info-muted text-info",
  ON_LEAVE: "bg-warn-muted text-warn",
  SUSPENDED: "bg-bad-muted text-bad",
  INACTIVE: "bg-muted text-muted-foreground",
};

export const DRIVER_STATUS_LABELS: Record<DriverStatus, string> = {
  AVAILABLE: "Available",
  ON_TRIP: "On trip",
  ON_LEAVE: "On leave",
  SUSPENDED: "Suspended",
  INACTIVE: "Inactive",
};

const PILL =
  "inline-block whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider";

export function VehicleStatusPill({
  status,
  className,
}: {
  status: VehicleStatus;
  className?: string;
}) {
  return (
    <span className={cn(PILL, VEHICLE_TONE[status], className)}>
      {VEHICLE_STATUS_LABELS[status]}
    </span>
  );
}

export function DriverStatusPill({
  status,
  className,
}: {
  status: DriverStatus;
  className?: string;
}) {
  return (
    <span className={cn(PILL, DRIVER_TONE[status], className)}>
      {DRIVER_STATUS_LABELS[status]}
    </span>
  );
}

/** Ownership reads as a quiet qualifier, never as an alert. */
export function OwnershipTag({ ownership }: { ownership: string }) {
  return (
    <span className="font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
      {ownership === "OWN"
        ? "Own"
        : ownership === "VENDOR"
          ? "Vendor"
          : "Attached"}
    </span>
  );
}
