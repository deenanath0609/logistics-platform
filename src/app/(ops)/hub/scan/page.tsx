import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { requireUser, can, canAny } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { PageHeader } from "@/components/shell/page-header";
import { ScanConsole, type ScanTypeOption } from "./scan-console";

export const metadata: Metadata = { title: "Scan console" };
export const dynamic = "force-dynamic";

/**
 * The dock screen.
 *
 * Guarded on holding *any* of the five permissions its modes need, not on
 * `scan.inbound`. `scan.inbound` is not the least privileged thing this
 * console does, it is simply one of them — and gating on it locked the
 * dispatch manager out of the only screen in the product that offers an
 * outbound scan, which is a permission their role is granted and could
 * not use anywhere. Each mode is still offered only to somebody who holds
 * its own permission, and the server action re-checks before writing.
 */
const ALL_MODES: Array<ScanTypeOption & { permission: string }> = [
  {
    value: "INBOUND",
    label: "Inbound",
    hint: "Receiving freight off a vehicle. Moves the consignment to received at this branch.",
    permission: "scan.inbound",
  },
  {
    value: "SORT",
    label: "Sort",
    hint: "Routing a package to a bin after receipt. Moves it to processed.",
    permission: "scan.sort",
  },
  {
    value: "LOAD",
    label: "Load",
    hint: "Putting a package on a vehicle against a loading sheet.",
    permission: "loading.execute",
  },
  {
    value: "OUTBOUND",
    label: "Outbound",
    hint: "A dock record of freight leaving. Dispatch itself happens at gate-out on the trip.",
    permission: "scan.outbound",
  },
  {
    value: "UNLOAD",
    label: "Unload",
    hint: "Taking a package off a vehicle at this branch.",
    permission: "scan.inbound",
  },
  {
    value: "AUDIT",
    label: "Stock audit",
    hint: "Counting what is physically here. Records the sighting and moves nothing.",
    permission: "scan.inbound",
  },
];

export default async function ScanPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const user = await requireUser();
  if (!canAny(user, [...new Set(ALL_MODES.map((mode) => mode.permission))])) {
    redirect("/forbidden");
  }

  const { branch: branchParam } = await searchParams;

  const branches = await prisma.branch.findMany({
    where: { deletedAt: null, isActive: true, ...branchScope(user, "id") },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });

  // A network-scoped user has no implicit dock. Make them pick rather than
  // guessing a branch and writing scans against the wrong one.
  const branch =
    branches.find((b) => b.id === branchParam) ??
    branches.find((b) => b.id === user.primaryBranch?.id) ??
    (branches.length === 1 ? branches[0] : null);

  // Each mode is offered only to a user who holds its permission. The
  // permission field is stripped rather than passed to the client, which
  // has no use for it and no business enforcing it.
  const modes: ScanTypeOption[] = ALL_MODES.filter((mode) =>
    can(user, mode.permission),
  ).map((mode) => ({ value: mode.value, label: mode.label, hint: mode.hint }));

  const bins = branch
    ? await prisma.sortBin.findMany({
        where: { branchId: branch.id, isActive: true },
        orderBy: { code: "asc" },
        select: { id: true, code: true, name: true },
      })
    : [];

  return (
    <>
      <Link
        href="/hub"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Branch floor
      </Link>

      <PageHeader
        eyebrow={branch ? `${branch.code} · dock` : "Hub operations"}
        title="Scan console"
        description="Point the gun and pull. Each read is written the moment it lands, and the consignment's status follows from it — nobody types a status here."
      />

      {!branch ? (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="font-medium">Choose a dock</h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Scans are written against a branch, so pick the one you are
            standing in before you start.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {branches.map((b) => (
              <Link
                key={b.id}
                href={`/hub/scan?branch=${b.id}`}
                className="rounded-lg border bg-background px-3 py-2 text-sm hover:bg-muted"
              >
                <span className="font-mono text-xs">{b.code}</span>
                <span className="ml-2 text-muted-foreground">{b.name}</span>
              </Link>
            ))}
            {branches.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No branch is assigned to you. Ask an administrator to set your
                primary branch.
              </p>
            )}
          </div>
        </div>
      ) : modes.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          Your role has no scanning permissions.
        </p>
      ) : (
        <ScanConsole
          branchId={branch.id}
          branchLabel={`${branch.code} — ${branch.name}`}
          scanTypes={modes}
          bins={bins}
        />
      )}
    </>
  );
}
