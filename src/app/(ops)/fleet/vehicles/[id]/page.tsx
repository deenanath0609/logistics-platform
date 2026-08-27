import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope, coversBranch } from "@/server/repositories/scope";
import {
  canAssignVehicle,
  daysUntilExpiry,
  documentHealth,
} from "@/lib/fleet/availability";
import {
  DOCUMENT_LABELS,
  VEHICLE_DOCUMENT_KINDS,
} from "@/lib/fleet/documents";
import { formatRegistration } from "@/lib/fleet/registration";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { MasterFormDialog } from "@/components/data/master-form";
import { ToggleActive } from "@/components/data/toggle-active";
import {
  AssignabilityNotice,
  ExpiryDate,
  toDateInputValue,
} from "@/components/fleet/expiry";
import {
  DocumentFormDialog,
  DeleteDocumentButton,
} from "@/components/fleet/document-form";
import { VehicleStatusPill } from "@/components/fleet/status-pill";
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
import { buildVehicleFields } from "../page";
import {
  updateVehicle,
  setVehicleActive,
  saveVehicleDocument,
  deleteVehicleDocument,
} from "../actions";

export const metadata: Metadata = { title: "Vehicle" };
export const dynamic = "force-dynamic";

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("vehicle.read");
  const writable = can(user, "vehicle.update");
  const canWithdraw = can(user, "vehicle.delete");
  const { id } = await params;

  const vehicle = await prisma.vehicle.findUnique({
    where: { id },
    include: {
      vehicleType: true,
      branch: { select: { id: true, code: true, name: true } },
      documents: { orderBy: [{ expiresOn: "asc" }, { kind: "asc" }] },
      statusLog: { orderBy: { createdAt: "desc" }, take: 8 },
    },
  });

  if (!vehicle || vehicle.deletedAt) notFound();
  if (vehicle.branchId && !coversBranch(user, vehicle.branchId)) notFound();

  const [types, branches] = await Promise.all([
    prisma.vehicleType.findMany({
      where: { OR: [{ isActive: true }, { id: vehicle.vehicleTypeId }] },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: { id: true, code: true, name: true },
    }),
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null, ...branchScope(user, "id") },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const asOf = new Date();
  const health = documentHealth(vehicle.documents, asOf);
  const assignable = canAssignVehicle(vehicle, vehicle.documents, asOf);
  const registration = formatRegistration(vehicle.registrationNumber);

  const fields = buildVehicleFields(
    types.map((type) => ({ value: type.id, label: `${type.code} — ${type.name}` })),
    branches.map((branch) => ({
      value: branch.id,
      label: `${branch.code} — ${branch.name}`,
    })),
    vehicle.status,
  );

  // Which of the documents a vehicle ought to carry are simply not on file.
  // An absent document is not an expired one, but it is still a gap the
  // transport desk should be able to see without cross-referencing a folder.
  const recorded = new Set(vehicle.documents.map((document) => document.kind));
  const missing = VEHICLE_DOCUMENT_KINDS.filter(
    (kind) => kind !== "OTHER" && !recorded.has(kind),
  );

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="mb-2 -ml-2 text-muted-foreground"
        render={<Link href="/fleet/vehicles" />}
      >
        <ChevronLeft />
        All vehicles
      </Button>

      <PageHeader
        eyebrow={vehicle.vehicleType.name}
        title={registration}
        description={
          [vehicle.make, vehicle.model, vehicle.manufactureYear]
            .filter(Boolean)
            .join(" ") || undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <VehicleStatusPill status={vehicle.status} />
            {writable && (
              <MasterFormDialog
                title={`Edit ${registration}`}
                fields={fields}
                action={updateVehicle}
                record={vehicle as unknown as Record<string, unknown>}
                submitLabel="Save changes"
                trigger={{ label: "Edit", icon: "pencil", variant: "outline" }}
              />
            )}
            {canWithdraw && (
              <ToggleActive
                id={vehicle.id}
                isActive={vehicle.isActive}
                label={registration}
                action={setVehicleActive}
              />
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-6">
        <AssignabilityNotice result={assignable} subject="This vehicle" />

        <div className="grid gap-x-6 gap-y-4 rounded-lg border bg-card px-4 py-4 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Type">
            <span className="font-mono text-xs">{vehicle.vehicleType.code}</span>
            <span className="ml-2 text-muted-foreground">
              {vehicle.vehicleType.name}
            </span>
          </Fact>
          <Fact label="Payload">
            <span className="tabular">
              {Number(vehicle.vehicleType.capacityKg).toLocaleString("en-IN")} kg
            </span>
            {vehicle.vehicleType.capacityCft && (
              <span className="ml-2 text-muted-foreground tabular">
                {Number(vehicle.vehicleType.capacityCft).toLocaleString("en-IN")}{" "}
                cft
              </span>
            )}
          </Fact>
          <Fact label="Ownership">
            {vehicle.ownership === "OWN"
              ? "Own"
              : vehicle.ownership === "VENDOR"
                ? "Vendor"
                : "Attached"}
          </Fact>
          <Fact label="Home branch">
            {vehicle.branch ? (
              <>
                <span className="font-mono text-xs">{vehicle.branch.code}</span>
                <span className="ml-2 text-muted-foreground">
                  {vehicle.branch.name}
                </span>
              </>
            ) : (
              <span className="text-warn">unassigned</span>
            )}
          </Fact>
          <Fact label="Odometer">
            {vehicle.currentOdometerKm !== null ? (
              <span className="tabular">
                {vehicle.currentOdometerKm.toLocaleString("en-IN")} km
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
          <Fact label="GPS device">
            {vehicle.gpsDeviceId ? (
              <span className="font-mono text-xs">{vehicle.gpsDeviceId}</span>
            ) : (
              <span
                className="text-xs text-warn"
                title="No telematics — arrivals and departures must be recorded by hand"
              >
                none
              </span>
            )}
          </Fact>
          <Fact label="FASTag">
            {vehicle.fastagId ? (
              <span className="font-mono text-xs">{vehicle.fastagId}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
          <Fact label="In the fleet">
            <Badge variant={vehicle.isActive ? "secondary" : "outline"}>
              {vehicle.isActive ? "Active" : "Withdrawn"}
            </Badge>
          </Fact>
          {vehicle.notes && (
            <div className="sm:col-span-3 lg:col-span-4">
              <Fact label="Notes">
                <span className="text-muted-foreground">{vehicle.notes}</span>
              </Fact>
            </div>
          )}
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-lg font-semibold tracking-tight">Documents</h2>
              <p className="text-sm text-muted-foreground">
                A mandatory document that has lapsed takes this vehicle out of
                the assignable pool until it is renewed.
              </p>
            </div>
            {writable && (
              <DocumentFormDialog
                mode="create"
                subjectField="vehicleId"
                subjectId={vehicle.id}
                subjectLabel={registration}
                kinds={VEHICLE_DOCUMENT_KINDS}
                action={saveVehicleDocument}
                showNotes
              />
            )}
          </div>

          {missing.length > 0 && (
            <p className="rounded-md border border-warn/40 bg-warn-muted px-3 py-2 text-sm text-warn">
              Not on file:{" "}
              {missing.map((kind) => DOCUMENT_LABELS[kind]).join(", ")}.
            </p>
          )}

          <TableFrame>
            {vehicle.documents.length === 0 ? (
              <EmptyState
                title="No documents recorded"
                description="Add the RC, insurance and fitness certificate so expiry alerts have something to work from."
              />
            ) : (
              <Table className="min-w-[760px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Blocks assignment</TableHead>
                    {writable && (
                      <TableHead className="w-24 text-right">Actions</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vehicle.documents.map((document) => (
                    <TableRow key={document.id}>
                      <TableCell className="font-medium">
                        {DOCUMENT_LABELS[document.kind]}
                        {document.notes && (
                          <span className="block text-xs text-muted-foreground">
                            {document.notes}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {document.documentNumber ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {document.issuedOn
                          ? toDateInputValue(document.issuedOn)
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <ExpiryDate
                          expiresOn={document.expiresOn}
                          daysRemaining={
                            document.expiresOn
                              ? daysUntilExpiry(document.expiresOn, asOf)
                              : undefined
                          }
                        />
                      </TableCell>
                      <TableCell>
                        {document.isMandatory ? (
                          <span className="text-xs">Yes</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            warns only
                          </span>
                        )}
                      </TableCell>
                      {writable && (
                        <TableCell>
                          <div className="flex items-center justify-end gap-0.5">
                            <DocumentFormDialog
                              mode="edit"
                              subjectField="vehicleId"
                              subjectId={vehicle.id}
                              subjectLabel={registration}
                              kinds={VEHICLE_DOCUMENT_KINDS}
                              action={saveVehicleDocument}
                              showNotes
                              document={{
                                id: document.id,
                                kind: document.kind,
                                documentNumber: document.documentNumber,
                                issuedOn: toDateInputValue(document.issuedOn),
                                expiresOn: toDateInputValue(document.expiresOn),
                                isMandatory: document.isMandatory,
                                notes: document.notes,
                              }}
                            />
                            <DeleteDocumentButton
                              documentId={document.id}
                              subjectField="vehicleId"
                              subjectId={vehicle.id}
                              label={DOCUMENT_LABELS[document.kind]}
                              action={deleteVehicleDocument}
                            />
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableFrame>

          {health.expiringSoon.length > 0 && (
            <p className="text-sm text-warn">
              {health.expiringSoon.length === 1
                ? "One document expires"
                : `${health.expiringSoon.length} documents expire`}{" "}
              within the next 30 days.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-lg font-semibold tracking-tight">
              Recent status changes
            </h2>
            <p className="text-sm text-muted-foreground">
              Written by trip events, not by this screen.
            </p>
          </div>

          <TableFrame>
            {vehicle.statusLog.length === 0 ? (
              <EmptyState
                title="No status history yet"
                description="Entries appear here once the vehicle is put on a trip."
              />
            ) : (
              <Table className="min-w-[600px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Remarks</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vehicle.statusLog.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDistanceToNow(entry.createdAt, { addSuffix: true })}
                      </TableCell>
                      <TableCell>
                        {entry.fromStatus ? (
                          <VehicleStatusPill status={entry.fromStatus} />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <VehicleStatusPill status={entry.toStatus} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {entry.remarks ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableFrame>
        </section>
      </div>
    </>
  );
}
