import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { can, requirePermission } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { BookingForm } from "./booking-form";

export const metadata: Metadata = { title: "New booking" };
export const dynamic = "force-dynamic";

export default async function NewBookingPage() {
  const user = await requirePermission("shipment.create");

  const [services, branches, cities, packageTypes, chargeTypes, customers] =
    await Promise.all([
      prisma.serviceType.findMany({
        where: { isActive: true },
        orderBy: [{ mode: "asc" }, { code: "asc" }],
        select: {
          id: true,
          code: true,
          name: true,
          mode: true,
          volumetricDivisor: true,
          allowsCod: true,
          allowsToPay: true,
        },
      }),
      prisma.branch.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: { code: "asc" },
        select: { id: true, code: true, name: true },
      }),
      prisma.city.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, code: true },
      }),
      prisma.packageType.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true },
      }),
      prisma.chargeType.findMany({
        where: { isActive: true, isCustomerVisible: true },
        orderBy: { sortOrder: "asc" },
        include: { taxRate: { select: { ratePercent: true } } },
      }),
      prisma.customer.findMany({
        where: {
          isActive: true,
          isBlocked: false,
          deletedAt: null,
          ...branchScope(user, "branchId"),
        },
        orderBy: { name: "asc" },
        take: 500,
        select: {
          id: true,
          code: true,
          name: true,
          phone: true,
          gstin: true,
          addresses: {
            where: { isActive: true },
            select: {
              id: true,
              label: true,
              kind: true,
              address: true,
              cityId: true,
              pincode: true,
              contactName: true,
              phone: true,
              isDefault: true,
            },
          },
        },
      }),
    ]);

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
        eyebrow="Operations"
        title="New booking"
        description="The LR number is issued when you save, inside the same transaction as the shipment — so an abandoned form never burns one."
      />

      <BookingForm
        services={services}
        branches={branches.map((b) => ({
          value: b.id,
          label: `${b.code} — ${b.name}`,
        }))}
        cities={cities.map((c) => ({
          value: c.id,
          label: `${c.name} (${c.code})`,
        }))}
        packageTypes={packageTypes.map((p) => ({ value: p.id, label: p.name }))}
        chargeTypes={chargeTypes.map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          taxPercent: c.taxRate ? Number(c.taxRate.ratePercent) : null,
        }))}
        customers={customers}
        defaultBranchId={user.primaryBranch?.id ?? null}
        canOverrideRate={can(user, "shipment.override_rate")}
      />
    </>
  );
}
