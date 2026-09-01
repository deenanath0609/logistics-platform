import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/session";
import { ruleFor } from "@/lib/shipment/state-machine";
import { anyBranchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { SearchInput } from "@/components/data/search-input";
import { WeighForm } from "./weigh-form";

export const metadata: Metadata = { title: "Weighment" };
export const dynamic = "force-dynamic";

export default async function WeighPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requirePermission("weight.capture");
  const { q } = await searchParams;

  // Only what the state machine will actually accept a weighing from.
  // Listing a consignment that is still out for pickup invites a clerk to
  // weigh air, and the refusal would arrive after they had typed a number.
  const weighable = ruleFor("WEIGHT_CAPTURED")?.from ?? [];

  const shipments = await prisma.shipment.findMany({
    where: {
      deletedAt: null,
      cancelledAt: null,
      currentStatus: { in: weighable },
      // Both of these produce an `OR`, and two `OR` keys cannot share one
      // object — the second silently replaces the first. Spread side by
      // side, as they were, the branch filter vanished the moment anybody
      // typed in the search box, and this list answered from the whole
      // network. `AND` is a list, so both survive. The same fault was found
      // and fixed on `/shipments`; its docblock explains it in full.
      AND: [
        anyBranchScope(user, [
          "originBranchId",
          "currentBranchId",
          "destinationBranchId",
        ]),
        ...(q
          ? [
              {
                OR: [
                  { lrNumber: { contains: q, mode: "insensitive" as const } },
                  { consigneeName: { contains: q, mode: "insensitive" as const } },
                  { consignorName: { contains: q, mode: "insensitive" as const } },
                ],
              },
            ]
          : []),
      ],
    },
    orderBy: { bookedAt: "desc" },
    take: 25,
    select: {
      id: true,
      lrNumber: true,
      consignorName: true,
      consigneeName: true,
      packageCount: true,
      actualWeight: true,
      chargeableWeight: true,
      grandTotal: true,
      currentStatus: true,
    },
  });

  return (
    <>
      <PageHeader
        eyebrow={`Hub · ${user.primaryBranch?.code ?? "unassigned"}`}
        title="Weighment"
        description="What the scale reads is what bills. A consignment booked on a declared weight is repriced here, and the consignor is told when the increase is past tolerance. Only consignments already received at a branch or hub appear."
        actions={<SearchInput placeholder="LR number or name" />}
      />

      <WeighForm
        shipments={shipments.map((s) => ({
          ...s,
          actualWeight: String(s.actualWeight),
          chargeableWeight: String(s.chargeableWeight),
          grandTotal: Number(s.grandTotal).toLocaleString("en-IN"),
        }))}
        branchId={user.primaryBranch?.id ?? null}
        branchCode={user.primaryBranch?.code ?? null}
      />
    </>
  );
}
