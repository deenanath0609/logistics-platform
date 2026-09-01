import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronLeft, ScanLine } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OpenReceiptButton } from "./open-receipt-button";

export const metadata: Metadata = { title: "Inbound" };
export const dynamic = "force-dynamic";

/**
 * The inbound board: what is on its way here, and what is half-received.
 *
 * Scoped to the branches the user covers on `destinationBranchId` — a
 * Delhi clerk has no business seeing what Jaipur is expecting.
 */
export default async function InboundPage() {
  // `receipt.read`, matching the navigation entry that points here.
  // Guarding on `scan.inbound` meant everybody who could read receipts and
  // not scan — management, the ops reader roles — was offered "Inbound
  // receipts" in the sidebar and thrown to the 403 page for taking it.
  // Receiving itself is a separate permission, checked on the control.
  const user = await requirePermission("receipt.read");
  const canReceive = can(user, "scan.inbound");

  const scope = branchScope(user, "destinationBranchId");

  const [openReceipts, arriving, recentlyClosed] = await Promise.all([
    prisma.inboundReceipt.findMany({
      where: { status: "OPEN", ...branchScope(user, "branchId") },
      orderBy: { openedAt: "desc" },
      select: {
        id: true,
        openedAt: true,
        expectedShipments: true,
        expectedPackages: true,
        scannedPackages: true,
        branch: { select: { code: true } },
        manifest: {
          select: { number: true, originBranch: { select: { code: true } } },
        },
      },
    }),

    // Manifests consigned here that have left their origin and have no
    // receipt open yet.
    prisma.manifest.findMany({
      where: {
        status: { in: ["DISPATCHED", "CLOSED"] },
        ...scope,
        receipts: { none: { status: "OPEN" } },
      },
      orderBy: [{ dispatchedAt: "desc" }, { createdAt: "desc" }],
      take: 50,
      select: {
        id: true,
        number: true,
        status: true,
        dispatchedAt: true,
        totalShipments: true,
        totalPackages: true,
        totalWeight: true,
        originBranch: { select: { code: true, name: true } },
        destinationBranchId: true,
        destinationBranch: { select: { code: true } },
        trip: {
          select: {
            number: true,
            sealNumber: true,
            vehicle: { select: { registrationNumber: true } },
            driver: { select: { name: true, mobile: true } },
          },
        },
      },
    }),

    prisma.inboundReceipt.findMany({
      where: { status: { in: ["CLOSED", "RECONCILED"] }, ...branchScope(user, "branchId") },
      orderBy: { closedAt: "desc" },
      take: 10,
      select: {
        id: true,
        closedAt: true,
        status: true,
        expectedPackages: true,
        scannedPackages: true,
        shortPackages: true,
        excessPackages: true,
        manifest: { select: { number: true, originBranch: { select: { code: true } } } },
      },
    }),
  ]);

  return (
    <>
      <Link
        href="/hub"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Branch floor
      </Link>

      <PageHeader
        eyebrow="Hub operations"
        title="Inbound receipt"
        description="Open an arriving manifest and scan against it. Closing the receipt is what turns unscanned lines into shortages and unexpected boxes into excess — automatically, against the branch that sent them."
      />

      {/* Half-done receipts first: they are the work in progress. */}
      {openReceipts.length > 0 && (
        <section className="mb-8 flex flex-col gap-3">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-warn">
            Open on the dock — {openReceipts.length}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {openReceipts.map((receipt) => (
              <Link
                key={receipt.id}
                href={`/hub/inbound/${receipt.id}`}
                className="flex flex-col gap-2 rounded-lg border-2 border-warn/40 bg-card p-4 transition-colors hover:border-warn"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-sm font-semibold">
                    {receipt.manifest?.number ?? "No manifest"}
                  </span>
                  <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                    {receipt.manifest?.originBranch.code ?? "—"} → {receipt.branch.code}
                  </span>
                </div>
                <p className="text-sm tabular">
                  <span className="text-2xl font-semibold">{receipt.scannedPackages}</span>
                  <span className="text-muted-foreground"> / {receipt.expectedPackages} packages</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Opened {format(receipt.openedAt, "dd MMM HH:mm")} ·{" "}
                  {receipt.expectedShipments} consignment
                  {receipt.expectedShipments === 1 ? "" : "s"}
                </p>
                <span className="mt-1 inline-flex items-center gap-1 font-mono text-[0.6rem] uppercase tracking-wider text-warn">
                  <ScanLine className="size-3" />
                  Continue scanning
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="mb-8 flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Expected here
        </h2>

        <TableFrame>
          {arriving.length === 0 ? (
            <EmptyState
              title="Nothing inbound"
              description="No manifest has been dispatched to this branch. When one leaves its origin it appears here."
            />
          ) : (
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Manifest</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Trip</TableHead>
                  <TableHead>Vehicle &amp; driver</TableHead>
                  <TableHead className="text-right">Shipments</TableHead>
                  <TableHead className="text-right">Packages</TableHead>
                  <TableHead className="text-right">Weight</TableHead>
                  <TableHead>Dispatched</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {arriving.map((manifest) => (
                  <TableRow key={manifest.id}>
                    <TableCell>
                      <Link
                        href={`/dispatch/manifests/${manifest.id}`}
                        className="font-mono text-xs font-medium hover:underline"
                      >
                        {manifest.number}
                      </Link>
                      {manifest.status === "CLOSED" && (
                        <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-muted-foreground">
                          not gated out
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {manifest.originBranch.code}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {manifest.trip?.number ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {manifest.trip?.vehicle ? (
                        <>
                          <span className="font-mono">
                            {manifest.trip.vehicle.registrationNumber}
                          </span>
                          {manifest.trip.driver && (
                            <span className="ml-2 text-muted-foreground">
                              {manifest.trip.driver.name}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {manifest.totalShipments}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {manifest.totalPackages}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular">
                      {Number(manifest.totalWeight)} kg
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                      {manifest.dispatchedAt
                        ? format(manifest.dispatchedAt, "dd MMM HH:mm")
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {/*
                        A manifest closed for dispatch but never gated out
                        has, on paper, not left its origin — every
                        consignment on it is still MANIFESTED, and the
                        spine takes an inbound scan from DISPATCHED. The
                        Receive button used to be offered anyway, and the
                        receipt that followed ticked green while moving
                        nothing. Say so instead.
                      */}
                      {manifest.status === "CLOSED" ? (
                        <span className="text-xs text-warn">
                          Not gated out yet
                        </span>
                      ) : canReceive ? (
                        <OpenReceiptButton
                          manifestId={manifest.id}
                          manifestNumber={manifest.number}
                          branchId={manifest.destinationBranchId}
                          originCode={manifest.originBranch.code}
                          sealNumber={manifest.trip?.sealNumber ?? null}
                          packages={manifest.totalPackages}
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableFrame>
      </section>

      {recentlyClosed.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Recently closed
          </h2>
          <TableFrame>
            <Table className="min-w-[700px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Manifest</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Closed</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Short</TableHead>
                  <TableHead className="text-right">Excess</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentlyClosed.map((receipt) => (
                  <TableRow key={receipt.id}>
                    <TableCell>
                      <Link
                        href={`/hub/inbound/${receipt.id}`}
                        className="font-mono text-xs font-medium hover:underline"
                      >
                        {receipt.manifest?.number ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {receipt.manifest?.originBranch.code ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                      {receipt.closedAt ? format(receipt.closedAt, "dd MMM HH:mm") : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {receipt.expectedPackages}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {receipt.scannedPackages}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {receipt.shortPackages > 0 ? (
                        <span className="rounded-sm bg-bad-muted px-1.5 py-0.5 font-semibold text-bad">
                          {receipt.shortPackages}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {receipt.excessPackages > 0 ? (
                        <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 font-semibold text-warn">
                          {receipt.excessPackages}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          receipt.status === "RECONCILED"
                            ? "rounded-sm bg-ok-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-ok"
                            : "rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-warn"
                        }
                      >
                        {receipt.status === "RECONCILED" ? "Clean" : "Discrepancies"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        </section>
      )}
    </>
  );
}
