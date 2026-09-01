import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { TriangleAlert } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requirePermission, can } from "@/lib/auth/session";
import { branchScope } from "@/server/repositories/scope";
import { agentCodPositions } from "@/lib/delivery/cod";
import {
  fromStoredDate,
  shiftStoredDay,
  storedDayFromYmd,
  storedIsoDay,
  storedToday,
} from "@/lib/delivery/calendar";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame, EmptyState } from "@/components/data/data-shell";
import { DepositForm, VerifyForm } from "./deposit-form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "COD day end" };
export const dynamic = "force-dynamic";

/**
 * The day being counted, as `CodDeposit.depositDate` stores it.
 *
 * A `@db.Date` column keeps the UTC calendar day. Built from local midnight
 * this page asked for the day before the one in its own heading, and — far
 * worse — wrote deposits under it. See `lib/delivery/calendar.ts`.
 */
function calendarDay(value: string | undefined): Date {
  return (value ? storedDayFromYmd(value) : null) ?? storedToday();
}

const rupees = (value: number) => `₹${value.toLocaleString("en-IN")}`;

/**
 * Day end.
 *
 * One question: does the cash the agents took at the doors match the cash
 * on the branch table? The shortfall column is the whole screen — it is red
 * whenever it is not zero, and it sorts to the top, because a rupee
 * unaccounted for on Tuesday is unfindable by Friday.
 */
export default async function CodDayEndPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; branch?: string }>;
}) {
  // There is no `cod.read` in the catalogue and this module does not invent
  // one: seeing the day-end position is part of seeing the last mile.
  // Handing cash in and counting it are the separately-held permissions.
  const user = await requirePermission("delivery.read");
  const { date, branch } = await searchParams;
  const day = calendarDay(date);

  const branches = await prisma.branch.findMany({
    where: { isActive: true, deletedAt: null, ...branchScope(user, "id") },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });

  const branchId =
    (branch && branches.some((b) => b.id === branch) ? branch : null) ??
    user.primaryBranch?.id ??
    branches[0]?.id ??
    null;

  if (!branchId) {
    return (
      <>
        <PageHeader eyebrow="Last mile" title="COD day end" />
        <EmptyState
          title="No branch in your scope"
          description="COD is reconciled per branch. Ask an administrator to assign you one."
        />
      </>
    );
  }

  const [positions, deposits] = await Promise.all([
    agentCodPositions(branchId, day, user),
    prisma.codDeposit.findMany({
      where: { branchId, depositDate: day },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        agentId: true,
        status: true,
        amountDeclared: true,
        amountVerified: true,
        shortfall: true,
        mode: true,
        reference: true,
        createdAt: true,
        verifiedAt: true,
        _count: { select: { collections: true } },
      },
    }),
  ]);

  const agentNames = new Map(positions.map((row) => [row.agentId, row.agentName]));
  const canDeposit = can(user, "cod.deposit");
  const canReconcile = can(user, "cod.reconcile");

  const previous = shiftStoredDay(day, -1);
  const next = shiftStoredDay(day, 1);

  const totalShortfall = positions.reduce(
    (sum, row) => sum + Number(row.shortfall),
    0,
  );

  return (
    <>
      <PageHeader
        eyebrow="Last mile"
        title="COD day end"
        description="What the agents took at the doors against what has reached the branch. Cash deposits post to the branch cash account; digital collections reconcile against the gateway settlement file."
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg border bg-card p-1">
          <Link
            href={`/delivery/cod?date=${storedIsoDay(previous)}&branch=${branchId}`}
            className="rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ←
          </Link>
          <span className="px-2 font-mono text-xs font-medium tabular">
            {format(fromStoredDate(day), "EEE dd MMM yyyy")}
          </span>
          <Link
            href={`/delivery/cod?date=${storedIsoDay(next)}&branch=${branchId}`}
            className="rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            →
          </Link>
        </div>

        {branches.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {branches.map((option) => (
              <Link
                key={option.id}
                href={`/delivery/cod?date=${storedIsoDay(day)}&branch=${option.id}`}
                className={`rounded-md border px-2.5 py-1 font-mono text-xs ${
                  option.id === branchId
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-card hover:bg-muted"
                }`}
              >
                {option.code}
              </Link>
            ))}
          </div>
        )}

        {totalShortfall !== 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-bad-muted px-2.5 py-1 text-xs font-medium text-bad">
            <TriangleAlert className="size-3.5" />
            {rupees(totalShortfall)} outstanding across {positions.filter((p) => Number(p.shortfall) !== 0).length}{" "}
            agent(s)
          </span>
        )}

        <Link
          href="/delivery/runs"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Delivery runs →
        </Link>
      </div>

      <TableFrame>
        {positions.length === 0 ? (
          <EmptyState
            title="Nothing collected on this date"
            description="No COD shipments were delivered out of this branch that day."
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Runs</TableHead>
                <TableHead className="text-right">Stops paid</TableHead>
                <TableHead className="text-right">Due</TableHead>
                <TableHead className="text-right">Collected</TableHead>
                <TableHead className="text-right">Deposited</TableHead>
                <TableHead className="text-right">Counted</TableHead>
                <TableHead className="text-right">Shortfall</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.map((row) => {
                const shortfall = Number(row.shortfall);
                const collected = Number(row.collected);

                return (
                  <TableRow key={row.agentId}>
                    <TableCell className="font-medium">{row.agentName}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.runNumbers.join(", ") || "—"}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {row.collectionCount}
                    </TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">
                      {rupees(Number(row.expected))}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {rupees(collected)}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {rupees(Number(row.deposited))}
                    </TableCell>
                    {/* What the branch actually counted. It was computed and
                        never shown, so a deposit counted short looked
                        identical to one counted in full. */}
                    <TableCell className="text-right tabular text-muted-foreground">
                      {row.countedDeposits === 0
                        ? "not counted"
                        : rupees(Number(row.verified))}
                    </TableCell>
                    <TableCell className="text-right">
                      {shortfall === 0 ? (
                        <span className="tabular text-ok">₹0</span>
                      ) : (
                        <span className="font-semibold tabular text-bad">
                          {rupees(shortfall)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {canDeposit && row.undepositedIds.length > 0 && (
                        <DepositForm
                          branchId={branchId}
                          agentId={row.agentId}
                          agentName={row.agentName}
                          depositDate={storedIsoDay(day)}
                          collected={shortfall > 0 ? shortfall : collected}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableFrame>

      <section className="mt-8 flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Deposits on this date
        </h2>

        <TableFrame>
          {deposits.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">
              Nothing has been handed in yet.
            </p>
          ) : (
            <Table className="min-w-[820px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Shipments</TableHead>
                  <TableHead className="text-right">Declared</TableHead>
                  <TableHead className="text-right">Counted</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {deposits.map((deposit) => (
                  <TableRow key={deposit.id}>
                    <TableCell className="font-medium">
                      {agentNames.get(deposit.agentId) ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular">
                      {format(deposit.createdAt, "dd MMM HH:mm")}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {deposit.mode.replace("_", " ")}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {deposit.reference ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {deposit._count.collections}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {rupees(Number(deposit.amountDeclared))}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {deposit.amountVerified
                        ? rupees(Number(deposit.amountVerified))
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-block rounded-sm px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wider ${
                          deposit.status === "VERIFIED"
                            ? "bg-ok-muted text-ok"
                            : deposit.status === "DISPUTED"
                              ? "bg-bad-muted text-bad"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {deposit.status}
                      </span>
                      {Number(deposit.shortfall) !== 0 && (
                        <span className="ml-1.5 font-mono text-[0.6rem] font-semibold text-bad">
                          {rupees(Number(deposit.shortfall))}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {canReconcile && deposit.status === "PENDING" && (
                        <VerifyForm
                          depositId={deposit.id}
                          agentName={agentNames.get(deposit.agentId) ?? "the agent"}
                          declared={Number(deposit.amountDeclared)}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableFrame>

        <p className="max-w-prose text-xs text-muted-foreground">
          States run <span className="font-mono">COLLECTED → DEPOSITED → RECONCILED → REMITTED</span>.
          A deposit that counts short stays disputed and its collections stay
          at <span className="font-mono">DEPOSITED</span> until somebody
          resolves it. Remittance to the customer runs on their contracted
          cycle and arrives with billing in Phase 6.
        </p>
      </section>
    </>
  );
}
