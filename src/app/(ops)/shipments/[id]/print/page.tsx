import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Consignment note" };
export const dynamic = "force-dynamic";

/**
 * The consignment note — the legal document for the movement.
 *
 * Laid out for A4 and printed from the browser. Thermal label output
 * (Code128 / ZPL) lands in Phase 3 alongside the printer and scanner
 * selection, where it can be validated against real hardware rather than
 * shipped on the assumption that it scans.
 */
export default async function PrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("shipment.print");
  const { id } = await params;

  const shipment = await prisma.shipment.findUnique({
    where: { id },
    include: {
      serviceType: { select: { code: true, name: true } },
      originBranch: { select: { code: true, name: true, address: true, phone: true, gstin: true } },
      destinationBranch: { select: { code: true, name: true } },
      consignorCity: { select: { name: true } },
      consigneeCity: { select: { name: true } },
      packageType: { select: { name: true } },
      packages: { orderBy: { sequence: "asc" } },
      charges: {
        orderBy: { sortOrder: "asc" },
        include: { chargeType: { select: { name: true } } },
      },
    },
  });

  if (!shipment || shipment.deletedAt) notFound();

  const org = await prisma.organization.findFirstOrThrow({
    select: { name: true, legalName: true, gstin: true, phone: true, email: true },
  });

  const rows: Array<[string, string]> = [
    ["Service", `${shipment.serviceType.code} · ${shipment.mode}`],
    ["Booked", format(shipment.bookedAt, "dd MMM yyyy HH:mm")],
    ["Packages", String(shipment.packageCount)],
    ["Package type", shipment.packageType?.name ?? "—"],
    ["Actual weight", `${Number(shipment.actualWeight)} kg`],
    ["Chargeable weight", `${Number(shipment.chargeableWeight)} kg`],
    [
      "Declared value",
      shipment.declaredValue
        ? `₹${Number(shipment.declaredValue).toLocaleString("en-IN")}`
        : "—",
    ],
    ["E-way bill", shipment.ewayBillNumber ?? "—"],
    ["Customer ref", shipment.customerReference ?? "—"],
  ];

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          /* The app chrome is irrelevant on paper. */
          aside, header { display: none !important; }
          .print-sheet { border: none !important; box-shadow: none !important; padding: 0 !important; }
          .label-card { break-inside: avoid; page-break-inside: avoid; }
          @page { size: A4; margin: 12mm; }
        }
      `}</style>

      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-primary">
            Print preview
          </p>
          <h1 className="text-xl font-semibold tracking-tight">
            {shipment.lrNumber}
          </h1>
        </div>
        <PrintButton />
      </div>

      <article className="print-sheet mx-auto max-w-3xl rounded-lg border bg-card p-8 text-[13px] leading-relaxed">
        {/* Masthead */}
        <header className="flex items-start justify-between gap-6 border-b-2 border-foreground pb-4">
          <div>
            <p className="text-lg font-bold tracking-tight">{org.name}</p>
            {org.legalName && (
              <p className="text-xs text-muted-foreground">{org.legalName}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {shipment.originBranch.name} · {shipment.originBranch.address}
            </p>
            {shipment.originBranch.phone && (
              <p className="text-xs text-muted-foreground">
                {shipment.originBranch.phone}
              </p>
            )}
            {(shipment.originBranch.gstin ?? org.gstin) && (
              <p className="font-mono text-xs text-muted-foreground">
                GSTIN {shipment.originBranch.gstin ?? org.gstin}
              </p>
            )}
          </div>

          <div className="text-right">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-muted-foreground">
              Consignment note
            </p>
            <p className="font-mono text-xl font-bold tracking-tight">
              {shipment.lrNumber}
            </p>
            <p className="mt-1 font-mono text-sm font-semibold">
              {shipment.originBranch.code} → {shipment.destinationBranch.code}
            </p>
          </div>
        </header>

        {/* Parties */}
        <section className="grid grid-cols-2 gap-6 border-b py-4">
          {[
            {
              title: "Consignor",
              name: shipment.consignorName,
              company: shipment.consignorCompany,
              phone: shipment.consignorPhone,
              address: shipment.consignorAddress,
              city: shipment.consignorCity.name,
              pincode: shipment.consignorPincode,
              gstin: shipment.consignorGstin,
            },
            {
              title: "Consignee",
              name: shipment.consigneeName,
              company: shipment.consigneeCompany,
              phone: shipment.consigneePhone,
              address: shipment.consigneeAddress,
              city: shipment.consigneeCity.name,
              pincode: shipment.consigneePincode,
              gstin: shipment.consigneeGstin,
            },
          ].map((party) => (
            <div key={party.title} className="flex flex-col gap-0.5">
              <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                {party.title}
              </p>
              <p className="font-semibold">{party.name}</p>
              {party.company && <p>{party.company}</p>}
              <p>{party.address}</p>
              <p>
                {party.city} — <span className="font-mono">{party.pincode}</span>
              </p>
              <p className="font-mono text-xs">{party.phone}</p>
              {party.gstin && (
                <p className="font-mono text-xs">GSTIN {party.gstin}</p>
              )}
            </div>
          ))}
        </section>

        {/* Consignment detail */}
        <section className="grid grid-cols-3 gap-x-6 gap-y-1.5 border-b py-4">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
                {label}
              </span>
              <span className="font-medium tabular">{value}</span>
            </div>
          ))}
        </section>

        <section className="border-b py-4">
          <p className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
            Said to contain
          </p>
          <p className="font-medium">{shipment.goodsDescription}</p>
          {shipment.specialInstructions && (
            <p className="mt-1 text-xs">
              <span className="font-semibold">Instructions: </span>
              {shipment.specialInstructions}
            </p>
          )}
        </section>

        {/* Charges */}
        <section className="grid grid-cols-2 gap-6 border-b py-4">
          <div>
            <p className="mb-1.5 font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              Charges
            </p>
            {shipment.charges.length === 0 ? (
              <p className="text-xs text-muted-foreground">To be advised</p>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {shipment.charges.map((charge) => (
                    <tr key={charge.id}>
                      <td className="py-0.5">{charge.chargeType.name}</td>
                      <td className="py-0.5 text-right tabular">
                        ₹{Number(charge.amount).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t">
                    <td className="py-0.5">Tax</td>
                    <td className="py-0.5 text-right tabular">
                      ₹{Number(shipment.taxAmount).toFixed(2)}
                    </td>
                  </tr>
                  <tr className="border-t font-semibold">
                    <td className="py-1">Total</td>
                    <td className="py-1 text-right tabular">
                      ₹{Number(shipment.grandTotal).toFixed(2)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              Payment
            </p>
            <p className="text-base font-bold">
              {shipment.paymentType.replace("_", "-")}
            </p>
            {shipment.paymentType === "COD" && (
              <p className="text-base font-bold">
                Collect ₹{Number(shipment.codAmount ?? 0).toLocaleString("en-IN")}
              </p>
            )}
            {shipment.isReverseCharge && (
              <p className="mt-1 text-xs">
                GST payable by recipient under reverse charge (GTA service).
              </p>
            )}
          </div>
        </section>

        {/* Signatures */}
        <section className="grid grid-cols-3 gap-6 pt-10">
          {["Consignor signature", "Booking clerk", "Received in good order"].map(
            (label) => (
              <div key={label} className="flex flex-col gap-1">
                <div className="h-10 border-b border-foreground" />
                <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
                  {label}
                </span>
              </div>
            ),
          )}
        </section>

        <p className="mt-6 text-[0.6rem] leading-snug text-muted-foreground">
          Goods are carried at owner&rsquo;s risk unless insured. Claims must be
          notified in writing within 7 days of delivery. This consignment note
          is issued subject to the carrier&rsquo;s standard terms.
        </p>
      </article>

      {/* Package labels */}
      <section className="mx-auto mt-8 max-w-3xl">
        <h2 className="no-print mb-3 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Package labels — {shipment.packages.length}
        </h2>

        <div className="grid grid-cols-2 gap-4">
          {shipment.packages.map((pkg) => (
            <div
              key={pkg.id}
              className="label-card flex flex-col gap-2 rounded-lg border-2 border-foreground p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[0.55rem] uppercase tracking-[0.14em] text-muted-foreground">
                    {org.name}
                  </p>
                  <p className="font-mono text-base font-bold">
                    {shipment.lrNumber}
                  </p>
                </div>
                <p className="text-right font-mono text-2xl font-bold">
                  {pkg.sequence}
                  <span className="text-sm font-normal text-muted-foreground">
                    /{shipment.packageCount}
                  </span>
                </p>
              </div>

              <p className="font-mono text-3xl font-bold leading-none tracking-tight">
                {shipment.destinationBranch.code}
              </p>
              <p className="text-xs">
                {shipment.consigneeName} · {shipment.consigneeCity.name}{" "}
                <span className="font-mono">{shipment.consigneePincode}</span>
              </p>

              <p className="mt-1 border-t pt-2 text-center font-mono text-sm font-semibold tracking-wider">
                {pkg.barcode}
              </p>

              <div className="flex gap-1.5">
                {shipment.isFragile && (
                  <span className="rounded-sm border border-foreground px-1.5 py-0.5 font-mono text-[0.55rem] font-bold uppercase tracking-wider">
                    Fragile
                  </span>
                )}
                {shipment.paymentType === "COD" && (
                  <span className="rounded-sm border border-foreground px-1.5 py-0.5 font-mono text-[0.55rem] font-bold uppercase tracking-wider">
                    COD ₹{Number(shipment.codAmount ?? 0)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <p className="no-print mt-4 max-w-prose text-xs text-muted-foreground">
          Labels currently carry the barcode number as text. Scannable Code128
          and direct thermal output (ZPL/TSPL) arrive in Phase 3, alongside the
          scanner and printer selection — a barcode that has never been tested
          against real hardware is worse than none, because it looks like it
          works.
        </p>
      </section>
    </>
  );
}
