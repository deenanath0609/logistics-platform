import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { can, requirePermission } from "@/lib/auth/session";
import { isSimulated } from "@/lib/tracking/providers";
import { resolvePollProviders } from "@/lib/tracking/providers/resolve";
import { loadLiveFleet } from "@/lib/tracking/queries";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { FleetMap } from "@/components/tracking/fleet-map";

export const metadata: Metadata = { title: "Live tracking" };
export const dynamic = "force-dynamic";

/**
 * The live map (docs/BRD.html §A.9).
 *
 * Everything is assembled on the server and handed down as plain data.
 * That is not only a performance choice: `VehicleLocation` and
 * `EtaSnapshot` carry Prisma `Decimal` values, which do not survive the
 * serialisation boundary, and the branch scoping that decides which trips a
 * user may see has to run somewhere a client cannot reach.
 */
/**
 * Whether this carrier's positions are fiction.
 *
 * Asked of the carrier's own vendor rows, not of `GPS_PROVIDER`. The
 * environment variable is the platform's fallback for a carrier who has
 * configured nothing; reading it directly told a carrier polling a real
 * vendor that their fleet was simulated whenever the development default
 * was in place, and — far worse — said nothing at all to a carrier whose
 * own rows are the mock while the environment names something real. This
 * is the same question `resolvePollProviders` answers for the poller, and
 * it deserves the same answer.
 *
 * Active rows include the push-only ones, which `resolvePollProviders`
 * correctly excludes: a vendor that pushes still supplies real positions,
 * and the banner is about where the fixes come from rather than how.
 */
async function runningOnSimulatedPositions(): Promise<boolean> {
  const configured = await prisma.trackingProviderConfig.findMany({
    where: { isActive: true },
    select: { code: true },
  });

  const codes =
    configured.length > 0
      ? configured.map((row) => row.code)
      : // Nothing of their own: the operator-held credential, or the
        // environment. `resolvePollProviders` resolves both, in that order.
        (await resolvePollProviders()).map((entry) => entry.code);

  return codes.length > 0 && codes.every((code) => isSimulated(code));
}

export default async function TrackingPage() {
  const user = await requirePermission("tracking.read");

  const [fleet, unassignedAlerts] = await Promise.all([
    loadLiveFleet(user),
    prisma.trackingAlert.count({ where: { resolvedAt: null } }),
  ]);

  const simulated = await runningOnSimulatedPositions();
  const canManageProviders = can(user, "geofence.manage");

  return (
    <>
      <PageHeader
        eyebrow="Tracking"
        title="Live map"
        description="Every vehicle on a running trip, coloured by what is wrong with it. Click one for its position, speed, last-ping age, distance covered and remaining, arrival estimate, driver, and the consignments on board."
        actions={
          canManageProviders && (
            <>
              <Button variant="outline" render={<Link href="/tracking/geofences" />}>
                Geofences
              </Button>
              <Button variant="outline" render={<Link href="/tracking/providers" />}>
                Providers
              </Button>
            </>
          )
        }
      />

      {simulated && (
        <div className="mb-4 rounded-lg border border-info/40 bg-info-muted/40 px-4 py-3 text-sm">
          <p className="font-medium text-info">Running on simulated positions</p>
          <p className="mt-1 text-muted-foreground">
            Every telematics vendor configured for this carrier is the
            simulated adapter, so every fix on this screen is generated from
            the trip&apos;s own planned route rather than from a device. The
            pipeline behind it — dedupe, geofence debounce, arrival
            propagation, deviation, stoppage, ETA — is the same one a real
            provider will drive. Attach a vendor adapter on the{" "}
            <Link href="/tracking/providers" className="underline">
              provider screen
            </Link>{" "}
            and nothing on this page changes.
          </p>
        </div>
      )}

      {fleet.vehicles.length === 0 ? (
        <div className="rounded-lg border bg-card px-6 py-16 text-center">
          <p className="font-medium">No trip is running</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            The live map follows dispatched trips. Gate a vehicle out from the
            dispatch board and it appears here on its next position report.
          </p>
          <Button
            variant="outline"
            className="mt-4"
            render={<Link href="/dispatch/trips" />}
          >
            Go to trips
          </Button>
        </div>
      ) : (
        <FleetMap
          fleet={fleet}
          canReplay={can(user, "tracking.replay")}
          canRecordManual={can(user, "tracking.read")}
          canRecordMovement={can(user, "trip.dispatch")}
        />
      )}

      {unassignedAlerts > 0 && (
        <p className="mt-4 text-xs text-muted-foreground">
          {unassignedAlerts} tracking alert{unassignedAlerts === 1 ? "" : "s"}{" "}
          open across the fleet, including vehicles outside your branch scope.
          Deviations, stoppages and signal loss also open an exception in the
          control tower, where they get an owner and an escalation clock.
        </p>
      )}
    </>
  );
}
