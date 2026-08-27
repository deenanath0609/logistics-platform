import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { PincodeImportForm } from "./import-form";

export const metadata: Metadata = { title: "Import pincodes" };
export const dynamic = "force-dynamic";

export default async function PincodeImportPage() {
  await requirePermission("master.manage");

  return (
    <>
      <Link
        href="/masters/pincodes"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        All pincodes
      </Link>

      <PageHeader
        eyebrow="Network"
        title="Import pincodes"
        description="Serviceability decides whether a booking is accepted, so every row is checked before anything is written. Bad rows are named and skipped; the rest still import."
      />

      <PincodeImportForm />
    </>
  );
}
