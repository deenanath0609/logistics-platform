import { cn } from "@/lib/utils";
import type { TenantStatus } from "@/generated/prisma/client";

/**
 * Tenant status, coloured by what it means operationally rather than by
 * how alarming it sounds.
 *
 * SUSPENDED is amber, not red: the carrier is still reachable and can
 * still read their own history — it is a commercial state, not an outage.
 * CLOSED is red because sign-in is refused outright.
 */
const TONE: Record<TenantStatus, string> = {
  PROVISIONING: "bg-info-muted text-info",
  TRIAL: "bg-accent text-accent-foreground",
  ACTIVE: "bg-ok-muted text-ok",
  SUSPENDED: "bg-warn-muted text-warn",
  CLOSED: "bg-bad-muted text-bad",
};

export const STATUS_ORDER: TenantStatus[] = [
  "PROVISIONING",
  "TRIAL",
  "ACTIVE",
  "SUSPENDED",
  "CLOSED",
];

export function TenantStatusBadge({
  status,
  className,
}: {
  status: TenantStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-4xl px-2 font-mono text-[0.6rem] font-medium uppercase tracking-[0.1em]",
        TONE[status],
        className,
      )}
    >
      {status.toLowerCase()}
    </span>
  );
}
