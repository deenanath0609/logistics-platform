import type { Metadata } from "next";
import Link from "next/link";
import { Truck, User } from "lucide-react";
import type { DocumentKind } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import {
  EXPIRY_HORIZON_DAYS,
  daysUntilExpiry,
  expiryUrgency,
  utcDayFromNow,
  type ExpiryUrgency,
} from "@/lib/fleet/availability";
import { DOCUMENT_LABELS } from "@/lib/fleet/documents";
import { formatRegistration } from "@/lib/fleet/registration";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { ExpiryDate, UrgencyPill } from "@/components/fleet/expiry";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Document expiries" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  subjectType: "VEHICLE" | "DRIVER";
  subjectId: string;
  subjectLabel: string;
  subjectHref: string;
  kind: DocumentKind;
  documentNumber: string | null;
  expiresOn: Date;
  daysRemaining: number;
  urgency: ExpiryUrgency;
  isMandatory: boolean;
  branchCode: string | null;
};

function Tile({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "bad" | "warn" | "muted";
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border px-4 py-3 ${
        tone === "bad"
          ? "border-bad/30 bg-bad-muted"
          : tone === "warn"
            ? "border-warn/30 bg-warn-muted"
            : "bg-card"
      }`}
    >
      <span
        className={`font-mono text-[0.65rem] uppercase tracking-wider ${
          tone === "bad"
            ? "text-bad"
            : tone === "warn"
              ? "text-warn"
              : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
      <span
        className={`text-2xl font-semibold tabular ${
          tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : ""
        }`}
      >
        {count}
      </span>
    </div>
  );
}

/**
 * One screen for the renewal desk.
 *
 * Vehicle documents, driver documents and driving licences are three tables
 * in the database and one job in real life, so they are merged here and
 * sorted by the only thing that matters: what lapses first. Anything already
 * expired stays at the top rather than dropping off the list — an overdue
 * fitness certificate does not stop being a problem because its date passed.
 */
export default async function ExpiriesPage() {
  const user = await requirePermission("vehicle.read");
  const seesDrivers = can(user, "driver.read");

  const asOf = new Date();
  const horizon = utcDayFromNow(EXPIRY_HORIZON_DAYS, asOf);

  // Vehicles and drivers are both homed on a branch, so one fragment scopes
  // every query on this page.
  const scope = branchScope(user, "branchId");

  const [vehicleDocuments, driverDocuments, licences] = await Promise.all([
    prisma.vehicleDocument.findMany({
      where: {
        expiresOn: { not: null, lte: horizon },
        vehicle: { deletedAt: null, isActive: true, ...scope },
      },
      orderBy: { expiresOn: "asc" },
      select: {
        id: true,
        kind: true,
        documentNumber: true,
        expiresOn: true,
        isMandatory: true,
        vehicle: {
          select: {
            id: true,
            registrationNumber: true,
            branch: { select: { code: true } },
          },
        },
      },
    }),
    seesDrivers
      ? prisma.driverDocument.findMany({
          where: {
            expiresOn: { not: null, lte: horizon },
            driver: { deletedAt: null, isActive: true, ...scope },
          },
          orderBy: { expiresOn: "asc" },
          select: {
            id: true,
            kind: true,
            documentNumber: true,
            expiresOn: true,
            isMandatory: true,
            driver: {
              select: {
                id: true,
                name: true,
                code: true,
                branch: { select: { code: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
    seesDrivers
      ? prisma.driver.findMany({
          where: {
            deletedAt: null,
            isActive: true,
            ...scope,
            licenceExpiry: { not: null, lte: horizon },
          },
          orderBy: { licenceExpiry: "asc" },
          select: {
            id: true,
            name: true,
            code: true,
            licenceNumber: true,
            licenceExpiry: true,
            branch: { select: { code: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const rows: Row[] = [
    ...vehicleDocuments.map((document) => ({
      id: `vd-${document.id}`,
      subjectType: "VEHICLE" as const,
      subjectId: document.vehicle.id,
      subjectLabel: formatRegistration(document.vehicle.registrationNumber),
      subjectHref: `/fleet/vehicles/${document.vehicle.id}`,
      kind: document.kind,
      documentNumber: document.documentNumber,
      expiresOn: document.expiresOn as Date,
      daysRemaining: daysUntilExpiry(document.expiresOn as Date, asOf),
      urgency: expiryUrgency(daysUntilExpiry(document.expiresOn as Date, asOf)),
      isMandatory: document.isMandatory,
      branchCode: document.vehicle.branch?.code ?? null,
    })),
    ...driverDocuments.map((document) => ({
      id: `dd-${document.id}`,
      subjectType: "DRIVER" as const,
      subjectId: document.driver.id,
      subjectLabel: document.driver.name,
      subjectHref: `/fleet/drivers/${document.driver.id}`,
      kind: document.kind,
      documentNumber: document.documentNumber,
      expiresOn: document.expiresOn as Date,
      daysRemaining: daysUntilExpiry(document.expiresOn as Date, asOf),
      urgency: expiryUrgency(daysUntilExpiry(document.expiresOn as Date, asOf)),
      isMandatory: document.isMandatory,
      branchCode: document.driver.branch?.code ?? null,
    })),
    // The licence lives on the driver row rather than in the document table,
    // so it has to be folded in by hand — and it is the single most
    // important date on this screen.
    ...licences.map((driver) => ({
      id: `dl-${driver.id}`,
      subjectType: "DRIVER" as const,
      subjectId: driver.id,
      subjectLabel: driver.name,
      subjectHref: `/fleet/drivers/${driver.id}`,
      kind: "DRIVING_LICENCE" as DocumentKind,
      documentNumber: driver.licenceNumber,
      expiresOn: driver.licenceExpiry as Date,
      daysRemaining: daysUntilExpiry(driver.licenceExpiry as Date, asOf),
      urgency: expiryUrgency(daysUntilExpiry(driver.licenceExpiry as Date, asOf)),
      isMandatory: true,
      branchCode: driver.branch?.code ?? null,
    })),
  ].sort((a, b) => a.daysRemaining - b.daysRemaining);

  const expired = rows.filter((row) => row.urgency === "EXPIRED").length;
  const critical = rows.filter((row) => row.urgency === "CRITICAL").length;
  const warning = rows.filter((row) => row.urgency === "WARNING").length;
  const later = rows.filter((row) => row.urgency === "OK").length;

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Document expiries"
        description={`Everything on ${
          seesDrivers ? "vehicles and drivers" : "vehicles"
        } that has lapsed or lapses within ${EXPIRY_HORIZON_DAYS} days, soonest first.`}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Expired" count={expired} tone="bad" />
        <Tile label="Within 7 days" count={critical} tone="warn" />
        <Tile label="8 to 30 days" count={warning} tone="warn" />
        <Tile label="31 to 60 days" count={later} tone="muted" />
      </div>

      <TableFrame>
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing expires in the next 60 days"
            description="Either the fleet is fully in date, or documents have not been recorded against it yet."
          />
        ) : (
          <Table className="min-w-[940px]">
            <TableHeader>
              <TableRow>
                <TableHead>Expires</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Vehicle or driver</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Effect</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <ExpiryDate
                      expiresOn={row.expiresOn}
                      daysRemaining={row.daysRemaining}
                    />
                  </TableCell>
                  <TableCell>
                    <UrgencyPill daysRemaining={row.daysRemaining} />
                  </TableCell>
                  <TableCell>
                    <Link
                      href={row.subjectHref}
                      className="flex items-center gap-1.5 font-medium hover:underline"
                    >
                      {row.subjectType === "VEHICLE" ? (
                        <Truck className="size-3.5 text-muted-foreground" />
                      ) : (
                        <User className="size-3.5 text-muted-foreground" />
                      )}
                      <span
                        className={
                          row.subjectType === "VEHICLE"
                            ? "font-mono text-xs"
                            : undefined
                        }
                      >
                        {row.subjectLabel}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">
                    {DOCUMENT_LABELS[row.kind]}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.documentNumber ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.branchCode ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.isMandatory ? (
                      row.urgency === "EXPIRED" ? (
                        <span className="font-medium text-bad">
                          Blocks assignment now
                        </span>
                      ) : (
                        <span className="text-warn">Will block on expiry</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">Warning only</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableFrame>
    </>
  );
}
