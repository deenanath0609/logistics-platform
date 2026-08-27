"use client";

import { useMemo, useState } from "react";
import { fitProjection, type LatLng } from "@/lib/tracking/geo";
import type { TripReplay } from "@/lib/tracking/queries";
import { cn } from "@/lib/utils";
import { TrackingIcon } from "./icon";

/**
 * Trip replay (docs/BRD.html §A.9).
 *
 * Built for two conversations that actually happen: a customer disputing
 * when a vehicle arrived, and a supervisor reviewing how a driver drove.
 * Both need the same three things side by side — where it went, how fast,
 * and where the gaps are — and the gaps matter most. A trail with two hours
 * missing is not a trail that proves anything, and the profile marks the
 * silence rather than drawing a confident line through it.
 *
 * The scrubber moves one marker along the recorded trail. It is not an
 * animation: somebody arguing about a timestamp wants to land on a fix and
 * read it, not watch a truck drive past the moment they care about.
 */

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 460;
const PROFILE_WIDTH = 1000;
const PROFILE_HEIGHT = 160;

/** A jump longer than this in the trail is drawn as a break, not a line. */
const GAP_MINUTES = 15;

export function TripReplayView({ replay }: { replay: TripReplay }) {
  const [index, setIndex] = useState(replay.fixes.length - 1);

  const project = useMemo(() => {
    const points: LatLng[] = [
      ...replay.route,
      ...replay.fixes.map((fix) => ({ lat: fix.lat, lng: fix.lng })),
    ];
    const fit = fitProjection(points);
    return (point: LatLng) => {
      const { x, y } = fit(point);
      return { x: x * MAP_WIDTH, y: y * MAP_HEIGHT };
    };
  }, [replay.route, replay.fixes]);

  /**
   * The trail, split wherever the device went quiet. Drawing one unbroken
   * polyline across a two-hour gap invents a route the vehicle may never
   * have taken, and a replay used to settle a dispute must not invent.
   */
  const segments = useMemo(() => {
    const out: Array<Array<{ x: number; y: number }>> = [];
    let current: Array<{ x: number; y: number }> = [];

    replay.fixes.forEach((fix, i) => {
      const previous = i > 0 ? replay.fixes[i - 1] : null;
      const gapped =
        previous !== null &&
        new Date(fix.at).getTime() - new Date(previous.at).getTime() >
          GAP_MINUTES * 60_000;

      if (gapped && current.length > 0) {
        out.push(current);
        current = [];
      }
      current.push(project({ lat: fix.lat, lng: fix.lng }));
    });

    if (current.length > 0) out.push(current);
    return out;
  }, [replay.fixes, project]);

  const active = replay.fixes[Math.min(index, replay.fixes.length - 1)] ?? null;

  const maxSpeed = Math.max(
    10,
    ...replay.fixes.map((fix) => fix.speedKmph ?? 0),
  );

  const startMs = replay.fixes.length > 0 ? new Date(replay.fixes[0].at).getTime() : 0;
  const endMs =
    replay.fixes.length > 0
      ? new Date(replay.fixes[replay.fixes.length - 1].at).getTime()
      : 1;
  const spanMs = Math.max(1, endMs - startMs);

  if (replay.fixes.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-6 py-16 text-center">
        <TrackingIcon name="silent" className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-3 font-medium">No positions recorded for this trip</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Either the vehicle has no device fitted, or nothing was received
          between gate-out and gate-in. Any manual position reports and the
          gate events themselves are still on the trip and the consignment
          timelines.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
            Recorded trail · {replay.stats.fixCount} fixes
          </span>
          <span className="flex flex-wrap items-center gap-3 text-[0.65rem] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <svg viewBox="0 0 20 4" className="h-1 w-5" aria-hidden="true">
                <line x1="0" y1="2" x2="20" y2="2" className="stroke-border" strokeWidth="2" strokeDasharray="4 4" />
              </svg>
              Planned
            </span>
            <span className="flex items-center gap-1.5">
              <svg viewBox="0 0 20 4" className="h-1 w-5" aria-hidden="true">
                <line x1="0" y1="2" x2="20" y2="2" className="stroke-primary" strokeWidth="2" />
              </svg>
              Actual
            </span>
          </span>
        </div>

        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
            className="h-auto w-full min-w-[640px] bg-background"
            role="img"
            aria-label={`Recorded path of ${replay.trip.vehicle} on trip ${replay.trip.number}`}
          >
            {replay.route.length >= 2 && (
              <polyline
                points={replay.route
                  .map((point) => {
                    const { x, y } = project(point);
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .join(" ")}
                fill="none"
                className="stroke-border"
                strokeWidth={2}
                strokeDasharray="6 6"
              />
            )}

            {segments.map((segment, i) => (
              <polyline
                key={i}
                points={segment.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
                fill="none"
                className="stroke-primary"
                strokeWidth={2.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {/* Fence crossings, which is where the automatic events came from */}
            {replay.fences.map((fence) => {
              const nearest = nearestFix(replay, fence.at);
              if (!nearest) return null;
              const { x, y } = project(nearest);
              return (
                <g key={fence.id}>
                  <circle
                    cx={x}
                    cy={y}
                    r={6}
                    className={fence.direction === "ENTER" ? "fill-ok" : "fill-info"}
                    stroke="none"
                  />
                  <title>
                    {`${fence.direction} ${fence.name} · ${new Date(fence.at).toLocaleString()}${
                      fence.dwellMinutes !== null ? ` · dwelt ${fence.dwellMinutes} min` : ""
                    }`}
                  </title>
                </g>
              );
            })}

            {/* Alerts */}
            {replay.alerts
              .filter((alert) => alert.lat !== null && alert.lng !== null)
              .map((alert) => {
                const { x, y } = project({ lat: alert.lat!, lng: alert.lng! });
                return (
                  <g key={alert.id}>
                    <path
                      d="M 0 -8 L 7 5 L -7 5 Z"
                      className="fill-bad"
                      transform={`translate(${x} ${y})`}
                    />
                    <title>{`${alert.kind}: ${alert.summary}`}</title>
                  </g>
                );
              })}

            {/* Scrubber marker */}
            {active && (
              <g>
                {(() => {
                  const { x, y } = project({ lat: active.lat, lng: active.lng });
                  return (
                    <>
                      <circle cx={x} cy={y} r={12} fill="none" className="stroke-primary" strokeWidth={2} />
                      <circle cx={x} cy={y} r={5} className="fill-primary stroke-background" strokeWidth={2} />
                    </>
                  );
                })()}
              </g>
            )}
          </svg>
        </div>

        <div className="border-t px-4 py-3">
          <input
            type="range"
            min={0}
            max={replay.fixes.length - 1}
            value={index}
            onChange={(event) => setIndex(Number(event.target.value))}
            className="w-full accent-primary"
            aria-label="Scrub through the recorded fixes"
          />
          {active && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="tabular">
                {new Date(active.at).toLocaleString()}
              </span>
              <span className="font-mono text-muted-foreground">
                {active.lat.toFixed(5)}, {active.lng.toFixed(5)}
              </span>
              <span className="tabular">
                {active.speedKmph === null ? "no speed" : `${Math.round(active.speedKmph)} km/h`}
              </span>
              <span
                className={cn(
                  "rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider",
                  active.provider === "manual"
                    ? "bg-info-muted text-info"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {active.provider === "manual" ? "manual fix" : (active.provider ?? "device")}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Speed profile */}
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.13em] text-muted-foreground">
            Speed profile
          </span>
          <span className="text-[0.65rem] text-muted-foreground">
            peak {Math.round(maxSpeed)} km/h
          </span>
        </div>
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${PROFILE_WIDTH} ${PROFILE_HEIGHT}`}
            className="h-auto w-full min-w-[640px]"
            role="img"
            aria-label="Speed over the course of the trip"
          >
            {[0.25, 0.5, 0.75].map((fraction) => (
              <line
                key={fraction}
                x1={0}
                x2={PROFILE_WIDTH}
                y1={PROFILE_HEIGHT * fraction}
                y2={PROFILE_HEIGHT * fraction}
                className="stroke-border"
                strokeWidth={0.5}
              />
            ))}

            {replay.fixes.map((fix, i) => {
              if (fix.speedKmph === null) return null;
              const x = ((new Date(fix.at).getTime() - startMs) / spanMs) * PROFILE_WIDTH;
              const height = (fix.speedKmph / maxSpeed) * (PROFILE_HEIGHT - 8);
              const width = Math.max(1, PROFILE_WIDTH / replay.fixes.length);
              return (
                <rect
                  key={i}
                  x={x}
                  y={PROFILE_HEIGHT - height}
                  width={width}
                  height={height}
                  className={
                    i === index
                      ? "fill-primary"
                      : fix.speedKmph < 3
                        ? "fill-warn"
                        : "fill-chart-1"
                  }
                  opacity={i === index ? 1 : 0.8}
                />
              );
            })}

            {/* Silence, marked rather than smoothed over */}
            {replay.fixes.map((fix, i) => {
              if (i === 0) return null;
              const previousMs = new Date(replay.fixes[i - 1].at).getTime();
              const currentMs = new Date(fix.at).getTime();
              if (currentMs - previousMs <= GAP_MINUTES * 60_000) return null;

              const x1 = ((previousMs - startMs) / spanMs) * PROFILE_WIDTH;
              const x2 = ((currentMs - startMs) / spanMs) * PROFILE_WIDTH;
              return (
                <g key={`gap-${i}`}>
                  <rect
                    x={x1}
                    y={0}
                    width={Math.max(2, x2 - x1)}
                    height={PROFILE_HEIGHT}
                    className="fill-bad"
                    opacity={0.12}
                  />
                  <title>
                    {`No fixes for ${Math.round((currentMs - previousMs) / 60_000)} minutes`}
                  </title>
                </g>
              );
            })}
          </svg>
        </div>
        {replay.stats.gapMinutes > 0 && (
          <p className="border-t bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
            {replay.stats.gapMinutes} minutes of this trip have no fixes at all,
            shaded above. The trail is drawn broken across those stretches
            rather than joined — a straight line through a gap is a route the
            vehicle may never have taken.
          </p>
        )}
      </div>
    </div>
  );
}

/** The recorded fix closest in time to a fence crossing. */
function nearestFix(replay: TripReplay, at: string): LatLng | null {
  const target = new Date(at).getTime();
  let best: LatLng | null = null;
  let bestDelta = Infinity;

  for (const fix of replay.fixes) {
    const delta = Math.abs(new Date(fix.at).getTime() - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = { lat: fix.lat, lng: fix.lng };
    }
  }

  return best;
}
