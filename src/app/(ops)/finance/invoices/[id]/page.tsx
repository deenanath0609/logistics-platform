import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame } from "@/components/data/data-shell";
import { ReasonAction } from "@/components/finance/reason-action";
import { BackLink, StatusPill, MoneyCell } from "@/components/finance/finance-shell";
import { TracePanel, type StoredTrace } from "@/components/finance/trace-panel";
import { formatDate, formatMoney, formatPercent } from "@/components/finance/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isDebitNoteNumber } from "@/lib/billing/default-series";
import {
  issueInvoiceAction,
  cancelInvoiceAction,
  createCreditNoteAction,
  createDebitNoteAction,
} from "../actions";

export const metadata: Metadata = { title: "Invoice" };
export const dynamic = "force-dynamic";

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ trace?: string }>;
}) {
  const user = await requirePermission("invoice.read");
  const { id } = await params;
  const { trace: traceShipmentId } = await searchParams;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      customer: {
        select: { id: true, code: true, name: true, gstin: true, billingAddress: true },
      },
      branch: { select: { code: true, name: true } },
      lines: {
        orderBy: { sortOrder: "asc" },
        include: {
          shipment: { select: { id: true, lrNumber: true } },
        },
      },
      creditNotes: { orderBy: { issuedAt: "desc" } },
      allocations: {
        include: {
          payment: { select: { number: true, receivedOn: true, mode: true, reference: true } },
        },
      },
    },
  });

  if (!invoice) notFound();
  if (!coversBranch(user, invoice.branchId)) notFound();

  const canApprove = can(user, "invoice.approve");
  const canCancel = can(user, "invoice.cancel");
  const canBill = can(user, "invoice.create");

  // A debit note is a supplementary invoice numbered from its own series;
  // this document is one when its number came from that series.
  const isDebitNote = isDebitNoteNumber(invoice.number);

  // The stated tax lives on the lines. Under reverse charge the invoice's
  // own `taxAmount` is zero by design, so the figure the recipient owes
  // has to be added up from here.
  const statedTax = invoice.lines.reduce(
    (sum, line) => sum.plus(new Decimal(line.taxAmount.toString())),
    new Decimal(0),
  );

  const shipmentIds = [
    ...new Set(invoice.lines.map((line) => line.shipmentId).filter(Boolean)),
  ] as string[];

  const selectedShipmentId = traceShipmentId ?? shipmentIds[0] ?? null;

  const calculation = selectedShipmentId
    ? await prisma.freightCalculation.findFirst({
        where: { shipmentId: selectedShipmentId },
        orderBy: { createdAt: "desc" },
      })
    : null;

  const creditedTotal = invoice.creditNotes.reduce(
    (sum, note) => sum.plus(new Decimal(note.total.toString())),
    new Decimal(0),
  );

  return (
    <>
      <BackLink href="/finance/invoices" label="All invoices" />

      <PageHeader
        eyebrow={`${invoice.branch.code} · ${invoice.customer.code}${
          isDebitNote ? " · Debit note" : ""
        }`}
        title={invoice.number}
        description={
          isDebitNote
            ? "A supplementary invoice. The document it corrects is named in the notes below and was left exactly as issued."
            : invoice.periodFrom && invoice.periodTo
              ? `Consolidated for ${formatDate(invoice.periodFrom)} – ${formatDate(invoice.periodTo)}.`
              : "Raised against the consignments listed below."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/finance/invoices/${invoice.id}/print`}
              className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              Print / PDF
            </Link>
            {canApprove && invoice.status === "DRAFT" && (
              <ReasonAction
                id={invoice.id}
                title={`Issue ${invoice.number}?`}
                description="Once issued the document has left the building. The only correction after this is a credit note."
                reasonLabel="What you checked"
                reasonPlaceholder="Weights and lanes tallied against the delivery run for the period."
                confirmLabel="Approve & issue"
                icon="approve"
                action={issueInvoiceAction}
              />
            )}
            {canCancel && invoice.status !== "CANCELLED" && (
              <ReasonAction
                id={invoice.id}
                title={`Credit ${invoice.number}?`}
                description="A credit note leaves the invoice exactly as issued. The pair together is the trail."
                confirmLabel="Credit note"
                icon="credit"
                variant="outline"
                fields={[
                  {
                    name: "amount",
                    label: "Amount to credit (₹)",
                    type: "number",
                    step: "0.01",
                    required: true,
                    help: `Up to ${formatMoney(
                      new Decimal(invoice.total.toString()).minus(creditedTotal).toFixed(2),
                    )} is still creditable.`,
                  },
                  {
                    name: "taxAmount",
                    label: "Tax to credit (₹)",
                    type: "number",
                    step: "0.01",
                    help: invoice.isReverseCharge
                      ? "Ignored under reverse charge — no tax was charged."
                      : "The GST portion of the credit.",
                  },
                ]}
                action={createCreditNoteAction}
              />
            )}
            {canBill && !isDebitNote && invoice.status !== "CANCELLED" && invoice.status !== "DRAFT" && (
              <ReasonAction
                id={invoice.id}
                title={`Debit ${invoice.number}?`}
                description="A supplementary invoice for what this one under-billed — a revised chargeable weight, usually. The original is left exactly as issued."
                reasonLabel="What moved"
                reasonPlaceholder="Chargeable weight revised at the Jaipur hub from 100.000 kg to 140.000 kg."
                confirmLabel="Debit note"
                icon="debit"
                variant="outline"
                fields={[
                  {
                    name: "amount",
                    label: "Additional taxable value (₹)",
                    type: "number",
                    step: "0.01",
                    required: true,
                    help: "The extra charge, before tax. A reduction is a credit note, not this.",
                  },
                  {
                    name: "taxAmount",
                    label: "Tax on the addition (₹)",
                    type: "number",
                    step: "0.01",
                    help: invoice.isReverseCharge
                      ? "Stated on the note and not added to its total — the recipient pays it."
                      : "The GST on the additional value.",
                  },
                ]}
                action={createDebitNoteAction}
              />
            )}
            {canCancel && invoice.status !== "CANCELLED" && invoice.allocations.length === 0 && (
              <ReasonAction
                id={invoice.id}
                title={`Cancel ${invoice.number}?`}
                description="Only possible while no money has been received against it."
                confirmLabel="Cancel invoice"
                icon="cancel"
                destructive
                action={cancelInvoiceAction}
              />
            )}
          </div>
        }
      />

      {/* ── Header facts ───────────────────────────────────── */}
      <div className="grid gap-4 pb-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <p className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
                Billed to
              </p>
              <p className="font-medium">{invoice.customer.name}</p>
              {invoice.customer.billingAddress && (
                <p className="max-w-sm text-sm text-muted-foreground">
                  {invoice.customer.billingAddress}
                </p>
              )}
              {invoice.customerGstin && (
                <p className="font-mono text-xs text-muted-foreground">
                  GSTIN {invoice.customerGstin}
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-1">
              <StatusPill status={invoice.status} />
              <p className="text-xs text-muted-foreground">
                Dated {formatDate(invoice.invoiceDate)} · due {formatDate(invoice.dueDate)}
              </p>
              {invoice.issuedAt && (
                <p className="text-xs text-muted-foreground">
                  Issued {formatDate(invoice.issuedAt)}
                </p>
              )}
            </div>
          </div>

          {invoice.cancelReason && (
            <p className="mt-3 rounded-md border border-bad/40 bg-bad-muted px-3 py-2 text-sm text-bad">
              Cancelled {formatDate(invoice.cancelledAt)} — {invoice.cancelReason}
            </p>
          )}

          {invoice.notes && (
            <p className="mt-3 text-sm text-muted-foreground">{invoice.notes}</p>
          )}
        </div>

        <dl className="flex flex-col gap-1.5 rounded-lg border bg-card p-4">
          <Row label="Subtotal" value={formatMoney(invoice.subtotal.toString())} />
          {invoice.isReverseCharge ? (
            <>
              <Row
                label="Tax (reverse charge)"
                value={formatMoney(statedTax.toFixed(2))}
                muted
              />
              <p className="rounded-md border border-warn/40 bg-warn-muted px-2.5 py-1.5 text-xs text-warn">
                Tax payable by the recipient under reverse charge. It is stated here and is
                <strong> not</strong> added to the total.
              </p>
            </>
          ) : (
            <Row label="Tax" value={formatMoney(invoice.taxAmount.toString())} />
          )}
          <Row label="Round off" value={formatMoney(invoice.roundOff.toString())} muted />
          <div className="my-1 border-t" />
          <Row label="Total" value={formatMoney(invoice.total.toString())} strong />
          <Row label="Received" value={formatMoney(invoice.amountPaid.toString())} muted />
          {creditedTotal.greaterThan(0) && (
            <Row label="Credited" value={formatMoney(creditedTotal.toFixed(2))} muted />
          )}
          <Row
            label="Outstanding"
            value={formatMoney(invoice.amountDue.toString())}
            strong
          />
        </dl>
      </div>

      {/* ── Lines ──────────────────────────────────────────── */}
      <section className="pb-8">
        <h2 className="pb-3 text-sm font-semibold">
          Lines
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            every one traces to its consignment
          </span>
        </h2>
        <TableFrame>
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>LR</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="w-16 text-right">Trace</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell className="font-mono text-xs">
                    {line.shipment ? (
                      <Link
                        href={`/shipments/${line.shipment.id}`}
                        className="hover:underline"
                      >
                        {line.shipment.lrNumber}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{line.description}</TableCell>
                  <TableCell className="text-right text-xs tabular">
                    {Number(line.quantity).toFixed(3)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular">
                    {Number(line.rate).toFixed(4)}
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyCell value={line.amount.toString()} />
                  </TableCell>
                  <TableCell className="text-right text-xs tabular text-muted-foreground">
                    {formatMoney(line.taxAmount.toString())}
                    {line.taxPercent && (
                      <span className="ml-1">
                        ({formatPercent(line.taxPercent.toString(), 1)})
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {line.shipmentId && (
                      <Link
                        href={`?trace=${line.shipmentId}`}
                        className="font-mono text-[0.65rem] uppercase tracking-wider text-primary hover:underline"
                      >
                        Why?
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      </section>

      {/* ── Trace ──────────────────────────────────────────── */}
      {selectedShipmentId && (
        <section className="pb-8">
          <h2 className="pb-3 text-sm font-semibold">
            How this was priced
            <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
              {invoice.lines.find((l) => l.shipmentId === selectedShipmentId)?.shipment
                ?.lrNumber ?? ""}
            </span>
          </h2>
          <TracePanel
            trace={calculation?.trace as StoredTrace | null}
            stage={calculation?.stage}
            calculatedAt={calculation?.createdAt}
            totals={
              calculation
                ? {
                    chargeableWeight: calculation.chargeableWeight.toString(),
                    freightAmount: calculation.freightAmount.toString(),
                    chargesTotal: calculation.chargesTotal.toString(),
                    taxAmount: calculation.taxAmount.toString(),
                    grandTotal: calculation.grandTotal.toString(),
                  }
                : undefined
            }
          />
        </section>
      )}

      {/* ── Credit notes and receipts ──────────────────────── */}
      {invoice.creditNotes.length > 0 && (
        <section className="pb-8">
          <h2 className="pb-3 text-sm font-semibold">Credit notes</h2>
          <TableFrame>
            <Table className="min-w-[600px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.creditNotes.map((note) => (
                  <TableRow key={note.id}>
                    <TableCell className="font-mono text-xs">{note.number}</TableCell>
                    <TableCell className="text-xs">{formatDate(note.issuedAt)}</TableCell>
                    <TableCell className="text-sm">{note.reason}</TableCell>
                    <TableCell className="text-right">
                      <MoneyCell value={note.total.toString()} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        </section>
      )}

      {invoice.allocations.length > 0 && (
        <section>
          <h2 className="pb-3 text-sm font-semibold">Receipts applied</h2>
          <TableFrame>
            <Table className="min-w-[600px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Applied</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.allocations.map((allocation) => (
                  <TableRow key={allocation.id}>
                    <TableCell className="font-mono text-xs">
                      {allocation.payment.number}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDate(allocation.payment.receivedOn)}
                    </TableCell>
                    <TableCell className="text-xs">{allocation.payment.mode}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {allocation.payment.reference ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyCell value={allocation.amount.toString()} />
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

function Row({
  label,
  value,
  strong = false,
  muted = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={`text-sm ${muted ? "text-muted-foreground" : ""}`}>{label}</dt>
      <dd
        className={`tabular ${strong ? "text-base font-semibold" : "text-sm"} ${
          muted ? "text-muted-foreground" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
