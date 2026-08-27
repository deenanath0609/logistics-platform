import { AlertTriangle, ShieldCheck, ShieldX } from "lucide-react";
import {
  expiryUrgency,
  type Assignability,
  type DocumentHealth,
  type ExpiryUrgency,
} from "@/lib/fleet/availability";
import { DOCUMENT_SHORT } from "@/lib/fleet/documents";
import { cn } from "@/lib/utils";

/**
 * Expiry, rendered so it can be scanned rather than read.
 *
 * This is the whole point of the fleet module: a transport desk looking at
 * forty vehicles must be able to see which ones are off the road without
 * opening anything. Red means the truck cannot legally move today, amber
 * means it stops moving within the month, muted means nothing to do.
 */

const URGENCY_TONE: Record<ExpiryUrgency, string> = {
  EXPIRED: "bg-bad-muted text-bad",
  CRITICAL: "bg-warn-muted text-warn",
  WARNING: "bg-warn-muted text-warn",
  OK: "bg-muted text-muted-foreground",
};

const PILL =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Renders a `@db.Date` from its UTC parts.
 *
 * `date-fns` formats in the server's local zone, which for a column stored
 * at UTC midnight shows the previous day anywhere west of Greenwich. An
 * insurance certificate reading one day early is exactly the sort of quiet
 * wrongness this module cannot afford, so the parts are read directly.
 */
export function formatUtcDate(value: Date): string {
  return `${String(value.getUTCDate()).padStart(2, "0")} ${
    MONTHS[value.getUTCMonth()]
  } ${value.getUTCFullYear()}`;
}

/** A `@db.Date` as `yyyy-MM-dd`, ready for a date input. */
export function toDateInputValue(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** "in 12 days", "today", "42 days ago" — the number people act on. */
export function relativeDays(daysRemaining: number): string {
  if (daysRemaining === 0) return "today";
  if (daysRemaining === 1) return "tomorrow";
  if (daysRemaining === -1) return "yesterday";
  if (daysRemaining < 0) return `${Math.abs(daysRemaining)} days ago`;
  return `in ${daysRemaining} days`;
}

/**
 * One expiry date with its urgency. Used in every document table and on the
 * expiry desk, so the colour means the same thing everywhere.
 */
export function ExpiryDate({
  expiresOn,
  daysRemaining,
  className,
}: {
  expiresOn: Date | null;
  daysRemaining?: number;
  className?: string;
}) {
  if (!expiresOn) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        no expiry
      </span>
    );
  }

  const days = daysRemaining ?? 0;
  const urgency = expiryUrgency(days);

  return (
    <span className={cn("flex flex-col gap-0.5", className)}>
      <span
        className={cn(
          "font-mono text-xs tabular",
          urgency === "EXPIRED"
            ? "font-semibold text-bad"
            : urgency === "OK"
              ? "text-foreground"
              : "font-semibold text-warn",
        )}
      >
        {formatUtcDate(expiresOn)}
      </span>
      <span
        className={cn(
          "text-[0.65rem]",
          urgency === "EXPIRED"
            ? "text-bad"
            : urgency === "OK"
              ? "text-muted-foreground"
              : "text-warn",
        )}
      >
        {urgency === "EXPIRED" ? "expired " : "expires "}
        {relativeDays(days)}
      </span>
    </span>
  );
}

/** Compact urgency chip for dense rows. */
export function UrgencyPill({
  daysRemaining,
  className,
}: {
  daysRemaining: number;
  className?: string;
}) {
  const urgency = expiryUrgency(daysRemaining);
  return (
    <span className={cn(PILL, URGENCY_TONE[urgency], className)}>
      {urgency === "EXPIRED" ? "Expired" : relativeDays(daysRemaining)}
    </span>
  );
}

/**
 * A whole vehicle's or driver's paperwork in one cell.
 *
 * The blocking count is called out separately from the expiring count
 * because they mean different things: one is a truck that cannot leave the
 * yard, the other is a phone call to make this week.
 */
export function HealthBadge({
  health,
  className,
}: {
  health: DocumentHealth;
  className?: string;
}) {
  if (health.blocking.length > 0) {
    return (
      <span
        className={cn(PILL, "bg-bad-muted text-bad", className)}
        title={`Expired: ${health.blocking.map((k) => DOCUMENT_SHORT[k]).join(", ")}`}
      >
        <ShieldX className="size-3" />
        Blocked · {health.blocking.length}
      </span>
    );
  }

  if (health.expired.length > 0) {
    // Expired, but nothing mandatory — the vehicle may still run.
    return (
      <span
        className={cn(PILL, "bg-warn-muted text-warn", className)}
        title={`Expired but not mandatory: ${health.expired
          .map((d) => DOCUMENT_SHORT[d.kind])
          .join(", ")}`}
      >
        <AlertTriangle className="size-3" />
        Expired · {health.expired.length}
      </span>
    );
  }

  if (health.expiringSoon.length > 0) {
    const soonest = health.expiringSoon[0];
    return (
      <span
        className={cn(PILL, "bg-warn-muted text-warn", className)}
        title={`${DOCUMENT_SHORT[soonest.kind]} expires ${relativeDays(soonest.daysRemaining)}`}
      >
        <AlertTriangle className="size-3" />
        {relativeDays(soonest.daysRemaining)}
      </span>
    );
  }

  return (
    <span className={cn(PILL, "bg-ok-muted text-ok", className)}>
      <ShieldCheck className="size-3" />
      In date
    </span>
  );
}

/**
 * The verdict banner on a detail page.
 *
 * Stated in full sentences rather than a chip, because this is where
 * somebody decides whether to send the vehicle out, and "why not" matters
 * more than "no".
 */
export function AssignabilityNotice({
  result,
  subject,
}: {
  result: Assignability;
  subject: string;
}) {
  if (result.ok) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-ok/30 bg-ok-muted px-3.5 py-3 text-sm text-ok">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <p>
          <span className="font-medium">Can be assigned.</span> {subject} is
          available and its paperwork is in date.
        </p>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-lg border border-bad/40 bg-bad-muted px-3.5 py-3 text-sm text-bad"
    >
      <ShieldX className="mt-0.5 size-4 shrink-0" />
      <p>
        <span className="font-medium">Cannot be assigned to a trip.</span>{" "}
        {result.reason}
      </p>
    </div>
  );
}
