import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Phone } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope, coversBranch } from "@/server/repositories/scope";
import { canAssignDriver, daysUntilExpiry } from "@/lib/fleet/availability";
import { DOCUMENT_LABELS, DRIVER_DOCUMENT_KINDS } from "@/lib/fleet/documents";
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
import { DriverStatusPill } from "@/components/fleet/status-pill";
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
import { buildDriverFields } from "../page";
import {
  updateDriver,
  setDriverActive,
  saveDriverDocument,
  deleteDriverDocument,
} from "../actions";

export const metadata: Metadata = { title: "Driver" };
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

export default async function DriverDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("driver.read");
  const writable = can(user, "driver.update");
  const canDeactivate = can(user, "driver.delete");
  const { id } = await params;

  const driver = await prisma.driver.findUnique({
    where: { id },
    include: {
      branch: { select: { id: true, code: true, name: true } },
      documents: { orderBy: [{ expiresOn: "asc" }, { kind: "asc" }] },
    },
  });

  if (!driver || driver.deletedAt) notFound();
  if (driver.branchId && !coversBranch(user, driver.branchId)) notFound();

  const branches = await prisma.branch.findMany({
    where: { isActive: true, deletedAt: null, ...branchScope(user, "id") },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });

  const asOf = new Date();
  const assignable = canAssignDriver(driver, asOf);

  const fields = buildDriverFields(
    branches.map((branch) => ({
      value: branch.id,
      label: `${branch.code} — ${branch.name}`,
    })),
    driver.status,
  );

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="mb-2 -ml-2 text-muted-foreground"
        render={<Link href="/fleet/drivers" />}
      >
        <ChevronLeft />
        All drivers
      </Button>

      <PageHeader
        eyebrow={`Driver ${driver.code}`}
        title={driver.name}
        description={
          driver.licenceClass
            ? `Licence class ${driver.licenceClass}`
            : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <DriverStatusPill status={driver.status} />
            {writable && (
              <MasterFormDialog
                title={`Edit ${driver.name}`}
                fields={fields}
                action={updateDriver}
                record={driver as unknown as Record<string, unknown>}
                submitLabel="Save changes"
                trigger={{ label: "Edit", icon: "pencil", variant: "outline" }}
              />
            )}
            {canDeactivate && (
              <ToggleActive
                id={driver.id}
                isActive={driver.isActive}
                label={driver.name}
                action={setDriverActive}
              />
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-6">
        <AssignabilityNotice result={assignable} subject={driver.name} />

        <div className="grid gap-x-6 gap-y-4 rounded-lg border bg-card px-4 py-4 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Mobile">
            <span className="flex items-center gap-1.5 font-mono text-xs">
              <Phone className="size-3.5 text-muted-foreground" />
              {driver.mobile}
            </span>
          </Fact>
          <Fact label="Alternate">
            {driver.altMobile ? (
              <span className="font-mono text-xs">{driver.altMobile}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
          <Fact label="Licence">
            {driver.licenceNumber ? (
              <span className="font-mono text-xs">{driver.licenceNumber}</span>
            ) : (
              <span className="text-bad">not on record</span>
            )}
          </Fact>
          <Fact label="Licence expiry">
            <ExpiryDate
              expiresOn={driver.licenceExpiry}
              daysRemaining={
                driver.licenceExpiry
                  ? daysUntilExpiry(driver.licenceExpiry, asOf)
                  : undefined
              }
            />
          </Fact>
          <Fact label="Home branch">
            {driver.branch ? (
              <>
                <span className="font-mono text-xs">{driver.branch.code}</span>
                <span className="ml-2 text-muted-foreground">
                  {driver.branch.name}
                </span>
              </>
            ) : (
              <span className="text-warn">unassigned</span>
            )}
          </Fact>
          <Fact label="Blood group">
            {driver.bloodGroup ?? (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
          <Fact label="Emergency contact">
            {driver.emergencyContactName ? (
              <>
                {driver.emergencyContactName}
                {driver.emergencyContactPhone && (
                  <span className="ml-2 font-mono text-xs">
                    {driver.emergencyContactPhone}
                  </span>
                )}
              </>
            ) : (
              <span
                className="text-warn"
                title="Nobody to call if this driver has an accident on the road"
              >
                none recorded
              </span>
            )}
          </Fact>
          <Fact label="On the roll">
            <Badge variant={driver.isActive ? "secondary" : "outline"}>
              {driver.isActive ? "Active" : "Inactive"}
            </Badge>
          </Fact>
          {driver.address && (
            <div className="sm:col-span-3 lg:col-span-4">
              <Fact label="Address">
                <span className="text-muted-foreground">{driver.address}</span>
              </Fact>
            </div>
          )}
          {driver.notes && (
            <div className="sm:col-span-3 lg:col-span-4">
              <Fact label="Notes">
                <span className="text-muted-foreground">{driver.notes}</span>
              </Fact>
            </div>
          )}
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-lg font-semibold tracking-tight">Documents</h2>
              <p className="text-sm text-muted-foreground">
                The licence expiry on the record above is what blocks
                assignment. Documents here are the supporting file — ID proof,
                address proof, police verification.
              </p>
            </div>
            {writable && (
              <DocumentFormDialog
                mode="create"
                subjectField="driverId"
                subjectId={driver.id}
                subjectLabel={driver.name}
                kinds={DRIVER_DOCUMENT_KINDS}
                action={saveDriverDocument}
              />
            )}
          </div>

          <TableFrame>
            {driver.documents.length === 0 ? (
              <EmptyState
                title="No documents on file"
                description="Add the licence copy, ID proof and police verification."
              />
            ) : (
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Mandatory</TableHead>
                    {writable && (
                      <TableHead className="w-24 text-right">Actions</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {driver.documents.map((document) => (
                    <TableRow key={document.id}>
                      <TableCell className="font-medium">
                        {DOCUMENT_LABELS[document.kind]}
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
                              subjectField="driverId"
                              subjectId={driver.id}
                              subjectLabel={driver.name}
                              kinds={DRIVER_DOCUMENT_KINDS}
                              action={saveDriverDocument}
                              document={{
                                id: document.id,
                                kind: document.kind,
                                documentNumber: document.documentNumber,
                                issuedOn: toDateInputValue(document.issuedOn),
                                expiresOn: toDateInputValue(document.expiresOn),
                                isMandatory: document.isMandatory,
                              }}
                            />
                            <DeleteDocumentButton
                              documentId={document.id}
                              subjectField="driverId"
                              subjectId={driver.id}
                              label={DOCUMENT_LABELS[document.kind]}
                              action={deleteDriverDocument}
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
        </section>
      </div>
    </>
  );
}
