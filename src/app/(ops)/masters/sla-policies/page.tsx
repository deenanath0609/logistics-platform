import type { Metadata } from "next";
import Link from "next/link";
import { BellRing } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import { ToggleActive } from "@/components/data/toggle-active";
import { LaneTester } from "@/components/exceptions/lane-tester";
import { RecomputeSla } from "@/components/exceptions/recompute-sla";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { IST_OFFSET_MINUTES, policySpecificity } from "@/lib/sla/policy";
import {
  createSlaPolicy,
  updateSlaPolicy,
  setSlaPolicyActive,
  testLane,
  recomputeSla,
} from "./actions";

export const metadata: Metadata = { title: "SLA policies" };
export const dynamic = "force-dynamic";

/**
 * The SLA policy master — docs/BRD.html §A.11.
 *
 * Without a row in this table the scanner returns NOT_APPLICABLE for
 * every shipment and every on-time figure in the product reads "no data".
 * The engine has been complete for a while; this is the screen that turns
 * it on.
 *
 * The list is sorted narrowest-first and carries a specificity column,
 * because the question this screen has to answer is never "what policies
 * exist" — it is "which of these twelve wins for the lane in front of
 * me". The tester answers it exactly; the ordering and the column let
 * somebody answer it themselves.
 */

/** How resolution scores a policy, spelled out for the reader. */
function scopeLabel(specificity: number): { label: string; tone: string } {
  if (specificity >= 40) return { label: "City pair", tone: "bg-ok-muted text-ok" };
  if (specificity >= 20)
    return { label: "One city", tone: "bg-info-muted text-info" };
  if (specificity >= 10)
    return { label: "Zone", tone: "bg-warn-muted text-warn" };
  return { label: "Network", tone: "bg-muted text-muted-foreground" };
}

/** "YYYY-MM-DDTHH:mm" for now in IST — the tester's default booking time. */
function nowInIst(): string {
  const shifted = new Date(Date.now() + IST_OFFSET_MINUTES * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

export default async function SlaPoliciesPage() {
  const user = await requirePermission("master.read");
  const writable = can(user, "sla.manage");

  const [policies, serviceTypes, cities, zones, branches] = await Promise.all([
    prisma.slaPolicy.findMany({
      where: { orgId: user.orgId },
      orderBy: [{ priority: "desc" }, { code: "asc" }],
    }),
    prisma.serviceType.findMany({
      where: { isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.zone.findMany({
      where: { isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.branch.findMany({
      where: { orgId: user.orgId, isActive: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  // SlaPolicy stores bare ids — the schema deliberately carries no
  // relations, so the lookup happens here rather than in twelve joins.
  const serviceName = new Map(serviceTypes.map((row) => [row.id, row.code]));
  const cityName = new Map(cities.map((row) => [row.id, row.code]));
  const zoneName = new Map(zones.map((row) => [row.id, row.code]));

  const FIELDS: FieldDef[] = [
    {
      type: "text",
      name: "code",
      label: "Code",
      required: true,
      half: true,
      mono: true,
      placeholder: "SLA-DEL-JAI-EXP",
    },
    {
      type: "number",
      name: "transitHours",
      label: "Transit hours",
      required: true,
      half: true,
      help: "The promise itself.",
    },
    {
      type: "text",
      name: "name",
      label: "Name",
      required: true,
      placeholder: "Delhi → Jaipur express",
    },
    {
      type: "select",
      name: "serviceTypeId",
      label: "Service type",
      half: true,
      placeholder: "Any service",
      options: serviceTypes.map((row) => ({
        value: row.id,
        label: `${row.code} — ${row.name}`,
      })),
    },
    {
      type: "number",
      name: "priority",
      label: "Priority",
      half: true,
      help: "Beats specificity outright. Leave at 0 unless overriding.",
    },
    {
      type: "select",
      name: "originCityId",
      label: "Origin city",
      half: true,
      placeholder: "Any origin",
      options: cities.map((row) => ({
        value: row.id,
        label: `${row.code} — ${row.name}`,
      })),
    },
    {
      type: "select",
      name: "destinationCityId",
      label: "Destination city",
      half: true,
      placeholder: "Any destination",
      options: cities.map((row) => ({
        value: row.id,
        label: `${row.code} — ${row.name}`,
      })),
    },
    {
      type: "select",
      name: "originZoneId",
      label: "Origin zone",
      half: true,
      placeholder: "Any origin zone",
      help: "Ignored when an origin city is set.",
      options: zones.map((row) => ({
        value: row.id,
        label: `${row.code} — ${row.name}`,
      })),
    },
    {
      type: "select",
      name: "destinationZoneId",
      label: "Destination zone",
      half: true,
      placeholder: "Any destination zone",
      help: "Ignored when a destination city is set.",
      options: zones.map((row) => ({
        value: row.id,
        label: `${row.code} — ${row.name}`,
      })),
    },
    {
      type: "number",
      name: "atRiskPercent",
      label: "At risk at (%)",
      half: true,
      help: "80 means flagged once four-fifths of the transit is gone.",
    },
    {
      type: "switch",
      name: "useWorkingHours",
      label: "Run the clock on working hours",
      help: "Off for full-truck lanes, where the vehicle drives overnight.",
    },
    {
      type: "switch",
      name: "respectCutoff",
      label: "Respect the branch cut-off",
      help: "A booking after cut-off starts next working morning.",
    },
    { type: "switch", name: "isActive", label: "Active" },
  ];

  // Narrowest first: that is resolution order, and a list sorted any other
  // way makes the reader reconstruct it in their head.
  const rows = [...policies].sort(
    (a, b) =>
      b.priority - a.priority ||
      policySpecificity(b) - policySpecificity(a) ||
      a.code.localeCompare(b.code),
  );

  const activeCount = rows.filter((row) => row.isActive).length;

  return (
    <>
      <PageHeader
        eyebrow="Masters"
        title="SLA policies"
        description="What the network promises, per service and lane. A lane with no policy is measured as “No SLA” rather than assumed to be 24 hours — an invented commitment produces breach figures a branch manager will rightly refuse."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              render={<Link href="/masters/sla-policies/escalations" />}
            >
              <BellRing />
              Escalation rules
            </Button>
            {writable && <RecomputeSla action={recomputeSla} />}
            {writable && (
              <MasterFormDialog
                title="New SLA policy"
                description="Leave a side blank for “anywhere”. A city beats a zone on the same side, and both beat a service-wide default."
                fields={FIELDS}
                action={createSlaPolicy}
                submitLabel="Create"
                trigger={{ label: "New policy", icon: "plus" }}
              />
            )}
          </div>
        }
      />

      <div className="mb-6">
        <LaneTester
          action={testLane}
          defaultBookedAt={nowInIst()}
          serviceTypes={serviceTypes.map((row) => ({
            value: row.id,
            label: `${row.code} — ${row.name}`,
          }))}
          cities={cities.map((row) => ({
            value: row.id,
            label: `${row.code} — ${row.name}`,
          }))}
          branches={branches.map((row) => ({
            value: row.id,
            label: `${row.code} — ${row.name}`,
          }))}
        />
      </div>

      {rows.length === 0 ? (
        <TableFrame>
          <EmptyState
            title="No SLA policy exists yet"
            description="Until one does, the scanner marks every shipment “No SLA” and the on-time reports have nothing to measure. Start with a service-wide default — it makes every lane measurable — then narrow it with the lanes that need their own promise."
          />
        </TableFrame>
      ) : (
        <>
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              Narrowest first — this is resolution order
            </h2>
            <span className="text-xs text-muted-foreground tabular">
              {activeCount} active of {rows.length}
            </span>
          </div>

          <TableFrame>
            <Table className="min-w-[1000px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Origin</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead className="text-right">Transit</TableHead>
                  <TableHead className="text-right">At risk</TableHead>
                  <TableHead>Clock</TableHead>
                  <TableHead className="text-right">Spec / Pri</TableHead>
                  <TableHead>Status</TableHead>
                  {writable && (
                    <TableHead className="w-24 text-right">Actions</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const specificity = policySpecificity(row);
                  const scope = scopeLabel(specificity);

                  return (
                    <TableRow
                      key={row.id}
                      className={row.isActive ? "" : "opacity-55"}
                    >
                      <TableCell className="font-mono text-xs font-medium">
                        {row.code}
                        <span className="block text-[0.65rem] font-normal text-muted-foreground">
                          {row.name}
                        </span>
                      </TableCell>

                      <TableCell>
                        <span
                          className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${scope.tone}`}
                        >
                          {scope.label}
                        </span>
                      </TableCell>

                      <TableCell className="font-mono text-xs">
                        {row.serviceTypeId
                          ? (serviceName.get(row.serviceTypeId) ?? "—")
                          : (
                            <span className="text-muted-foreground">Any</span>
                          )}
                      </TableCell>

                      <TableCell className="font-mono text-xs">
                        <Side
                          cityCode={
                            row.originCityId
                              ? cityName.get(row.originCityId)
                              : undefined
                          }
                          zoneCode={
                            row.originZoneId
                              ? zoneName.get(row.originZoneId)
                              : undefined
                          }
                        />
                      </TableCell>

                      <TableCell className="font-mono text-xs">
                        <Side
                          cityCode={
                            row.destinationCityId
                              ? cityName.get(row.destinationCityId)
                              : undefined
                          }
                          zoneCode={
                            row.destinationZoneId
                              ? zoneName.get(row.destinationZoneId)
                              : undefined
                          }
                        />
                      </TableCell>

                      <TableCell className="text-right font-mono text-xs tabular">
                        {row.transitHours} h
                      </TableCell>

                      <TableCell className="text-right font-mono text-xs tabular">
                        {row.atRiskPercent}%
                      </TableCell>

                      <TableCell className="text-xs text-muted-foreground">
                        {row.useWorkingHours ? "Working hours" : "Wall clock"}
                        {row.respectCutoff && (
                          <span className="block">Cut-off applies</span>
                        )}
                      </TableCell>

                      <TableCell className="text-right font-mono text-xs tabular">
                        {specificity}
                        <span className="text-muted-foreground"> / </span>
                        {row.priority}
                      </TableCell>

                      <TableCell>
                        <Badge variant={row.isActive ? "secondary" : "outline"}>
                          {row.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>

                      {writable && (
                        <TableCell>
                          <div className="flex items-center justify-end gap-0.5">
                            <MasterFormDialog
                              title={`Edit ${row.code}`}
                              fields={FIELDS}
                              action={updateSlaPolicy}
                              record={row as unknown as Record<string, unknown>}
                              trigger={{
                                label: `Edit ${row.code}`,
                                icon: "pencil",
                                variant: "ghost",
                                size: "icon-sm",
                                iconOnly: true,
                              }}
                            />
                            <ToggleActive
                              id={row.id}
                              isActive={row.isActive}
                              label={row.code}
                              action={setSlaPolicyActive}
                            />
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableFrame>
        </>
      )}
    </>
  );
}

/** One side of a lane. A city beats a zone; blank means anywhere. */
function Side({
  cityCode,
  zoneCode,
}: {
  cityCode?: string;
  zoneCode?: string;
}) {
  if (cityCode) return <>{cityCode}</>;
  if (zoneCode) {
    return (
      <span title="Zone — beaten by any policy naming the city">{zoneCode}</span>
    );
  }
  return <span className="text-muted-foreground">Anywhere</span>;
}
