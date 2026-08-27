import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { prisma } from "@/lib/prisma";
import { canWrite, requireCustomerUser } from "@/lib/auth/customer-session";
import { customerOwnedFilter } from "@/lib/portal/visibility";
import { listPortalPickups } from "@/lib/portal/pickups";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PickupForm } from "./pickup-form";
import { CancelPickupButton } from "./cancel-button";

export const metadata: Metadata = {
  title: "Pickups",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  REQUESTED: "bg-muted text-muted-foreground",
  ASSIGNED: "bg-info-muted text-info",
  IN_PROGRESS: "bg-warn-muted text-warn",
  COMPLETED: "bg-ok-muted text-ok",
  FAILED: "bg-bad-muted text-bad",
  CANCELLED: "bg-bad-muted text-bad",
};

export default async function PortalPickupsPage() {
  const session = await requireCustomerUser();
  const mayRequest = canWrite(session);

  const [pickups, addresses] = await Promise.all([
    listPortalPickups(session),
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
        pincode: true,
        isDefault: true,
        city: { select: { name: true } },
      },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Pickups"
        description="Ask us to collect from any of your saved addresses. You do not need to know what you are shipping yet."
      />

      {mayRequest && (
        <section className="mb-8 flex flex-col gap-3">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Request a collection
          </h2>
          {addresses.length === 0 ? (
            <p className="rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-sm text-warn">
              Add a pickup address first —{" "}
              <Link
                href="/portal/addresses"
                className="underline underline-offset-4"
              >
                Saved addresses
              </Link>
              .
            </p>
          ) : (
            <PickupForm
              addresses={addresses.map((address) => ({
                id: address.id,
                label: address.label,
                cityName: address.city.name,
                pincode: address.pincode,
                isDefault: address.isDefault,
              }))}
            />
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Your requests
        </h2>

        {pickups.length === 0 ? (
          <TableFrame>
            <EmptyState
              title="No pickup requests"
              description="Requests you raise will be listed here with their status."
            />
          </TableFrame>
        ) : (
          <TableFrame>
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Wanted</TableHead>
                  <TableHead>Slot</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead className="text-right">Pkgs</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pickups.map((pickup) => (
                  <TableRow key={pickup.id}>
                    <TableCell className="font-mono text-xs font-medium">
                      {pickup.number}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular">
                      {format(pickup.requestedDate, "dd MMM yy")}
                    </TableCell>
                    <TableCell className="text-sm capitalize">
                      {pickup.slot.toLowerCase()}
                    </TableCell>
                    <TableCell className="text-sm">
                      {pickup.cityName}{" "}
                      <span className="font-mono text-xs text-muted-foreground">
                        {pickup.pincode}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {pickup.expectedPackages ?? "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-block rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider",
                          STATUS_TONE[pickup.status] ??
                            "bg-muted text-muted-foreground",
                        )}
                      >
                        {pickup.status.replace("_", " ")}
                      </span>
                    </TableCell>
                    <TableCell>
                      {mayRequest &&
                        (pickup.status === "REQUESTED" ||
                          pickup.status === "ASSIGNED") && (
                          <CancelPickupButton id={pickup.id} />
                        )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        )}
      </section>
    </>
  );
}
