import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { canWrite, requireCustomerUser } from "@/lib/auth/customer-session";
import { customerOwnedFilter } from "@/lib/portal/visibility";
import { PageHeader } from "@/components/shell/page-header";
import { AddressManager } from "./address-manager";

export const metadata: Metadata = {
  title: "Saved addresses",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function PortalAddressesPage() {
  const session = await requireCustomerUser();

  const [addresses, cities] = await Promise.all([
    prisma.customerAddress.findMany({
      // Account-scoped in the query. There is no second filter in the UI,
      // because there is nothing left for it to filter out.
      where: { ...customerOwnedFilter(session), isActive: true },
      orderBy: [{ isDefault: "desc" }, { kind: "asc" }, { label: "asc" }],
      select: {
        id: true,
        label: true,
        kind: true,
        contactName: true,
        phone: true,
        address: true,
        cityId: true,
        pincode: true,
        landmark: true,
        isDefault: true,
        city: { select: { name: true } },
      },
    }),
    prisma.city.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Saved addresses"
        description="Your collection and delivery points. Booking and pickup requests pick from this list."
      />

      <AddressManager
        readOnly={!canWrite(session)}
        addresses={addresses.map((address) => ({
          id: address.id,
          label: address.label,
          kind: address.kind,
          contactName: address.contactName,
          phone: address.phone,
          address: address.address,
          cityId: address.cityId,
          cityName: address.city.name,
          pincode: address.pincode,
          landmark: address.landmark,
          isDefault: address.isDefault,
        }))}
        cities={cities.map((city) => ({ value: city.id, label: city.name }))}
      />
    </>
  );
}
