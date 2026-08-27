import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft, Package, PauseCircle, Printer } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame } from "@/components/data/data-shell";
import { StatusPill } from "@/components/shipment/status-pill";
import { ShipmentTimeline } from "@/components/shipment/timeline";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Shipment" };
export const dynamic = "force-dynamic";

function Party({
  title,
  name,
  company,
  phone,
  email,
  address,
  city,
  pincode,
  landmark,
  gstin,
}: {
  title: string;
  name: string;
  company?: string | null;
  phone: string;
  email?: string | null;
  address: string;
  city: string;
  pincode: string;
  landmark?: string | null;
  gstin?: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <p className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </p>
      <p className="font-medium">{name}</p>
      {company && <p className="text-sm text-muted-foreground">{company}</p>}
      <p className="font-mono text-xs">{phone}</p>
      {email && <p className="text-xs text-muted-foreground">{email}</p>}
      <p className="mt-1 text-sm text-muted-foreground">{address}</p>
      <p className="text-sm text-muted-foreground">
        {city} <span className="font-mono">{pincode}</span>
      </p>
      {landmark && (
        <p className="text-xs text-muted-foreground">Near {landmark}</p>
      )}
      {gstin && (
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          GSTIN {gstin}
        </p>
      )}
    </div>
  );
}

export default async function ShipmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("shipment.read");
  const { id } = await params;

  const shipment = await prisma.shipment.findUnique({
    where: { id },
    include: {
      serviceType: { select: { code: true, name: true, mode: true } },
      packageType: { select: { name: true } },
      originBranch: { select: { code: true, name: true } },
      destinationBranch: { select: { code: true, name: true } },
      currentBranch: { select: { code: true, name: true } },
      bookingBranch: { select: { code: true } },
      consignorCity: { select: { name: true } },
      consigneeCity: { select: { name: true } },
      consignor: { select: { id: true, code: true, name: true } },
      bookedBy: { select: { name: true } },
      holdReason: { select: { code: true, name: true } },
      cancelReason: { select: { code: true, name: true } },
      packages: { orderBy: { sequence: "asc" } },
      charges: {
        orderBy: { sortOrder: "asc" },
        include: { chargeType: { select: { code: true, name: true } } },
      },
      events: {
        orderBy: [{ occurredAt: "asc" }, { recordedAt: "asc" }],
        include: {
          branch: { select: { code: true, name: true } },
          user: { select: { name: true } },
          reasonCode: { select: { code: true, name: true } },
          package: { select: { barcode: true } },
        },
      },
    },
  });

  if (!shipment || shipment.deletedAt) notFound();

  const canPrint = can(user, "shipment.print");

  const facts = [
    { label: "Service", value: `${shipment.serviceType.code}` },
    { label: "Mode", value: shipment.mode },
    { label: "Booked", value: format(shipment.bookedAt, "dd MMM yyyy HH:mm") },
    { label: "By", value: shipment.bookedBy?.name ?? "—" },
    { label: "At", value: shipment.currentBranch?.code ?? "Not yet in network" },
  ];

  return (
    <>
      <Link
        href="/shipments"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All shipments
      </Link>

      <PageHeader
        eyebrow={`${shipment.originBranch.code} → ${shipment.destinationBranch.code}`}
        title={shipment.lrNumber}
        description={shipment.goodsDescription}
        actions={
          canPrint && (
            <Button variant="outline" render={<Link href={`/shipments/${shipment.id}/print`} />}>
              <Printer />
              Print LR &amp; labels
            </Button>
          )
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <StatusPill status={shipment.currentStatus} className="text-[0.7rem]" />
        <span className="text-xs text-muted-foreground">
          since {format(shipment.statusUpdatedAt, "dd MMM HH:mm")}
        </span>
        {shipment.isOnHold && (
          <span className="inline-flex items-center gap-1 rounded-sm bg-bad-muted px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-bad">
            <PauseCircle className="size-3" />
            On hold{shipment.holdReason ? ` — ${shipment.holdReason.name}` : ""}
          </span>
        )}
        {shipment.attemptCount > 0 && (
          <span className="rounded-sm bg-warn-muted px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-warn">
            {shipment.attemptCount} failed attempt
            {shipment.attemptCount > 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div className="mb-8 flex flex-wrap gap-3">
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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-8">
          {/* Parties */}
          <section className="grid gap-3 sm:grid-cols-2">
            <Party
              title="Consignor"
              name={shipment.consignorName}
              company={shipment.consignorCompany}
              phone={shipment.consignorPhone}
              email={shipment.consignorEmail}
              address={shipment.consignorAddress}
              city={shipment.consignorCity.name}
              pincode={shipment.consignorPincode}
              gstin={shipment.consignorGstin}
            />
            <Party
              title="Consignee"
              name={shipment.consigneeName}
              company={shipment.consigneeCompany}
              phone={shipment.consigneePhone}
              email={shipment.consigneeEmail}
              address={shipment.consigneeAddress}
              city={shipment.consigneeCity.name}
              pincode={shipment.consigneePincode}
              landmark={shipment.consigneeLandmark}
              gstin={shipment.consigneeGstin}
            />
          </section>

          {/* Packages */}
          <section className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              <Package className="size-3.5" />
              Packages — {shipment.packages.length}
            </h2>
            <TableFrame>
              <Table className="min-w-[620px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead className="text-right">Weight</TableHead>
                    <TableHead className="text-right">Dimensions (cm)</TableHead>
                    <TableHead>Contents</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shipment.packages.map((pkg) => (
                    <TableRow key={pkg.id}>
                      <TableCell className="tabular text-muted-foreground">
                        {pkg.sequence}
                      </TableCell>
                      <TableCell className="font-mono text-xs font-medium">
                        {pkg.barcode}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {pkg.weight ? `${Number(pkg.weight)} kg` : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular text-muted-foreground">
                        {pkg.lengthCm && pkg.breadthCm && pkg.heightCm
                          ? `${Number(pkg.lengthCm)}×${Number(pkg.breadthCm)}×${Number(pkg.heightCm)}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {pkg.contents ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                        {pkg.status.replace("_", " ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
          </section>

          {/* Timeline */}
          <section className="flex flex-col gap-4">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              Chain of custody — {shipment.events.length} events
            </h2>
            <div className="rounded-lg border bg-card p-5">
              <ShipmentTimeline events={shipment.events} />
            </div>
            <p className="max-w-prose text-xs text-muted-foreground">
              This log is append-only and enforced by the database. A
              correction is a new entry carrying a reason, never an edit to
              what is already here.
            </p>
          </section>
        </div>

        {/* Sidebar */}
        <aside className="flex flex-col gap-6">
          <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Goods
            </h2>
            <dl className="flex flex-col gap-2 text-sm">
              {[
                ["Packages", String(shipment.packageCount)],
                ["Package type", shipment.packageType?.name ?? "—"],
                ["Actual weight", `${Number(shipment.actualWeight)} kg`],
                [
                  "Volumetric",
                  shipment.volumetricWeight
                    ? `${Number(shipment.volumetricWeight)} kg`
                    : "—",
                ],
                ["Chargeable", `${Number(shipment.chargeableWeight)} kg`],
                [
                  "Declared value",
                  shipment.declaredValue
                    ? `₹${Number(shipment.declaredValue).toLocaleString("en-IN")}`
                    : "—",
                ],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium tabular">{value}</dd>
                </div>
              ))}
            </dl>
            {shipment.specialInstructions && (
              <p className="rounded-md bg-warn-muted px-2.5 py-2 text-xs text-warn">
                {shipment.specialInstructions}
              </p>
            )}
          </section>

          <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              Charges
            </h2>
            {shipment.charges.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No charges entered. Rate cards price this automatically from
                Phase 6.
              </p>
            ) : (
              <dl className="flex flex-col gap-1.5 text-sm">
                {shipment.charges.map((charge) => (
                  <div key={charge.id} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">
                      {charge.chargeType.name}
                      {charge.isManual && (
                        <span className="ml-1 font-mono text-[0.55rem] uppercase text-warn">
                          manual
                        </span>
                      )}
                    </dt>
                    <dd className="tabular">
                      ₹{Number(charge.amount).toLocaleString("en-IN")}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <div className="flex flex-col gap-1.5 border-t pt-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Tax</span>
                <span className="tabular">
                  ₹{Number(shipment.taxAmount).toLocaleString("en-IN")}
                </span>
              </div>
              <div className="flex justify-between gap-3 font-semibold">
                <span>Total</span>
                <span className="tabular">
                  ₹{Number(shipment.grandTotal).toLocaleString("en-IN")}
                </span>
              </div>
              {shipment.isReverseCharge && (
                <p className="text-xs text-warn">
                  Reverse charge — tax payable by the recipient.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5 border-t pt-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Payment</span>
                <span className="font-medium">
                  {shipment.paymentType.replace("_", "-")}
                </span>
              </div>
              {shipment.paymentType === "COD" && (
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">To collect</span>
                  <span className="font-semibold tabular text-warn">
                    ₹{Number(shipment.codAmount ?? 0).toLocaleString("en-IN")}
                  </span>
                </div>
              )}
            </div>
          </section>

          {(shipment.customerReference ||
            shipment.ewayBillNumber ||
            shipment.invoiceNumber) && (
            <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                References
              </h2>
              <dl className="flex flex-col gap-2 text-sm">
                {shipment.customerReference && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Customer ref</dt>
                    <dd className="font-mono text-xs">
                      {shipment.customerReference}
                    </dd>
                  </div>
                )}
                {shipment.ewayBillNumber && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">E-way bill</dt>
                    <dd className="font-mono text-xs">
                      {shipment.ewayBillNumber}
                    </dd>
                  </div>
                )}
                {shipment.invoiceNumber && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Invoice</dt>
                    <dd className="font-mono text-xs">
                      {shipment.invoiceNumber}
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          {shipment.consignor && (
            <section className="rounded-lg border bg-card p-4">
              <h2 className="mb-2 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                Account
              </h2>
              <Link
                href={`/customers/${shipment.consignor.id}`}
                className="text-sm font-medium hover:underline"
              >
                {shipment.consignor.name}
              </Link>
              <p className="font-mono text-xs text-muted-foreground">
                {shipment.consignor.code}
              </p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
