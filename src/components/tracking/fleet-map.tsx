"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { fitProjection, type LatLng } from "@/lib/tracking/geo";
import type { FleetVehicle, LiveFleet } from "@/lib/tracking/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Age, AutoRefresh, formatAge } from "./live-time";
import { TrackingIcon } from "./icon";
import { ManualEventDialog, type BranchOption } from "./manual-event";

/**
 * The live map.
 *
 * `MAPS_PROVIDER` is `mock` and there is no tile key, so this is a
 * schematic rather than a map — but a schematic drawn from real
 * coordinates. Branches sit where they sit relative to one another,
 * vehicles sit at their actual fixes, and lanes are the planned polylines
 * thinned for the wire. What is missing is the basemap: roads, rivers, town
 * names. Everything a dispatcher actually asks of this screen — who is
 * where, who is late, who has stopped, who has gone quiet — is answerable
 * from it, and the screen says plainly what it is so nobody mistakes the
 * absence of a road for the absence of a road.
 *
 * Below it, the same fleet as a table. That is not a fallback for a failed
 * render; it is the view a branch manager on a laptop actually reads, and
 * it sorts and scans in ways a picture cannot.
 */

const WIDTH = 1000;
const HEIGHT = 560;

type Filter = "all" | "moving" | "stopped" | "silent" | "alerts";

const TONE_CLASS: Record<FleetVehicle["tone"], { fill: string; text: string; chip: string }> = {
  ok: { fill: "fill-ok", text: "text-ok", chip: "bg-ok-muted text-ok" },
  warn: { fill: "fill-warn", text: "text-warn", chip: "bg-warn-muted text-warn" },
  bad: { fill: "fill-bad", text: "text-bad", chip: "bg-bad-muted text-bad" },
  idle: { fill: "fill-muted-foreground", text: "text-muted-foreground", chip: "bg-muted text-muted-foreground" },
};

const TONE_LABEL: Record<FleetVehicle["tone"], string> = {
  ok: "Moving",
  warn: "Attention",
  bad: "Alert",
  idle: "Idle",
};

export function FleetMap({
  fleet,
  canReplay,
  canRecordManual,
}: {
  fleet: LiveFleet;
  canReplay: boolean;
  canRecordManual: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(
    () => fleet.vehicles.filter((vehicle) => matches(vehicle, filter)),
    [fleet.vehicles, filter],
  );

  const selected =
    fleet.vehicles.find((vehicle) => vehicle.vehicleId === selectedId) ?? null;

  // Fitted over everything that will be drawn, so nothing lands off canvas.
  const project = useMemo(() => {
    const points: LatLng[] = [
      ...fleet.branches.map((branch) => branch.point),
      ...fleet.routes.flatMap((route) => route.points),
      ...fleet.vehicles
        .map((vehicle) => vehicle.position)
        .filter((point): point is LatLng => point !== null),
    ];
    const fit = fitProjection(points);
    return (point: LatLng) => {
      const { x, y } = fit(point);
      return { x: x * WIDTH, y: y * HEIGHT };
    };
  }, [fleet.branches, fleet.routes, fleet.vehicles]);

  const plotted = visible.filter((vehicle) => vehicle.position !== null);
  const unplotted = visible.filter((vehicle) => vehicle.position === null);
  const canDraw = fleet.branches.length > 0 || plotted.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh seconds={30} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["all", `All ${fleet.vehicles.length}`],
              ["moving", `Moving ${fleet.counts.moving}`],
              ["stopped", `Stopped ${fleet.counts.stopped}`],
              ["silent", `No signal ${fleet.counts.silent}`],
              ["alerts", `Alerts ${fleet.vehicles.filter((v) => v.alerts.length > 0).length}`],
            ] as Array<[Filter, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                "rounded-lg border px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-[0.13em] transition-colors",
                filter === value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <p className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
          As of {new Date(fleet.asOf).toLocaleTimeString()} · refreshes every 30s
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
              <div className="flex items-center gap-2">
                <TrackingIcon name="route" className="size-4 text-primary" />
                <span className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
                  Network schematic
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {(Object.keys(TONE_LABEL) as Array<FleetVehicle["tone"]>).map((tone) => (
                  <span
                    key={tone}
                    className="flex items-center gap-1.5 text-[0.65rem] text-muted-foreground"
                  >
                    <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true">
                      <circle cx="5" cy="5" r="5" className={TONE_CLASS[tone].fill} />
                    </svg>
                    {TONE_LABEL[tone]}
                  </span>
                ))}
              </div>
            </div>

            {canDraw ? (
              <div className="overflow-x-auto">
                <svg
                  viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                  className="h-auto w-full min-w-[640px] bg-background"
                  role="img"
                  aria-label={`Schematic of ${plotted.length} tracked vehicles across ${fleet.branches.length} network nodes`}
                >
                  <defs>
                    <pattern
                      id="tracking-grid"
                      width="50"
                      height="50"
                      patternUnits="userSpaceOnUse"
                    >
                      <path
                        d="M 50 0 L 0 0 0 50"
                        fill="none"
                        className="stroke-border"
                        strokeWidth="0.5"
                        opacity="0.5"
                      />
                    </pattern>
                  </defs>
                  <rect width={WIDTH} height={HEIGHT} fill="url(#tracking-grid)" />

                  {/* Planned lanes */}
                  {fleet.routes.map((route) => {
                    const isSelected = selected?.trip?.id === route.tripId;
                    return (
                      <polyline
                        key={route.tripId}
                        points={route.points
                          .map((point) => {
                            const { x, y } = project(point);
                            return `${x.toFixed(1)},${y.toFixed(1)}`;
                          })
                          .join(" ")}
                        fill="none"
                        className={isSelected ? "stroke-primary" : "stroke-border"}
                        strokeWidth={isSelected ? 2.5 : 1.5}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        strokeDasharray={isSelected ? undefined : "5 5"}
                        opacity={isSelected ? 1 : 0.7}
                      />
                    );
                  })}

                  {/* Network nodes */}
                  {fleet.branches.map((branch) => {
                    const { x, y } = project(branch.point);
                    const isHub = branch.type === "HUB" || branch.type === "HEAD_OFFICE";
                    return (
                      <g key={branch.id}>
                        {isHub ? (
                          <rect
                            x={x - 5}
                            y={y - 5}
                            width={10}
                            height={10}
                            className="fill-card stroke-primary"
                            strokeWidth={2}
                          />
                        ) : (
                          <circle
                            cx={x}
                            cy={y}
                            r={4}
                            className="fill-card stroke-muted-foreground"
                            strokeWidth={1.5}
                          />
                        )}
                        <text
                          x={x + 9}
                          y={y + 3.5}
                          className="fill-muted-foreground font-mono"
                          fontSize="10"
                        >
                          {branch.code}
                        </text>
                        <title>{`${branch.code} — ${branch.name}`}</title>
                      </g>
                    );
                  })}

                  {/* Vehicles */}
                  {plotted.map((vehicle) => {
                    const { x, y } = project(vehicle.position!);
                    const isSelected = vehicle.vehicleId === selectedId;
                    const tone = TONE_CLASS[vehicle.tone];
                    return (
                      <g
                        key={vehicle.vehicleId}
                        className="cursor-pointer"
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedId(vehicle.vehicleId)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedId(vehicle.vehicleId);
                          }
                        }}
                      >
                        {isSelected && (
                          <circle
                            cx={x}
                            cy={y}
                            r={13}
                            fill="none"
                            className="stroke-primary"
                            strokeWidth={2}
                          />
                        )}
                        <circle cx={x} cy={y} r={7} className={cn(tone.fill, "stroke-background")} strokeWidth={2} />
                        {vehicle.heading !== null && (
                          <path
                            d="M 0 -12 L 3.5 -5.5 L -3.5 -5.5 Z"
                            className={tone.fill}
                            transform={`translate(${x} ${y}) rotate(${vehicle.heading})`}
                          />
                        )}
                        <text
                          x={x}
                          y={y + 22}
                          textAnchor="middle"
                          className="fill-foreground font-mono"
                          fontSize="9.5"
                        >
                          {vehicle.registrationNumber}
                        </text>
                        <title>
                          {`${vehicle.registrationNumber} · ${vehicle.trip?.originCode ?? "?"} → ${
                            vehicle.trip?.destinationCode ?? "?"
                          } · ${vehicle.speedKmph ?? 0} km/h`}
                        </title>
                      </g>
                    );
                  })}
                </svg>
              </div>
            ) : (
              <div className="px-6 py-16 text-center">
                <p className="font-medium">Nothing to draw yet</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  No vehicle on a running trip has reported a position, and no
                  branch on those lanes has coordinates on file.
                </p>
              </div>
            )}

            <p className="flex items-start gap-2 border-t bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
              <TrackingIcon name="pin" className="mt-0.5 size-3.5 shrink-0" />
              <span>
                A schematic, not a map. Positions and lanes are real
                coordinates, drawn to scale relative to each other; roads and
                place names arrive with the maps provider, which is currently
                set to <span className="font-mono">mock</span> with no key on
                file.
              </span>
            </p>
          </div>

          {unplotted.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {unplotted.length} vehicle{unplotted.length === 1 ? "" : "s"} on a
              running trip {unplotted.length === 1 ? "has" : "have"} no position
              at all — no device fitted, or nothing reported since dispatch.
              {unplotted.length <= 6 && (
                <> {unplotted.map((v) => v.registrationNumber).join(", ")}.</>
              )}
            </p>
          )}

          <FleetTable
            vehicles={visible}
            asOf={fleet.asOf}
            selectedId={selectedId}
            onSelect={setSelectedId}
            canReplay={canReplay}
          />
        </div>

        <VehiclePanel
          vehicle={selected}
          asOf={fleet.asOf}
          branches={fleet.branches}
          canReplay={canReplay}
          canRecordManual={canRecordManual}
        />
      </div>
    </div>
  );
}

function matches(vehicle: FleetVehicle, filter: Filter): boolean {
  switch (filter) {
    case "moving":
      return (vehicle.speedKmph ?? 0) > 3;
    case "stopped":
      return vehicle.position !== null && (vehicle.speedKmph ?? 0) <= 3;
    case "silent":
      return vehicle.hasDevice && (vehicle.lastPingAgeMinutes ?? Infinity) >= 20;
    case "alerts":
      return vehicle.alerts.length > 0;
    default:
      return true;
  }
}

// ────────────────────────────────────────────────────────────

function FleetTable({
  vehicles,
  asOf,
  selectedId,
  onSelect,
  canReplay,
}: {
  vehicles: FleetVehicle[];
  asOf: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  canReplay: boolean;
}) {
  if (vehicles.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-6 py-12 text-center">
        <p className="font-medium">Nothing here</p>
        <p className="mt-1 text-sm text-muted-foreground">
          No vehicle matches this filter right now.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="border-b bg-muted/40 text-left">
          <tr className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
            <th className="px-3 py-2 font-medium">Vehicle</th>
            <th className="px-3 py-2 font-medium">Lane</th>
            <th className="px-3 py-2 font-medium">Speed</th>
            <th className="px-3 py-2 font-medium">Last fix</th>
            <th className="px-3 py-2 font-medium">Covered / left</th>
            <th className="px-3 py-2 font-medium">ETA</th>
            <th className="px-3 py-2 font-medium">On board</th>
            <th className="px-3 py-2 font-medium">State</th>
          </tr>
        </thead>
        <tbody>
          {vehicles.map((vehicle) => (
            <tr
              key={vehicle.vehicleId}
              onClick={() => onSelect(vehicle.vehicleId)}
              className={cn(
                "cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/50",
                vehicle.vehicleId === selectedId && "bg-accent/60",
              )}
            >
              <td className="px-3 py-2">
                <span className="font-mono text-xs font-medium">
                  {vehicle.registrationNumber}
                </span>
                <span className="ml-2 text-[0.7rem] text-muted-foreground">
                  {vehicle.vehicleType}
                </span>
                {!vehicle.hasDevice && (
                  <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-muted-foreground">
                    No device
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                {vehicle.trip ? (
                  <>
                    {vehicle.trip.originCode}
                    <span className="mx-1 text-muted-foreground">→</span>
                    {vehicle.trip.destinationCode}
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs tabular">
                {vehicle.speedKmph === null ? "—" : `${Math.round(vehicle.speedKmph)} km/h`}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                {vehicle.positionAt ? (
                  <Age
                    at={vehicle.positionAt}
                    initial={formatAge(
                      new Date(asOf).getTime() - new Date(vehicle.positionAt).getTime(),
                    )}
                  />
                ) : (
                  "never"
                )}
                {vehicle.manualPosition && (
                  <span className="ml-1.5 rounded-sm bg-info-muted px-1 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-info">
                    manual
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs tabular text-muted-foreground">
                {vehicle.coveredKm === null
                  ? "—"
                  : `${vehicle.coveredKm.toFixed(0)} / ${vehicle.remainingKm?.toFixed(0) ?? "?"} km`}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs tabular">
                <EtaCell vehicle={vehicle} />
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground tabular">
                {vehicle.trip?.shipmentCount ?? 0}
              </td>
              <td className="px-3 py-2">
                <span
                  className={cn(
                    "whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider",
                    TONE_CLASS[vehicle.tone].chip,
                  )}
                >
                  {vehicle.alerts.length > 0
                    ? vehicle.alerts[0].kind.replace(/_/g, " ")
                    : TONE_LABEL[vehicle.tone]}
                </span>
                {canReplay && vehicle.trip && (
                  <Link
                    href={`/tracking/trips/${vehicle.trip.id}`}
                    onClick={(event) => event.stopPropagation()}
                    className="ml-2 font-mono text-[0.6rem] uppercase tracking-wider text-primary hover:underline"
                  >
                    Replay
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EtaCell({ vehicle }: { vehicle: FleetVehicle }) {
  if (!vehicle.eta) {
    return <span className="text-muted-foreground">not estimated</span>;
  }

  const late = vehicle.eta.delayMinutes;
  return (
    <span className="flex flex-col">
      <span
        className={cn(
          late !== null && late > 30 ? "text-bad" : late !== null && late > 0 ? "text-warn" : undefined,
        )}
      >
        {new Date(vehicle.eta.at).toLocaleString(undefined, {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      {late !== null && (
        <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
          {late > 0 ? `${late} min late` : late < 0 ? `${Math.abs(late)} min early` : "on time"}
        </span>
      )}
    </span>
  );
}

// ────────────────────────────────────────────────────────────

function VehiclePanel({
  vehicle,
  asOf,
  branches,
  canReplay,
  canRecordManual,
}: {
  vehicle: FleetVehicle | null;
  asOf: string;
  branches: BranchOption[];
  canReplay: boolean;
  canRecordManual: boolean;
}) {
  if (!vehicle) {
    return (
      <aside className="hidden h-fit rounded-lg border bg-card p-5 xl:block">
        <TrackingIcon name="truck" className="size-5 text-muted-foreground" />
        <p className="mt-3 font-medium">Pick a vehicle</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Click a marker or a row for its position, speed, last-ping age,
          distance covered and remaining, arrival estimate, driver, trip, and
          the consignments on board.
        </p>
      </aside>
    );
  }

  return (
    <aside className="h-fit rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-mono text-sm font-medium">{vehicle.registrationNumber}</p>
            <p className="text-xs text-muted-foreground">
              {vehicle.vehicleType} · {vehicle.ownership.toLowerCase()}
            </p>
          </div>
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider",
              TONE_CLASS[vehicle.tone].chip,
            )}
          >
            {TONE_LABEL[vehicle.tone]}
          </span>
        </div>
      </div>

      {vehicle.alerts.length > 0 && (
        <div className="border-b px-4 py-3">
          <ul className="flex flex-col gap-2">
            {vehicle.alerts.map((alert) => (
              <li key={alert.id} className="flex items-start gap-2 text-xs">
                <TrackingIcon name="alert" className="mt-0.5 size-3.5 shrink-0 text-bad" />
                <span>
                  <span className="block font-medium">{alert.summary}</span>
                  <span className="text-muted-foreground">
                    <Age
                      at={alert.detectedAt}
                      initial={formatAge(
                        new Date(asOf).getTime() - new Date(alert.detectedAt).getTime(),
                      )}
                    />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-3 border-b px-4 py-3 text-xs">
        <Fact label="Position">
          {vehicle.position
            ? `${vehicle.position.lat.toFixed(4)}, ${vehicle.position.lng.toFixed(4)}`
            : "unknown"}
        </Fact>
        <Fact label="Last fix">
          {vehicle.positionAt ? (
            <Age
              at={vehicle.positionAt}
              initial={formatAge(
                new Date(asOf).getTime() - new Date(vehicle.positionAt).getTime(),
              )}
            />
          ) : (
            "never"
          )}
        </Fact>
        <Fact label="Speed">
          {vehicle.speedKmph === null ? "—" : `${Math.round(vehicle.speedKmph)} km/h`}
        </Fact>
        <Fact label="Nearest node">
          {vehicle.nearestBranchCode
            ? `${vehicle.nearestBranchCode}${
                vehicle.distanceToNearestKm !== null
                  ? ` · ${vehicle.distanceToNearestKm.toFixed(0)} km`
                  : ""
              }`
            : "—"}
        </Fact>
        <Fact label="Covered">
          {vehicle.coveredKm === null ? "—" : `${vehicle.coveredKm.toFixed(0)} km`}
        </Fact>
        <Fact label="Remaining">
          {vehicle.remainingKm === null ? "—" : `${vehicle.remainingKm.toFixed(0)} km`}
        </Fact>
        <Fact label="Driver">{vehicle.trip?.driverName ?? "not assigned"}</Fact>
        <Fact label="Contact">
          <span className="font-mono">{vehicle.trip?.driverMobile ?? "—"}</span>
        </Fact>
      </dl>

      {vehicle.progress !== null && (
        <div className="border-b px-4 py-3">
          <div className="mb-1.5 flex items-center justify-between font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
            <span>{vehicle.trip?.originCode}</span>
            <span>{Math.round(vehicle.progress * 100)}%</span>
            <span>{vehicle.trip?.destinationCode}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", vehicle.tone === "bad" ? "bg-bad" : "bg-primary")}
              style={{ width: `${Math.round(vehicle.progress * 100)}%` }}
            />
          </div>
          {vehicle.routeQuality === "straight-line" && (
            <p className="mt-2 text-[0.7rem] text-muted-foreground">
              Progress is measured against a straight line between the two
              branches — this lane has no planned polyline on file, so treat
              the percentage as a rough guide.
            </p>
          )}
        </div>
      )}

      <div className="border-b px-4 py-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
            Arrival estimate
          </span>
          {vehicle.eta && (
            <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
              {vehicle.eta.method} · {vehicle.eta.confidence ?? "—"}
            </span>
          )}
        </div>
        {vehicle.eta ? (
          <p className="mt-1.5">
            {new Date(vehicle.eta.at).toLocaleString()}
            {vehicle.eta.delayMinutes !== null && vehicle.eta.delayMinutes > 0 && (
              <span className="ml-2 text-bad">{vehicle.eta.delayMinutes} min late</span>
            )}
          </p>
        ) : (
          <p className="mt-1.5 text-muted-foreground">
            No estimate. A stationary vehicle, a lane with no planned route, or
            too little history — the number is withheld rather than guessed.
          </p>
        )}
      </div>

      {vehicle.trip && (
        <div className="border-b px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              On board · {vehicle.trip.shipmentCount}
            </span>
            <Link
              href={`/dispatch/trips/${vehicle.trip.id}`}
              className="font-mono text-[0.6rem] uppercase tracking-wider text-primary hover:underline"
            >
              {vehicle.trip.number}
            </Link>
          </div>
          <ul className="mt-2 flex max-h-52 flex-col gap-1 overflow-y-auto">
            {vehicle.trip.shipments.map((shipment) => (
              <li key={shipment.id} className="flex items-center justify-between gap-2 text-xs">
                <Link
                  href={`/shipments/${shipment.id}`}
                  className="font-mono hover:underline"
                >
                  {shipment.lrNumber}
                </Link>
                <span className="truncate text-muted-foreground">{shipment.consignee}</span>
              </li>
            ))}
            {vehicle.trip.shipmentCount > vehicle.trip.shipments.length && (
              <li className="text-xs text-muted-foreground">
                and {vehicle.trip.shipmentCount - vehicle.trip.shipments.length} more
              </li>
            )}
            {vehicle.trip.shipmentCount === 0 && (
              <li className="text-xs text-warn">Running empty.</li>
            )}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2 px-4 py-3">
        {canReplay && vehicle.trip && (
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/tracking/trips/${vehicle.trip.id}`} />}
          >
            Replay trip
          </Button>
        )}
        {canRecordManual && (
          <ManualEventDialog
            vehicleId={vehicle.vehicleId}
            registrationNumber={vehicle.registrationNumber}
            trip={
              vehicle.trip
                ? {
                    id: vehicle.trip.id,
                    number: vehicle.trip.number,
                    originCode: vehicle.trip.originCode,
                    destinationCode: vehicle.trip.destinationCode,
                  }
                : null
            }
            branches={branches}
            hasDevice={vehicle.hasDevice}
          />
        )}
      </div>
    </aside>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 tabular">{children}</dd>
    </div>
  );
}
