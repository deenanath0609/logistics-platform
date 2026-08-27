import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft, FileCheck2, MessageSquareWarning } from "lucide-react";
import { requireCustomerUser } from "@/lib/auth/customer-session";
import { getPortalShipment } from "@/lib/portal/queries";
import { PageHeader } from "@/components/shell/page-header";
import { PortalStatusPill } from "@/components/portal/status-pill";
import { PublicTimeline } from "@/components/portal/public-timeline";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Shipment",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * One consignment, as its consignor sees it.
 *
 * The timeline is the same customer projection the public page uses: a
 * signed-in customer is entitled to their own commercial detail, not to
 * the network's — which hub sorted it, which vehicle carried it and who
 * drove it stay internal here too.
 */
export default async function PortalShipmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireCustomerUser();
  const { id } = await params;

  // Scoped in the query, not after it. A shipment belonging to another
  // account is indistinguishable from one that does not exist.
  const shipment = await getPortalShipment(session, id);
  if (!shipment) notFound();

  return (
    <>
      <Link
        href="/portal/shipments"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All shipments
      </Link>

      <PageHeader
        eyebrow={`${shipment.fromCity} → ${shipment.toCity}`}
        title={shipment.lrNumber}
        description={shipment.goodsDescription}
        actions={
          <div className="flex gap-2">
            {shipment.hasPod && (
              <Button
                variant="outline"
                render={<Link href={`/portal/shipments/${shipment.id}/pod`} />}
              >
                <FileCheck2 />
                Proof of delivery
              </Button>
            )}
            <Button
              variant="outline"
              render={
                <Link
                  href={`/portal/complaints/new?shipmentId=${shipment.id}`}
                />
              }
            >
              <MessageSquareWarning />
              Something wrong?
            </Button>
          </div>
        }
      />

      <div className="mb-8 flex flex-wrap items-center gap-2">
        <PortalStatusPill
          label={shipment.status}
          tone={shipment.tone}
          className="text-[0.7rem]"
        />
        {shipment.deliveredAt ? (
          <span className="text-xs text-muted-foreground">
            delivered {format(shipment.deliveredAt, "dd MMM yyyy · HH:mm")}
          </span>
        ) : shipment.expectedDeliveryAt ? (
          <span className="text-xs text-muted-foreground">
            expected {format(shipment.expectedDeliveryAt, "dd MMM yyyy")}
          </span>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex min-w-0 flex-col gap-4">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Progress
          </h2>
          <div className="rounded-lg border bg-card p-5">
            <PublicTimeline milestones={shipment.milestones} />
          </div>

          {shipment.hasPod && (
            <div className="flex flex-col gap-1 rounded-lg border border-ok/30 bg-ok-muted p-4 text-ok">
              <p className="text-sm font-medium">Delivered and signed for</p>
              <p className="text-sm opacity-90">
                Received by {shipment.podReceiverName}
                {shipment.podDeliveredAt
                  ? ` on ${format(shipment.podDeliveredAt, "dd MMM yyyy · HH:mm")}`
                  : ""}
                .
              </p>
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <Panel title="Consignee">
            <p className="font-medium">{shipment.consigneeName}</p>
            {shipment.consigneeCompany && (
              <p className="text-sm text-muted-foreground">
                {shipment.consigneeCompany}
              </p>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              {shipment.consigneeAddress}
            </p>
            <p className="text-sm text-muted-foreground">
              {shipment.toCity}{" "}
              <span className="font-mono">{shipment.consigneePincode}</span>
            </p>
          </Panel>

          <Panel title="Consignment">
            <Facts
              rows={[
                ["Service", shipment.serviceName],
                ["Mode", shipment.mode],
                ["Packages", String(shipment.packageCount)],
                ["Chargeable weight", `${shipment.chargeableWeight} kg`],
                [
                  "Declared value",
                  shipment.declaredValue
                    ? `₹${Number(shipment.declaredValue).toLocaleString("en-IN")}`
                    : "—",
                ],
                ["Booked", format(shipment.bookedAt, "dd MMM yyyy")],
              ]}
            />
          </Panel>

          <Panel title="Payment">
            <Facts
              rows={[
                ["Terms", shipment.paymentType.replace("_", "-")],
                ...(shipment.codAmount
                  ? ([
                      [
                        "To collect",
                        `₹${Number(shipment.codAmount).toLocaleString("en-IN")}`,
                      ],
                    ] as [string, string][])
                  : []),
                [
                  "Freight",
                  Number(shipment.grandTotal) > 0
                    ? `₹${Number(shipment.grandTotal).toLocaleString("en-IN")}`
                    : "Not yet priced",
                ],
              ]}
            />
            <p className="text-xs text-muted-foreground">
              Billed consignments appear on your{" "}
              <Link href="/portal/invoices" className="underline underline-offset-4">
                invoices
              </Link>
              .
            </p>
          </Panel>

          {(shipment.reference ||
            shipment.invoiceNumber ||
            shipment.ewayBillNumber) && (
            <Panel title="Your references">
              <Facts
                rows={[
                  ...(shipment.reference
                    ? ([["Reference", shipment.reference]] as [string, string][])
                    : []),
                  ...(shipment.invoiceNumber
                    ? ([["Invoice", shipment.invoiceNumber]] as [string, string][])
                    : []),
                  ...(shipment.ewayBillNumber
                    ? ([["E-way bill", shipment.ewayBillNumber]] as [
                        string,
                        string,
                      ][])
                    : []),
                ]}
              />
            </Panel>
          )}
        </aside>
      </div>
    </>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border bg-card p-4">
      <h2 className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="flex flex-col gap-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right font-medium tabular">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
