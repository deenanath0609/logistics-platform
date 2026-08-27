import type { Metadata } from "next";
import Link from "next/link";
import { format, subDays } from "date-fns";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GeofenceDialog } from "@/components/tracking/geofence-form";

export const metadata: Metadata = { title: "Geofences" };
export const dynamic = "force-dynamic";

/** How far back the "is this fence actually working?" count looks. */
const ACTIVITY_DAYS = 7;

/**
 * The fences that turn vehicle movement into consignment events.
 *
 * The column that matters most is the last one: crossings in the past week.
 * A fence with none is either around a node nothing visits or — far more
 * likely — drawn too small for the yard, and it will sit there generating
 * nothing while a branch wonders why arrivals still have to be typed.
 * Making that visible is the difference between a feature that was shipped
 * and a feature that works.
 */
export default async function GeofencesPage() {
  const user = await requirePermission("geofence.manage");
  const since = subDays(new Date(), ACTIVITY_DAYS);

  const [fences, branches, crossings] = await Promise.all([
    prisma.geofence.findMany({
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        type: true,
        branchId: true,
        centerLat: true,
        centerLng: true,
        radiusMeters: true,
        debouncePings: true,
        isActive: true,
        updatedAt: true,
        branch: { select: { code: true, name: true, type: true } },
      },
    }),
    prisma.branch.findMany({
      where: { orgId: user.orgId, deletedAt: null, isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, latitude: true, longitude: true },
    }),
    prisma.geofenceEvent.groupBy({
      by: ["geofenceId"],
      where: { occurredAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const crossingsByFence = new Map(
    crossings.map((row) => [row.geofenceId, row._count._all]),
  );

  const silent = fences.filter(
    (fence) => fence.isActive && !crossingsByFence.has(fence.id),
  ).length;

  return (
    <>
      <PageHeader
        eyebrow="Tracking"
        title="Geofences"
        description="A circle around each node. A vehicle entering one writes an arrival on every consignment it is carrying — the single highest-value automation in the system, and the one that quietly stops working if a fence is drawn too small."
        actions={
          <>
            <Button variant="outline" render={<Link href="/tracking" />}>
              Live map
            </Button>
            <GeofenceDialog
              branches={branches.map((branch) => ({
                id: branch.id,
                code: branch.code,
                name: branch.name,
                hasCoordinates: branch.latitude != null && branch.longitude != null,
              }))}
            />
          </>
        }
      />

      {silent > 0 && (
        <p className="mb-4 rounded-lg border border-warn/40 bg-warn-muted/40 px-4 py-2.5 text-sm text-warn">
          {silent} active fence{silent === 1 ? " has" : "s have"} recorded no
          crossing in {ACTIVITY_DAYS} days. That is normal for a node nothing
          visits, and a symptom of a radius drawn on the gate rather than
          around the yard everywhere else.
        </p>
      )}

      <TableFrame>
        {fences.length === 0 ? (
          <EmptyState
            title="No geofences"
            description="Without a fence, nothing generates an automatic arrival and every status change has to be typed. One circle per hub is the place to start."
          />
        ) : (
          <Table className="min-w-[880px]">
            <TableHeader>
              <TableRow>
                <TableHead>Fence</TableHead>
                <TableHead>Node</TableHead>
                <TableHead>Shape</TableHead>
                <TableHead>Debounce</TableHead>
                <TableHead>Crossings · {ACTIVITY_DAYS}d</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fences.map((fence) => {
                const count = crossingsByFence.get(fence.id) ?? 0;
                const misconfigured =
                  fence.type === "CIRCLE" &&
                  (fence.centerLat == null || fence.radiusMeters == null);

                return (
                  <TableRow key={fence.id}>
                    <TableCell>
                      <span className="text-xs font-medium">{fence.name}</span>
                      {misconfigured && (
                        <span className="ml-2 rounded-sm bg-bad-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-bad">
                          no geometry
                        </span>
                      )}
                      <span className="block font-mono text-[0.6rem] text-muted-foreground">
                        edited {format(fence.updatedAt, "dd MMM")}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {fence.branch ? (
                        <>
                          <span className="font-mono">{fence.branch.code}</span>
                          <span className="ml-2 text-muted-foreground">
                            {fence.branch.name}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          not one of ours — no arrivals
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {fence.type === "CIRCLE"
                        ? `circle · ${fence.radiusMeters ?? "?"} m`
                        : "polygon"}
                    </TableCell>
                    <TableCell className="text-xs tabular">
                      {fence.debouncePings} ping{fence.debouncePings === 1 ? "" : "s"}
                    </TableCell>
                    <TableCell className="text-xs tabular">
                      {count === 0 && fence.isActive ? (
                        <span className="text-warn">none</span>
                      ) : (
                        count
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${
                          fence.isActive
                            ? "bg-ok-muted text-ok"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {fence.isActive ? "Active" : "Off"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {fence.type === "CIRCLE" ? (
                        <GeofenceDialog
                          fence={{
                            id: fence.id,
                            name: fence.name,
                            branchId: fence.branchId,
                            radiusMeters: fence.radiusMeters,
                            debouncePings: fence.debouncePings,
                            isActive: fence.isActive,
                          }}
                          branches={branches.map((branch) => ({
                            id: branch.id,
                            code: branch.code,
                            name: branch.name,
                            hasCoordinates:
                              branch.latitude != null && branch.longitude != null,
                          }))}
                        />
                      ) : (
                        <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                          edit as GeoJSON
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <p className="mt-4 max-w-prose text-xs text-muted-foreground">
        Polygon fences are evaluated — a ray-cast test that handles concave
        shapes correctly — but are not drawn here; they are written as GeoJSON
        rings and are the right shape for a delivery zone or a large customer
        site rather than a yard. Circles are exact, cheap, and what every node
        on the network wants.
      </p>
    </>
  );
}
