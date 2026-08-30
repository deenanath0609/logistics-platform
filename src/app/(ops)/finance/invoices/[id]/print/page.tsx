import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { DocumentLogo } from "@/components/documents/letterhead";
import { documentDate, documentMoney } from "@/components/documents/format";
import {
  FORWARD_CHARGE_DECLARATION,
  REVERSE_CHARGE_DECLARATION,
  resolveSupplyPlace,
  taxSummary,
} from "@/lib/billing/gst";
import { amountInWords } from "@/lib/billing/words";
import { isDebitNoteNumber } from "@/lib/billing/default-series";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Tax invoice" };
export const dynamic = "force-dynamic";

/**
 * The tax invoice — the document the customer files.
 *
 * Laid out for A4 and printed from the browser, exactly like the
 * consignment note: no PDF library, because a print stylesheet is a
 * document anyone can fix and a generated PDF is a build artefact nobody
 * can.
 *
 * Everything Rule 46 of the CGST Rules asks for is on it: both parties
 * with their GSTINs, the place of supply, invoice and due dates, a line
 * per charge with its HSN/SAC, the taxable value, a rate-wise tax
 * summary split into CGST/SGST or IGST, the total in words, and — when it
 * applies — the reverse-charge declaration, which states the tax without
 * adding it to the total.
 */
export default async function InvoicePrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("invoice.read");
  const { id } = await params;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      customer: {
        select: {
          code: true,
          name: true,
          legalName: true,
          gstin: true,
          pan: true,
          billingAddress: true,
          billingPincode: true,
          billingCity: {
            select: { name: true, state: { select: { name: true, gstCode: true } } },
          },
        },
      },
      branch: {
        select: {
          code: true,
          name: true,
          address: true,
          pincode: true,
          phone: true,
          email: true,
          gstin: true,
          city: {
            select: { name: true, state: { select: { name: true, gstCode: true } } },
          },
        },
      },
      lines: {
        orderBy: { sortOrder: "asc" },
        include: {
          shipment: {
            select: {
              lrNumber: true,
              bookedAt: true,
              packageCount: true,
              chargeableWeight: true,
            },
          },
        },
      },
      creditNotes: { orderBy: { issuedAt: "asc" } },
    },
  });

  if (!invoice) notFound();
  if (!coversBranch(user, invoice.branchId)) notFound();

  // The supplier on a tax invoice is the organisation that raised it, so it
  // is read by that id. `Organization` is global and the tenant extension
  // does not filter it (ADR 001 §4): a `where`-less read would put an
  // arbitrary tenant's name, GSTIN and PAN on a document the customer files
  // with their return.
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: invoice.orgId },
    select: {
      name: true,
      legalName: true,
      gstin: true,
      pan: true,
      cin: true,
      address: true,
      city: true,
      state: true,
      pincode: true,
      phone: true,
      email: true,
      website: true,
      logoUrl: true,
      documentFooter: true,
      termsText: true,
      supportEmail: true,
      supportPhone: true,
      currency: true,
      timezone: true,
    },
  });

  const isDebitNote = isDebitNoteNumber(invoice.number);
  const documentTitle = isDebitNote ? "Debit note" : "Tax invoice";

  // Under reverse charge the invoice's own `taxAmount` is zero by design,
  // so the figure the recipient owes has to be added up from the lines.
  const statedTax = invoice.lines.reduce(
    (sum, line) => sum.plus(new Decimal(line.taxAmount.toString())),
    new Decimal(0),
  );

  const supply = resolveSupplyPlace({
    sellerGstin: invoice.branch.gstin ?? org.gstin,
    sellerStateCode: invoice.branch.city.state.gstCode,
    sellerStateName: invoice.branch.city.state.name ?? org.state,
    buyerGstin: invoice.customerGstin ?? invoice.customer.gstin,
    placeOfSupply: invoice.placeOfSupply,
    buyerStateCode: invoice.customer.billingCity?.state.gstCode ?? null,
    buyerStateName: invoice.customer.billingCity?.state.name ?? null,
  });

  const summary = taxSummary(
    invoice.lines.map((line) => ({
      amount: line.amount.toString(),
      taxPercent: line.taxPercent?.toString() ?? 0,
      taxAmount: line.taxAmount.toString(),
      hsnSac: line.hsnSac,
    })),
    supply.isIntraState,
  );

  const creditedTotal = invoice.creditNotes.reduce(
    (sum, note) => sum.plus(new Decimal(note.total.toString())),
    new Decimal(0),
  );

  const sellerAddress = [
    invoice.branch.address,
    `${invoice.branch.city.name} — ${invoice.branch.pincode}`,
    invoice.branch.city.state.name,
  ].filter(Boolean);

  const contactLine = [
    invoice.branch.phone ?? org.phone,
    invoice.branch.email ?? org.email,
    org.website,
  ]
    .filter(Boolean)
    .join(" · ");

  const buyerAddress = [
    invoice.customer.billingAddress,
    invoice.customer.billingCity
      ? `${invoice.customer.billingCity.name}${
          invoice.customer.billingPincode ? ` — ${invoice.customer.billingPincode}` : ""
        }`
      : null,
    invoice.customer.billingCity?.state.name ?? null,
  ].filter(Boolean) as string[];

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          /* The app chrome is irrelevant on paper. */
          aside, header { display: none !important; }
          .print-sheet { border: none !important; box-shadow: none !important; padding: 0 !important; }
          thead { display: table-header-group; }
          tr { break-inside: avoid; page-break-inside: avoid; }
          .keep-together { break-inside: avoid; page-break-inside: avoid; }
          @page { size: A4; margin: 12mm; }
        }
      `}</style>

      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-primary">
            Print preview
          </p>
          <h1 className="text-xl font-semibold tracking-tight">{invoice.number}</h1>
        </div>
        <PrintButton />
      </div>

      <article className="print-sheet mx-auto max-w-3xl rounded-lg border bg-card p-8 text-[13px] leading-relaxed">
        {/* Masthead */}
        <header className="flex items-start justify-between gap-6 border-b-2 border-foreground pb-4">
          <div>
            <DocumentLogo src={org.logoUrl} name={org.legalName ?? org.name} />
            <p className="text-lg font-bold tracking-tight">
              {org.legalName ?? org.name}
            </p>
            {org.legalName && org.legalName !== org.name && (
              <p className="text-xs text-muted-foreground">{org.name}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {invoice.branch.name} ({invoice.branch.code})
            </p>
            {sellerAddress.map((line) => (
              <p key={line} className="text-xs text-muted-foreground">
                {line}
              </p>
            ))}
            {/*
              The branch that raised the invoice answers for it, so its own
              contacts win over the head-office ones. The website is the
              carrier's, never the branch's.
            */}
            {contactLine && (
              <p className="text-xs text-muted-foreground">{contactLine}</p>
            )}
            <p className="mt-1 font-mono text-xs">
              GSTIN {invoice.branch.gstin ?? org.gstin ?? "—"}
              {org.pan && <span className="ml-3">PAN {org.pan}</span>}
            </p>
            {org.cin && <p className="font-mono text-[0.65rem]">CIN {org.cin}</p>}
          </div>

          <div className="text-right">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-muted-foreground">
              {documentTitle}
            </p>
            <p className="font-mono text-xl font-bold tracking-tight">
              {invoice.number}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Dated {documentDate(invoice.invoiceDate, org.timezone)}
            </p>
            <p className="text-xs text-muted-foreground">
              Due {documentDate(invoice.dueDate, org.timezone)}
            </p>
            {invoice.periodFrom && invoice.periodTo && (
              <p className="mt-1 text-xs text-muted-foreground">
                Period {documentDate(invoice.periodFrom, org.timezone)} –{" "}
                {documentDate(invoice.periodTo, org.timezone)}
              </p>
            )}
            {invoice.isReverseCharge && (
              <p className="mt-2 inline-block rounded-sm border border-foreground px-1.5 py-0.5 font-mono text-[0.55rem] font-bold uppercase tracking-wider">
                Reverse charge
              </p>
            )}
            {invoice.status === "CANCELLED" && (
              <p className="mt-2 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-bad">
                Cancelled
              </p>
            )}
          </div>
        </header>

        {/* Parties */}
        <section className="grid grid-cols-2 gap-6 border-b py-4">
          <div className="flex flex-col gap-0.5">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Supplier
            </p>
            <p className="font-semibold">{org.legalName ?? org.name}</p>
            {sellerAddress.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="font-mono text-xs">
              GSTIN {invoice.branch.gstin ?? org.gstin ?? "—"}
            </p>
            <p className="font-mono text-xs">
              State {invoice.branch.city.state.name}
              {supply.sellerStateCode ? ` (${supply.sellerStateCode})` : ""}
            </p>
          </div>

          <div className="flex flex-col gap-0.5">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Recipient
            </p>
            <p className="font-semibold">
              {invoice.customer.legalName ?? invoice.customer.name}
            </p>
            {invoice.customer.legalName &&
              invoice.customer.legalName !== invoice.customer.name && (
                <p className="text-xs text-muted-foreground">{invoice.customer.name}</p>
              )}
            {buyerAddress.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="font-mono text-xs">
              GSTIN {invoice.customerGstin ?? invoice.customer.gstin ?? "Unregistered"}
            </p>
            <p className="font-mono text-xs">
              Place of supply {supply.placeOfSupply ?? "—"}
              {supply.buyerStateCode ? ` (${supply.buyerStateCode})` : ""}
            </p>
          </div>
        </section>

        {supply.isUndetermined && (
          <p className="no-print mt-3 rounded-md border border-warn/40 bg-warn-muted px-3 py-2 text-xs text-warn">
            Neither the billing branch nor the customer carries a GSTIN or a state, so the
            supply could not be placed. It has been stated as inter-state (IGST). Set the
            branch GSTIN or the customer&rsquo;s billing city before this is filed.
          </p>
        )}

        {/* Lines */}
        <section className="border-b py-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-foreground text-left">
                <th className="w-6 py-1 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                  #
                </th>
                <th className="py-1 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                  Description
                </th>
                <th className="py-1 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                  HSN/SAC
                </th>
                <th className="py-1 text-right font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                  Qty
                </th>
                <th className="py-1 text-right font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                  Rate
                </th>
                <th className="py-1 text-right font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                  Taxable value
                </th>
                <th className="py-1 text-right font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                  GST %
                </th>
                <th className="py-1 text-right font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
                  Tax
                </th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, index) => (
                <tr key={line.id} className="border-b border-dotted align-top">
                  <td className="py-1 tabular">{index + 1}</td>
                  <td className="py-1">
                    {line.description}
                    {line.shipment && (
                      <span className="block font-mono text-[0.6rem] text-muted-foreground">
                        {line.shipment.lrNumber} ·{" "}
                        {documentDate(line.shipment.bookedAt, org.timezone)} ·{" "}
                        {line.shipment.packageCount} pkg ·{" "}
                        {Number(line.shipment.chargeableWeight).toFixed(3)} kg
                      </span>
                    )}
                  </td>
                  <td className="py-1 font-mono">{line.hsnSac ?? "—"}</td>
                  <td className="py-1 text-right tabular">
                    {Number(line.quantity).toFixed(3)}
                  </td>
                  <td className="py-1 text-right tabular">
                    {Number(line.rate).toFixed(2)}
                  </td>
                  <td className="py-1 text-right tabular">
                    {Number(line.amount).toFixed(2)}
                  </td>
                  <td className="py-1 text-right tabular">
                    {line.taxPercent ? `${Number(line.taxPercent).toFixed(2)}` : "—"}
                  </td>
                  <td className="py-1 text-right tabular">
                    {Number(line.taxAmount).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Tax summary and totals */}
        <section className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-6 border-b py-4">
          <div className="keep-together">
            <p className="mb-1.5 font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              Tax summary
            </p>
            <table className="w-full text-[0.7rem]">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-0.5 font-normal text-muted-foreground">HSN/SAC</th>
                  <th className="py-0.5 text-right font-normal text-muted-foreground">
                    Taxable
                  </th>
                  {supply.isIntraState ? (
                    <>
                      <th className="py-0.5 text-right font-normal text-muted-foreground">
                        CGST
                      </th>
                      <th className="py-0.5 text-right font-normal text-muted-foreground">
                        SGST
                      </th>
                    </>
                  ) : (
                    <th className="py-0.5 text-right font-normal text-muted-foreground">
                      IGST
                    </th>
                  )}
                  <th className="py-0.5 text-right font-normal text-muted-foreground">
                    Total tax
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((row) => (
                  <tr key={`${row.hsnSac}-${row.ratePercent.toFixed(3)}`}>
                    <td className="py-0.5 font-mono">
                      {row.hsnSac || "—"}
                      <span className="ml-1.5 text-muted-foreground">
                        @ {row.ratePercent.toFixed(2)}%
                      </span>
                    </td>
                    <td className="py-0.5 text-right tabular">
                      {row.taxableValue.toFixed(2)}
                    </td>
                    {supply.isIntraState ? (
                      <>
                        <td className="py-0.5 text-right tabular">{row.cgst.toFixed(2)}</td>
                        <td className="py-0.5 text-right tabular">{row.sgst.toFixed(2)}</td>
                      </>
                    ) : (
                      <td className="py-0.5 text-right tabular">{row.igst.toFixed(2)}</td>
                    )}
                    <td className="py-0.5 text-right tabular">{row.total.toFixed(2)}</td>
                  </tr>
                ))}
                <tr className="border-t font-semibold">
                  <td className="py-1">Total</td>
                  <td className="py-1 text-right tabular">
                    {summary.totals.taxableValue.toFixed(2)}
                  </td>
                  {supply.isIntraState ? (
                    <>
                      <td className="py-1 text-right tabular">
                        {summary.totals.cgst.toFixed(2)}
                      </td>
                      <td className="py-1 text-right tabular">
                        {summary.totals.sgst.toFixed(2)}
                      </td>
                    </>
                  ) : (
                    <td className="py-1 text-right tabular">
                      {summary.totals.igst.toFixed(2)}
                    </td>
                  )}
                  <td className="py-1 text-right tabular">
                    {summary.totals.total.toFixed(2)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <dl className="keep-together flex flex-col gap-1">
            <TotalRow
              label="Taxable value"
              value={invoice.subtotal.toString()}
              currency={org.currency}
            />
            {invoice.isReverseCharge ? (
              <TotalRow
                label="GST (reverse charge)"
                value={statedTax.toFixed(2)}
                currency={org.currency}
                muted
                note="not collected"
              />
            ) : (
              <TotalRow
                label="GST"
                value={invoice.taxAmount.toString()}
                currency={org.currency}
              />
            )}
            <TotalRow
              label="Round off"
              value={invoice.roundOff.toString()}
              currency={org.currency}
              muted
            />
            <div className="my-1 border-t border-foreground" />
            <TotalRow
              label="Total payable"
              value={invoice.total.toString()}
              currency={org.currency}
              strong
            />
            {creditedTotal.greaterThan(0) && (
              <TotalRow
                label="Credited"
                value={creditedTotal.toFixed(2)}
                currency={org.currency}
                muted
              />
            )}
            <TotalRow
              label="Received"
              value={invoice.amountPaid.toString()}
              currency={org.currency}
              muted
            />
            <TotalRow
              label="Outstanding"
              value={invoice.amountDue.toString()}
              currency={org.currency}
              strong
            />
          </dl>
        </section>

        {/* Amount in words */}
        <section className="border-b py-3">
          <p className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
            Total in words
          </p>
          <p className="font-semibold">{amountInWords(invoice.total.toString())}</p>
          {invoice.isReverseCharge && statedTax.greaterThan(0) && (
            <p className="mt-1 text-xs text-muted-foreground">
              Tax payable by the recipient: {amountInWords(statedTax.toFixed(2))}
            </p>
          )}
        </section>

        {/* Declarations */}
        <section className="keep-together border-b py-4">
          <p className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
            Declaration
          </p>
          {invoice.isReverseCharge ? (
            <p className="mt-1 font-medium">{REVERSE_CHARGE_DECLARATION}</p>
          ) : (
            <p className="mt-1">{FORWARD_CHARGE_DECLARATION}</p>
          )}
          {invoice.notes && <p className="mt-2 text-xs">{invoice.notes}</p>}
          {invoice.cancelReason && (
            <p className="mt-2 text-xs font-medium">
              Cancelled — {invoice.cancelReason}
            </p>
          )}
          {/*
            Left global, alongside the two GST declarations above it. It
            asserts only that the figures on this sheet are the ones
            actually charged — a statement that is identical for every
            carrier and that no carrier would want to weaken. `termsText`
            and `documentFooter` are both already spoken for below, and a
            tenant-overridable certification would need a field of its own
            before it were worth having.
          */}
          <p className="mt-2 text-[0.65rem] text-muted-foreground">
            We certify that the particulars given above are true and correct, and that the
            amount indicated represents the price actually charged.
          </p>
        </section>

        {/* Signature */}
        <section className="flex items-end justify-between gap-6 pt-10">
          {/*
            The due date is the invoice's own. What follows it used to be
            our copy — a sentence about rate card versions, which is a
            claim about how this platform prices rather than a term the
            carrier is offering their customer. The terms of business are
            the carrier's to write, so an unset `termsText` prints the due
            date alone.
          */}
          <p className="max-w-sm text-[0.6rem] leading-snug text-muted-foreground">
            Payment is due by {documentDate(invoice.dueDate, org.timezone)}.
            {org.termsText ? ` ${org.termsText}` : ""}
          </p>
          <div className="flex w-56 flex-col gap-1 text-center">
            <div className="h-12 border-b border-foreground" />
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              For {org.legalName ?? org.name}
            </span>
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              Authorised signatory
            </span>
          </div>
        </section>

        {/*
          The carrier's footer where they have written one; otherwise the
          one thing that is true of this sheet whoever issued it. The draft
          warning is the invoice's own state and is appended either way —
          tenant copy must never be able to hide that a number is
          provisional.
        */}
        <p className="mt-6 text-[0.6rem] leading-snug text-muted-foreground">
          {org.documentFooter ??
            `This is a computer-generated ${documentTitle.toLowerCase()}.`}
          {invoice.status === "DRAFT" &&
            " It is a draft and has not been issued — the number above is provisional until approval."}
        </p>
      </article>
    </>
  );
}

function TotalRow({
  label,
  value,
  currency,
  strong = false,
  muted = false,
  note,
}: {
  label: string;
  value: string;
  currency: string;
  strong?: boolean;
  muted?: boolean;
  note?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={`text-xs ${muted ? "text-muted-foreground" : ""}`}>
        {label}
        {note && <span className="ml-1 text-[0.6rem]">({note})</span>}
      </dt>
      <dd
        className={`tabular ${strong ? "text-sm font-bold" : "text-xs"} ${
          muted ? "text-muted-foreground" : ""
        }`}
      >
        {documentMoney(value, currency)}
      </dd>
    </div>
  );
}
