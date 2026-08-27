import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { canWrite, requireCustomerUser } from "@/lib/auth/customer-session";
import { customerOwnedFilter } from "@/lib/portal/visibility";
import { PageHeader } from "@/components/shell/page-header";
import { PortalBookingForm } from "./booking-form";

export const metadata: Metadata = {
  title: "Book a shipment",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function PortalBookPage() {
  const session = await requireCustomerUser();
  if (!canWrite(session)) redirect("/portal/shipments");

  const [addresses, services, cities, packageTypes] = await Promise.all([
    // Scoped by the account, not filtered afterwards.
    prisma.customerAddress.findMany({
      where: {
        ...customerOwnedFilter(session),
        isActive: true,
        kind: { in: ["PICKUP", "BILLING"] },
      },
      orderBy: [{ isDefault: "desc" }, { label: "asc" }],
      select: {
        id: true,
        label: true,
        address: true,
        pincode: true,
        contactName: true,
        phone: true,
        isDefault: true,
        city: { select: { name: true } },
      },
    }),
    prisma.serviceType.findMany({
      where: { isActive: true },
      orderBy: [{ mode: "asc" }, { code: "asc" }],
      select: {
        id: true,
        name: true,
        mode: true,
        allowsCod: true,
        allowsToPay: true,
      },
    }),
    prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.packageType.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Book a shipment"
        description={`Booked as ${session.customerName}. The collection address is one of your own — that is not something this form lets you change.`}
      />

      {addresses.length === 0 && (
        <p className="mb-6 rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-sm text-warn">
          You have no saved pickup addresses yet.{" "}
          <Link href="/portal/addresses" className="underline underline-offset-4">
            Add one
          </Link>{" "}
          and come back.
        </p>
      )}

      <PortalBookingForm
        addresses={addresses.map((address) => ({
          id: address.id,
          label: address.label,
          address: address.address,
          cityName: address.city.name,
          pincode: address.pincode,
          contactName: address.contactName,
          phone: address.phone,
          isDefault: address.isDefault,
        }))}
        services={services}
        cities={cities.map((city) => ({ value: city.id, label: city.name }))}
        packageTypes={packageTypes.map((type) => ({
          value: type.id,
          label: type.name,
        }))}
      />
    </>
  );
}
