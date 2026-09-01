import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { requirePermission } from "@/lib/auth/session";
import { loadTripReplay } from "@/lib/tracking/queries";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { TripReplayView } from "@/components/tracking/trip-replay";

export const metadata: Metadata = { title: "Trip replay" };
export const dynamic = "force-dynamic";

/**
 * Historical playback for disputes and driver review (docs/BRD.html §A.9).
 *
 * Guarded by `tracking.replay` rather than `tracking.read`: the live map
 * answers "where is my truck", which most of the operation needs, while
 * this answers "where was it at 14:20 on Tuesday", which is evidence in an
 * argument about a claim and belongs with the people who handle those.
 */
export default async function TripReplayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("tracking.replay");
  const { id } = await params;

  // Scoped to the branches this user covers. A trip outside them is a 404
  // rather than a refusal: "no such trip" and "not yours" should look
  // identical from outside, or the URL becomes a way to enumerate the
  // network.
  const replay = await loadTripReplay(id, user);
  if (!replay) notFound();

  const { trip, stats, provenance } = replay;

  return (
    <>
      <PageHeader
        eyebrow="Tracking"
        title={`Replay · ${trip.number}`}
        description={`${trip.vehicle} on ${trip.originCode} → ${trip.destinationCode}${
          trip.driverName ? `, driven by ${trip.driverName}` : ""
        }.`}
        actions={
          <>
            <Button variant="outline" render={<Link href="/tracking" />}>
              Live map
            </Button>
            <Button variant="outline" render={<Link href={`/dispatch/trips/${trip.id}`} />}>
              Trip sheet
            </Button>
          </>
        }
      />

      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Departed">
          {trip.departedAt ? format(new Date(trip.departedAt), "dd MMM HH:mm") : "—"}
        </Stat>
        <Stat label="Arrived">
          {trip.arrivedAt ? format(new Date(trip.arrivedAt), "dd MMM HH:mm") : "still running"}
        </Stat>
        <Stat label="Tracked">
          {stats.trackedKm.toFixed(0)} km
          {stats.routeKm > 0 && (
            <span className="ml-1 text-[0.7rem] text-muted-foreground">
              of {stats.routeKm.toFixed(0)} planned
            </span>
          )}
        </Stat>
        <Stat label="Moving">{formatMinutes(stats.movingMinutes)}</Stat>
        <Stat label="Stopped">{formatMinutes(stats.stoppedMinutes)}</Stat>
        <Stat label="Peak speed">
          {stats.maxSpeedKmph === null ? "—" : `${Math.round(stats.maxSpeedKmph)} km/h`}
        </Stat>
      </dl>

      {stats.trackedKm > 0 && stats.routeKm > 0 && stats.trackedKm > stats.routeKm * 1.15 && (
        <p className="mb-4 rounded-lg border border-warn/40 bg-warn-muted/40 px-4 py-2.5 text-sm text-warn">
          The recorded trail is {((stats.trackedKm / stats.routeKm - 1) * 100).toFixed(0)}%
          longer than the planned lane. That is either a genuine diversion or
          GPS noise accumulating over a long stationary period — the profile
          below distinguishes them.
        </p>
      )}

      <TripReplayView replay={replay} />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border bg-card">
          <h2 className="border-b px-4 py-2.5 font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
            Geofence crossings
          </h2>
          {replay.fences.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              No fence was crossed on this trip. Either the branches on this
              lane have no geofences defined, or nothing was reported near
              them.
            </p>
          ) : (
            <ul className="divide-y">
              {replay.fences.map((fence) => (
                <li key={fence.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                  <span>
                    <span className="font-medium">{fence.name}</span>
                    <span className="ml-2 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                      {fence.direction}
                    </span>
                    {!fence.propagated && (
                      <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-muted-foreground">
                        not propagated
                      </span>
                    )}
                    {fence.dwellMinutes !== null && (
                      <span className="block text-xs text-muted-foreground">
                        dwelt {formatMinutes(fence.dwellMinutes)}
                      </span>
                    )}
                  </span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground tabular">
                    {format(new Date(fence.at), "dd MMM HH:mm")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border bg-card">
          <h2 className="border-b px-4 py-2.5 font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
            Alerts raised
          </h2>
          {replay.alerts.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              Nothing was raised against this vehicle during the trip.
            </p>
          ) : (
            <ul className="divide-y">
              {replay.alerts.map((alert) => (
                <li key={alert.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                  <span>
                    <span className="font-medium">{alert.summary}</span>
                    <span className="block font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                      {alert.kind.replace(/_/g, " ")}
                      {alert.resolvedAt ? " · closed" : " · open"}
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground tabular">
                    {format(new Date(alert.detectedAt), "dd MMM HH:mm")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="mt-4 rounded-lg border bg-card px-4 py-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
          How this trip&apos;s events were recorded
        </h2>
        <p className="mt-2 text-sm">
          <span className="font-medium tabular">{provenance.automatic}</span>{" "}
          movement event{provenance.automatic === 1 ? "" : "s"} came from the
          tracking pipeline, and{" "}
          <span className="font-medium tabular">{provenance.manual}</span> were
          entered by a person.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Both are the same event through the same state machine; only{" "}
          <span className="font-mono">source</span> differs. A fleet that is
          half attached vehicles will never be fully automatic, and knowing the
          split is how you tell whether a telematics contract is earning its
          keep.
        </p>
      </section>
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <dt className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm tabular">{children}</dd>
    </div>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
