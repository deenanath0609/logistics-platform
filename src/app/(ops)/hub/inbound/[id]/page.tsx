import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ReceiptConsole, type ReceiptLine } from "./receipt-console";
import { ResolveDiscrepancyButton } from "./resolve-discrepancy";

export const metadata: Metadata = { title: "Inbound receipt" };
export const dynamic = "force-dynamic";

const KIND_TONE: Record<string, string> = {
  SHORT: "bg-bad-muted text-bad",
  EXCESS: "bg-warn-muted text-warn",
  DAMAGED: "bg-bad-muted text-bad",
  MISROUTED: "bg-warn-muted text-warn",
  SEAL_BROKEN: "bg-bad-muted text-bad",
};

export default async function InboundReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("receipt.read");
  const { id } = await params;

  const receipt = await prisma.inboundReceipt.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      branchId: true,
      openedAt: true,
      closedAt: true,
      sealIntact: true,
      remarks: true,
      expectedShipments: true,
      expectedPackages: true,
      scannedPackages: true,
      shortPackages: true,
      excessPackages: true,
      branch: { select: { code: true, name: true } },
      manifest: {
        select: {
          id: true,
          number: true,
          originBranch: { select: { code: true, name: true } },
          trip: {
            select: {
              number: true,
              sealNumber: true,
              vehicle: { select: { registrationNumber: true } },
              driver: { select: { name: true, mobile: true } },
            },
          },
        },
      },
      lines: {
        orderBy: { createdAt: "asc" },
        select: {
          shipmentId: true,
          expectedPackages: true,
          scannedPackages: true,
          shipment: {
            select: {
              lrNumber: true,
              consigneeName: true,
              destinationBranch: { select: { code: true } },
            },
          },
        },
      },
      discrepancies: {
        orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          kind: true,
          barcode: true,
          quantity: true,
          remarks: true,
          resolvedAt: true,
          resolution: true,
          shipment: { select: { id: true, lrNumber: true } },
        },
      },
    },
  });

  if (!receipt) notFound();

  // Branch scoping on a single record: a user who does not cover this
  // branch never sees it, through the UI or by guessing the URL.
  if (!coversBranch(user, receipt.branchId)) notFound();

  const lines: ReceiptLine[] = receipt.lines.map((line) => ({
    shipmentId: line.shipmentId,
    lrNumber: line.shipment.lrNumber,
    expectedPackages: line.expectedPackages,
    scannedPackages: line.scannedPackages,
    destinationCode: line.shipment.destinationBranch.code,
    consigneeName: line.shipment.consigneeName,
  }));

  const isOpen = receipt.status === "OPEN";
  const canScan = can(user, "scan.inbound");
  const canClose = can(user, "receipt.close");
  const canResolve = can(user, "discrepancy.resolve");

  const facts = [
    { label: "From", value: receipt.manifest?.originBranch.code ?? "—" },
    { label: "At", value: receipt.branch.code },
    { label: "Trip", value: receipt.manifest?.trip?.number ?? "—" },
    {
      label: "Vehicle",
      value: receipt.manifest?.trip?.vehicle?.registrationNumber ?? "—",
    },
    { label: "Opened", value: format(receipt.openedAt, "dd MMM HH:mm") },
    {
      label: "Seal",
      value:
        receipt.sealIntact === null
          ? "Not checked"
          : receipt.sealIntact
            ? "Intact"
            : "Broken",
    },
  ];

  return (
    <>
      <Link
        href="/hub/inbound"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Inbound
      </Link>

      <PageHeader
        eyebrow={`${receipt.manifest?.originBranch.code ?? "?"} → ${receipt.branch.code}`}
        title={receipt.manifest?.number ?? "Inbound receipt"}
        description={
          isOpen
            ? "Scan each package off the truck. A line ticks green when its last box lands; anything still amber when you close becomes a shortage against the sending branch."
            : "Closed and reconciled. The discrepancies below were raised automatically from what was and was not scanned."
        }
        actions={
          <span
            className={
              receipt.status === "RECONCILED"
                ? "rounded-md bg-ok-muted px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-wider text-ok"
                : receipt.status === "CLOSED"
                  ? "rounded-md bg-warn-muted px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-wider text-warn"
                  : "rounded-md bg-muted px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground"
            }
          >
            {receipt.status}
          </span>
        }
      />

      <div className="mb-6 flex flex-wrap gap-3">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className="flex items-baseline gap-2 rounded-md border bg-card px-3 py-1.5"
          >
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              {fact.label}
            </span>
            <span className="text-sm font-semibold tabular">{fact.value}</span>
          </div>
        ))}
      </div>

      {isOpen ? (
        canScan ? (
          <ReceiptConsole
            receiptId={receipt.id}
            manifestNumber={receipt.manifest?.number ?? "this manifest"}
            originCode={receipt.manifest?.originBranch.code ?? "the origin"}
            lines={lines}
            canClose={canClose}
            sealIntact={receipt.sealIntact}
          />
        ) : (
          <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
            This receipt is open, but your role cannot scan inbound freight.
          </p>
        )
      ) : (
        <div className="flex flex-col gap-8">
          {/* Outcome */}
          <section className="grid gap-3 sm:grid-cols-4">
            {[
              { label: "Expected", value: receipt.expectedPackages, tone: "bg-muted" },
              { label: "Received", value: receipt.scannedPackages, tone: "bg-ok-muted text-ok" },
              {
                label: "Short",
                value: receipt.shortPackages,
                tone: receipt.shortPackages > 0 ? "bg-bad-muted text-bad" : "bg-muted",
              },
              {
                label: "Excess",
                value: receipt.excessPackages,
                tone: receipt.excessPackages > 0 ? "bg-warn-muted text-warn" : "bg-muted",
              },
            ].map((tile) => (
              <div key={tile.label} className={`flex flex-col gap-0.5 rounded-lg px-4 py-3 ${tile.tone}`}>
                <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] opacity-80">
                  {tile.label}
                </span>
                <span className="text-2xl font-semibold tabular">{tile.value}</span>
              </div>
            ))}
          </section>

          {/* Discrepancies */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              Discrepancies — {receipt.discrepancies.length}
            </h2>

            {receipt.discrepancies.length === 0 ? (
              <p className="rounded-lg border bg-ok-muted px-4 py-6 text-center text-sm text-ok">
                Nothing was short and nothing arrived unannounced. The manifest
                and the dock agree.
              </p>
            ) : (
              <TableFrame>
                <Table className="min-w-[760px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kind</TableHead>
                      <TableHead>Consignment</TableHead>
                      <TableHead>Barcode</TableHead>
                      <TableHead>What happened</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {receipt.discrepancies.map((discrepancy) => (
                      <TableRow key={discrepancy.id}>
                        <TableCell>
                          <span
                            className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${KIND_TONE[discrepancy.kind] ?? "bg-muted"}`}
                          >
                            {discrepancy.kind.replace("_", " ")}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {discrepancy.shipment ? (
                            <Link
                              href={`/shipments/${discrepancy.shipment.id}`}
                              className="hover:underline"
                            >
                              {discrepancy.shipment.lrNumber}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs break-all">
                          {discrepancy.barcode ?? (
                            <span className="text-muted-foreground">unlabelled</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-[280px] text-xs text-muted-foreground">
                          {discrepancy.remarks}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {receipt.manifest?.originBranch.code ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {discrepancy.resolvedAt ? (
                            <span className="text-ok">
                              Resolved — {discrepancy.resolution}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Open</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {!discrepancy.resolvedAt && canResolve && (
                            <ResolveDiscrepancyButton
                              discrepancyId={discrepancy.id}
                              label={`${discrepancy.kind.replace("_", " ").toLowerCase()} · ${discrepancy.barcode ?? discrepancy.shipment?.lrNumber ?? ""}`}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableFrame>
            )}
          </section>

          {/* Lines as received */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              Lines as reconciled
            </h2>
            <TableFrame>
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>LR number</TableHead>
                    <TableHead>Consignee</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead className="text-right">Declared</TableHead>
                    <TableHead className="text-right">Scanned</TableHead>
                    <TableHead className="text-right">Difference</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receipt.lines.map((line) => {
                    const difference = line.scannedPackages - line.expectedPackages;
                    return (
                      <TableRow key={line.shipmentId}>
                        <TableCell>
                          <Link
                            href={`/shipments/${line.shipmentId}`}
                            className="font-mono text-xs hover:underline"
                          >
                            {line.shipment.lrNumber}
                          </Link>
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-sm">
                          {line.shipment.consigneeName}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {line.shipment.destinationBranch.code}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {line.expectedPackages}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {line.scannedPackages}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {difference === 0 ? (
                            <span className="text-ok">—</span>
                          ) : (
                            <span className={difference < 0 ? "text-bad" : "text-warn"}>
                              {difference > 0 ? `+${difference}` : difference}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableFrame>
          </section>

          {receipt.remarks && (
            <p className="max-w-prose rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              {receipt.remarks}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Closed {receipt.closedAt ? format(receipt.closedAt, "dd MMM yyyy HH:mm") : "—"}.
            Discrepancy rows are permanent; resolving one records the outcome
            beside it rather than removing it.
          </p>
        </div>
      )}
    </>
  );
}
