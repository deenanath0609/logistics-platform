import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft, MapPin, Star } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { coversBranch } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { MasterFormDialog, type FieldDef } from "@/components/data/master-form";
import { StatusPill } from "@/components/shipment/status-pill";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { updateCustomer, saveCustomerAddress } from "../actions";
import { buildCustomerFields } from "../page";

export const metadata: Metadata = { title: "Customer" };
export const dynamic = "force-dynamic";

function addressFields(
  customerId: string,
  cities: Array<{ value: string; label: string }>,
): FieldDef[] {
  return [
    { type: "text", name: "label", label: "Label", required: true, half: true, placeholder: "Factory gate" },
    {
      type: "select",
      name: "kind",
      label: "Used for",
      required: true,
      half: true,
      options: [
        { value: "PICKUP", label: "Pickup" },
        { value: "DELIVERY", label: "Delivery" },
        { value: "BILLING", label: "Billing" },
      ],
    },
    { type: "text", name: "contactName", label: "Contact name", half: true },
    { type: "text", name: "phone", label: "Contact phone", half: true, mono: true },
    { type: "textarea", name: "address", label: "Address", required: true },
    { type: "select", name: "cityId", label: "City", required: true, half: true, options: cities },
    { type: "text", name: "pincode", label: "PIN code", required: true, half: true, mono: true },
    { type: "text", name: "landmark", label: "Landmark" },
    {
      type: "switch",
      name: "isDefault",
      label: "Default for this purpose",
      help: "Pre-selected on the booking screen.",
    },
    // Carried through the form rather than the URL so the action has it.
    { type: "text", name: "customerId", label: "customerId", half: true },
  ];
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("customer.read");
  const writable = can(user, "customer.update");
  const canSetCredit = can(user, "customer.manage_credit");
  const { id } = await params;

  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      branch: { select: { code: true, name: true } },
      billingCity: { select: { name: true } },
      addresses: {
        where: { isActive: true },
        orderBy: [{ isDefault: "desc" }, { label: "asc" }],
        include: { city: { select: { name: true, code: true } } },
      },
      contacts: { orderBy: [{ isPrimary: "desc" }, { name: "asc" }] },
    },
  });

  if (!customer || customer.deletedAt) notFound();
  if (customer.branchId && !coversBranch(user, customer.branchId)) notFound();

  const [shipments, cities, branches] = await Promise.all([
    prisma.shipment.findMany({
      where: { consignorId: id, deletedAt: null },
      orderBy: { bookedAt: "desc" },
      take: 10,
      select: {
        id: true,
        lrNumber: true,
        currentStatus: true,
        bookedAt: true,
        consigneeName: true,
        packageCount: true,
        chargeableWeight: true,
        grandTotal: true,
        destinationBranch: { select: { code: true } },
      },
    }),
    prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    }),
    prisma.branch.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const cityOptions = cities.map((c) => ({
    value: c.id,
    label: `${c.name} (${c.code})`,
  }));

  const stats = [
    { label: "Account", value: customer.code, mono: true },
    { label: "Type", value: customer.type.replace("_", " ") },
    { label: "Terms", value: customer.paymentTerm },
    { label: "Addresses", value: String(customer.addresses.length) },
    { label: "Shipments", value: String(shipments.length) },
  ];

  return (
    <>
      <Link
        href="/customers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All customers
      </Link>

      <PageHeader
        eyebrow="Customer"
        title={customer.name}
        description={customer.legalName ?? undefined}
        actions={
          writable && (
            <MasterFormDialog
              title={`Edit ${customer.code}`}
              fields={buildCustomerFields(cityOptions, branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })), canSetCredit)}
              action={updateCustomer}
              record={customer as unknown as Record<string, unknown>}
              trigger={{ label: "Edit customer", icon: "pencil", variant: "outline" }}
            />
          )
        }
      />

      <div className="mb-8 flex flex-wrap gap-3">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="flex items-baseline gap-2 rounded-md border bg-card px-3 py-1.5"
          >
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              {stat.label}
            </span>
            <span
              className={`text-sm font-semibold tabular ${stat.mono ? "font-mono" : ""}`}
            >
              {stat.value}
            </span>
          </div>
        ))}
        {customer.gstin && (
          <div className="flex items-baseline gap-2 rounded-md border bg-card px-3 py-1.5">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
              GSTIN
            </span>
            <span className="font-mono text-sm font-semibold">{customer.gstin}</span>
          </div>
        )}
      </div>

      {/* ── Addresses ─────────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Saved addresses
          </h2>
          {writable && (
            <MasterFormDialog
              title="New address"
              description="Saved addresses turn booking into a two-field job."
              fields={addressFields(customer.id, cityOptions)}
              action={saveCustomerAddress}
              record={{ customerId: customer.id, kind: "PICKUP" }}
              submitLabel="Add address"
              trigger={{ label: "Add address", icon: "plus", variant: "outline", size: "sm" }}
            />
          )}
        </div>

        {customer.addresses.length === 0 ? (
          <TableFrame>
            <EmptyState
              title="No saved addresses"
              description="Add the pickup point you collect from most often."
            />
          </TableFrame>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {customer.addresses.map((address) => (
              <div
                key={address.id}
                className="flex flex-col gap-1.5 rounded-lg border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-medium">
                    {address.isDefault && (
                      <Star className="size-3.5 fill-warn text-warn" aria-label="Default" />
                    )}
                    {address.label}
                  </span>
                  <Badge variant="secondary" className="text-[0.6rem]">
                    {address.kind}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{address.address}</p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <MapPin className="size-3" />
                  {address.city.name}
                  <span className="font-mono">{address.pincode}</span>
                </p>
                {address.contactName && (
                  <p className="text-xs text-muted-foreground">
                    {address.contactName}
                    {address.phone && (
                      <span className="ml-1.5 font-mono">{address.phone}</span>
                    )}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Recent shipments ──────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Recent shipments
        </h2>

        <TableFrame>
          {shipments.length === 0 ? (
            <EmptyState
              title="Nothing booked yet"
              description="Shipments booked against this account will appear here."
            />
          ) : (
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>LR number</TableHead>
                  <TableHead>Booked</TableHead>
                  <TableHead>Consignee</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead className="text-right">Pkgs</TableHead>
                  <TableHead className="text-right">Weight</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shipments.map((shipment) => (
                  <TableRow key={shipment.id}>
                    <TableCell>
                      <Link
                        href={`/shipments/${shipment.id}`}
                        className="font-mono text-xs font-medium hover:underline"
                      >
                        {shipment.lrNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular">
                      {format(shipment.bookedAt, "dd MMM")}
                    </TableCell>
                    <TableCell className="text-sm">{shipment.consigneeName}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {shipment.destinationBranch.code}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {shipment.packageCount}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {Number(shipment.chargeableWeight)} kg
                    </TableCell>
                    <TableCell className="text-right tabular">
                      ₹{Number(shipment.grandTotal).toLocaleString("en-IN")}
                    </TableCell>
                    <TableCell>
                      <StatusPill status={shipment.currentStatus} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableFrame>
      </section>
    </>
  );
}
