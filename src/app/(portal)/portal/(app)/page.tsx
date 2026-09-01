import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Truck } from "lucide-react";
import { canWrite, requireCustomerUser } from "@/lib/auth/customer-session";
import { getPortalDashboard } from "@/lib/portal/queries";
import { PageHeader } from "@/components/shell/page-header";
import { StatCard } from "@/components/portal/stat-card";
import { PortalShipmentTable } from "@/components/portal/shipment-table";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Overview",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function PortalOverviewPage() {
  const session = await requireCustomerUser();
  const dashboard = await getPortalDashboard(session);
  const mayBook = canWrite(session);

  return (
    <>
      <PageHeader
        eyebrow={session.customerCode}
        title={`Good to see you, ${session.name.split(" ")[0]}`}
        description="Everything below is your account's traffic only."
        actions={
          mayBook && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                render={<Link href="/portal/pickups" />}
              >
                <Truck />
                Request a pickup
              </Button>
              <Button render={<Link href="/portal/book" />}>
                <Plus />
                Book a shipment
              </Button>
            </div>
          )
        }
      />

      <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/*
          `group=inFlight`, not `group=moving`: this tile counts everything
          booked and not yet finished, and `moving` is one of the four
          groups that makes up. Clicking it used to open a list shorter
          than the number on the card.
        */}
        <StatCard
          label="In flight"
          value={dashboard.inFlight}
          hint="Booked but not yet delivered"
          href="/portal/shipments?group=inFlight"
        />
        {/*
          No `href`. The list has no month filter, so `group=done` would
          open every delivery this account has ever had under a heading
          that says "this month". A tile that cannot be clicked is better
          than one that contradicts itself when it is.
        */}
        <StatCard
          label="Delivered this month"
          value={dashboard.deliveredThisMonth}
          tone="ok"
          hint="Signed for since the 1st"
        />
        <StatCard
          label="Pending POD"
          value={dashboard.pendingPod}
          tone={dashboard.pendingPod > 0 ? "warn" : "default"}
          hint="Delivered, proof still syncing"
        />
        <StatCard
          label="Outstanding"
          // Null when billing could not answer. `StatCard` renders that as
          // "coming soon" — never as ₹0, which would be a statement about
          // their money we could not stand behind.
          value={
            dashboard.outstanding === null
              ? null
              : `₹${Number(dashboard.outstanding).toLocaleString("en-IN", {
                  maximumFractionDigits: 0,
                })}`
          }
          tone={dashboard.hasOverdue ? "warn" : "default"}
          hint={dashboard.hasOverdue ? "Some of it is past due" : undefined}
          href="/portal/invoices"
        />
      </section>

      <div className="mb-8 flex flex-col gap-3">
        {dashboard.openPickups > 0 && (
          <p className="rounded-lg border border-info/30 bg-info-muted px-4 py-3 text-sm text-info">
            {dashboard.openPickups} pickup request
            {dashboard.openPickups === 1 ? "" : "s"} open.{" "}
            <Link href="/portal/pickups" className="underline underline-offset-4">
              See them
            </Link>
          </p>
        )}

        {dashboard.openComplaints > 0 && (
          <p className="rounded-lg border border-warn/30 bg-warn-muted px-4 py-3 text-sm text-warn">
            {dashboard.openComplaints} complaint
            {dashboard.openComplaints === 1 ? "" : "s"} still open.{" "}
            <Link
              href="/portal/complaints"
              className="underline underline-offset-4"
            >
              Follow them
            </Link>
          </p>
        )}
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Latest shipments
          </h2>
          <Link
            href="/portal/shipments"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            See all
          </Link>
        </div>

        <PortalShipmentTable
          rows={dashboard.recent}
          emptyTitle="Nothing booked yet"
          emptyDescription={
            mayBook
              ? "Book your first consignment and it will appear here."
              : "Once your colleagues book a consignment it will appear here."
          }
        />
      </section>
    </>
  );
}
