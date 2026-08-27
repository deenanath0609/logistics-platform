import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { canWrite, requireCustomerUser } from "@/lib/auth/customer-session";
import {
  complainableShipments,
  PORTAL_COMPLAINT_CATEGORIES,
} from "@/lib/portal/complaints";
import { PageHeader } from "@/components/shell/page-header";
import { ComplaintForm } from "@/components/portal/complaint-form";

export const metadata: Metadata = {
  title: "Raise a complaint",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function NewComplaintPage({
  searchParams,
}: {
  searchParams: Promise<{ shipmentId?: string }>;
}) {
  const session = await requireCustomerUser();
  if (!canWrite(session)) redirect("/portal/complaints");

  const { shipmentId } = await searchParams;

  // Scoped in the data layer: the picker can only ever list this
  // account's own consignments, and the server re-checks the id anyway.
  const shipments = await complainableShipments(session);

  return (
    <>
      <Link
        href="/portal/complaints"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All complaints
      </Link>

      <PageHeader
        title="Raise a complaint"
        description="Tell us what went wrong. It goes straight to the branch responsible with a clock on it, and every reply lands back here."
      />

      <div className="max-w-2xl">
        <ComplaintForm
          categories={PORTAL_COMPLAINT_CATEGORIES.map((option) => ({
            value: option.value,
            label: option.label,
            help: option.help,
          }))}
          shipments={shipments.map((shipment) => ({
            id: shipment.id,
            lrNumber: shipment.lrNumber,
            toCity: shipment.toCity,
            bookedOn: format(shipment.bookedAt, "dd MMM"),
          }))}
          defaultShipmentId={
            shipmentId && shipments.some((s) => s.id === shipmentId)
              ? shipmentId
              : undefined
          }
        />
      </div>
    </>
  );
}
