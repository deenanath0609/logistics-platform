import { format } from "date-fns";
import { AlertTriangle, Clock, ShieldAlert } from "lucide-react";
import type {
  ShipmentEventType,
  ShipmentStatus,
  EventSource,
} from "@/generated/prisma/client";
import { ruleFor, STATUS_LABELS } from "@/lib/shipment/state-machine";
import { cn } from "@/lib/utils";

export type TimelineEvent = {
  id: string;
  eventType: ShipmentEventType;
  occurredAt: Date;
  recordedAt: Date;
  clockDriftSeconds: number | null;
  remarks: string | null;
  source: EventSource;
  latitude: unknown;
  longitude: unknown;
  resultingStatus: ShipmentStatus | null;
  branch: { code: string; name: string } | null;
  user: { name: string } | null;
  reasonCode: { code: string; name: string } | null;
  package: { barcode: string } | null;
};

/** Drift beyond this suggests a device clock is wrong, not just slow sync. */
const DRIFT_WARNING_SECONDS = 15 * 60;

const SOURCE_LABEL: Record<EventSource, string> = {
  WEB: "Web",
  FIELD_APP: "Field app",
  API: "API",
  GPS: "GPS",
  SYSTEM: "System",
  IMPORT: "Import",
};

/**
 * The chain of custody, rendered.
 *
 * Every row answers who had it, where, and when — which is what settles a
 * damage claim months later. Events sort on `occurredAt`, not on when the
 * server heard about them, so an agent who synced an hour late still
 * appears in the right place.
 */
export function ShipmentTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        No events recorded yet.
      </p>
    );
  }

  return (
    <ol className="flex flex-col">
      {events.map((event, index) => {
        const rule = ruleFor(event.eventType);
        const isLast = index === events.length - 1;
        const changedStatus = Boolean(event.resultingStatus);
        const isException = Boolean(event.reasonCode);
        // A status somebody typed, not one that was earned. It is the only
        // entry here that did not follow from something physically
        // happening, so it does not get to look like the others.
        const isCorrection = event.eventType === "STATUS_CORRECTED";
        const drifted =
          event.clockDriftSeconds !== null &&
          Math.abs(event.clockDriftSeconds) > DRIFT_WARNING_SECONDS;

        return (
          <li key={event.id} className="grid grid-cols-[24px_minmax(0,1fr)] gap-3">
            {/* Rail */}
            <div className="relative flex justify-center">
              <span
                className={cn(
                  "mt-1.5 size-2.5 shrink-0 rounded-full ring-4 ring-background",
                  isCorrection
                    ? "size-3.5 border-2 border-bad bg-background"
                    : isException
                      ? "bg-bad"
                      : changedStatus
                        ? "bg-primary"
                        : "bg-border",
                )}
              />
              {!isLast && (
                <span className="absolute top-4 bottom-0 w-px bg-border" />
              )}
            </div>

            <div
              className={cn(
                "flex flex-col gap-1",
                isLast ? "pb-0" : "pb-5",
                isCorrection &&
                  "-my-1 mb-4 rounded-md border border-bad/40 bg-bad-muted px-3 py-2",
              )}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-medium">
                  {rule?.describe ?? event.eventType.replace(/_/g, " ")}
                </span>

                {isCorrection && (
                  <span className="inline-flex items-center gap-1 rounded-sm bg-bad px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-background">
                    <ShieldAlert className="size-3" />
                    Entered by hand
                  </span>
                )}

                {event.resultingStatus && (
                  <span className="font-mono text-[0.65rem] uppercase tracking-wider text-primary">
                    → {STATUS_LABELS[event.resultingStatus]}
                  </span>
                )}

                {event.source !== "WEB" && (
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-muted-foreground">
                    {SOURCE_LABEL[event.source]}
                  </span>
                )}
              </div>

              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="font-mono tabular">
                  {format(event.occurredAt, "dd MMM yyyy · HH:mm")}
                </span>
                {event.branch && (
                  <>
                    <span aria-hidden>·</span>
                    <span>
                      {event.branch.name}
                      <span className="ml-1 font-mono">{event.branch.code}</span>
                    </span>
                  </>
                )}
                {event.user && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{event.user.name}</span>
                  </>
                )}
                {event.package && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-mono">{event.package.barcode}</span>
                  </>
                )}
                {event.latitude != null && event.longitude != null && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-mono">
                      {Number(event.latitude).toFixed(4)},{" "}
                      {Number(event.longitude).toFixed(4)}
                    </span>
                  </>
                )}
              </p>

              {event.reasonCode && (
                <p className="flex items-start gap-1.5 text-xs text-bad">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  <span>
                    {event.reasonCode.name}
                    <span className="ml-1.5 font-mono text-[0.65rem] opacity-70">
                      {event.reasonCode.code}
                    </span>
                  </span>
                </p>
              )}

              {event.remarks && (
                <p className="text-xs text-foreground/80">{event.remarks}</p>
              )}

              {drifted && (
                <p
                  className="flex items-center gap-1.5 text-xs text-warn"
                  title="The device clock differed from the server when this synced"
                >
                  <Clock className="size-3 shrink-0" />
                  Recorded {format(event.recordedAt, "dd MMM HH:mm")} — captured
                  offline, clock differed by{" "}
                  {Math.round((event.clockDriftSeconds ?? 0) / 60)} min
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
