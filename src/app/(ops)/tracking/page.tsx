import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { can, requirePermission } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";
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
export default async function TrackingPage() {
  const user = await requirePermission("tracking.read");

  const [fleet, unassignedAlerts] = await Promise.all([
    loadLiveFleet(user),
    prisma.trackingAlert.count({ where: { resolvedAt: null } }),
  ]);

  const env = getEnv();
  const simulated = env.GPS_PROVIDER === "mock";
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
            <span className="font-mono">GPS_PROVIDER</span> is set to{" "}
            <span className="font-mono">mock</span>, so every fix on this screen
            is generated from the trip&apos;s own planned route rather than from
            a device. The pipeline behind it — dedupe, geofence debounce,
            arrival propagation, deviation, stoppage, ETA — is the same one a
            real provider will drive. Attach a vendor adapter and nothing on
            this page changes.
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
