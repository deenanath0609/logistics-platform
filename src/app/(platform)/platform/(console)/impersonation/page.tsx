import type { Metadata } from "next";
import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import { ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, TableFrame } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listActiveGrants, recentGrants } from "@/lib/platform/impersonation";
import { requireCapability } from "@/lib/platform/session";
import { EndSessionButton } from "./end-session-button";
import { EnterSessionButton } from "./enter-session-button";

export const metadata: Metadata = { title: "Support sessions" };
export const dynamic = "force-dynamic";

/**
 * Support sessions, opened from a tenant's own page and ended from here.
 *
 * Opening one is deliberately not offered on this screen: a grant is
 * always against a named carrier, and choosing the carrier from a dropdown
 * on a page about impersonation is a worse decision than choosing it by
 * having walked to that carrier's record first.
 */
export default async function ImpersonationPage() {
  const operator = await requireCapability("impersonate");

  const [active, history] = await Promise.all([listActiveGrants(), recentGrants()]);

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Support sessions"
        description="Time-boxed grants for an operator to act inside a carrier. Open one from that carrier's page, where the reason has context."
      />

      <section className="mb-8 flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Open now</h2>

        {active.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            Nobody is inside a customer&rsquo;s data right now.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {active.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-warn/40 bg-warn-muted px-4 py-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-warn">
                    <ShieldAlert className="size-4 shrink-0" aria-hidden />
                    {grant.platformAdmin.name} in{" "}
                    {grant.org ? (
                      <Link
                        href={`/platform/tenants/${grant.org.id}`}
                        className="underline underline-offset-4"
                      >
                        {grant.org.name}
                      </Link>
                    ) : (
                      grant.orgId
                    )}
                  </p>
                  <p className="text-xs text-warn/80">{grant.reason}</p>
                  <p className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-warn/70">
                    {grant.allowWrites ? "read and write" : "read-only"} ·
                    started {format(grant.startedAt, "d MMM HH:mm")} · expires{" "}
                    {formatDistanceToNow(grant.expiresAt, { addSuffix: true })}
                    {grant.asUserId ? " · acting as a named user" : ""}
                  </p>
                </div>

                <div className="flex items-start gap-2">
                  {/* Your own session, and only yours: the audit trail is
                      only worth reading if the person inside the tenant is
                      the person the grant names. */}
                  {grant.platformAdminId === operator.id && (
                    <EnterSessionButton
                      grantId={grant.id}
                      carrierName={grant.org?.name ?? grant.orgId}
                    />
                  )}

                  <EndSessionButton
                    grantId={grant.id}
                    adminName={grant.platformAdmin.name}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h2 className="mb-3 text-sm font-semibold tracking-tight">History</h2>

      <TableFrame>
        {history.length === 0 ? (
          <EmptyState
            title="No support session has ever been opened"
            description="Every grant is recorded here and in the operator log, whether it expired on its own or was ended early."
          />
        ) : (
          <Table className="min-w-[920px]">
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Operator</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Ended</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((grant) => {
                return (
                  <TableRow key={grant.id}>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {format(grant.startedAt, "d MMM HH:mm")}
                    </TableCell>
                    <TableCell className="text-sm">
                      {grant.platformAdmin.name}
                    </TableCell>
                    <TableCell className="text-sm">
                      {grant.org ? (
                        <Link
                          href={`/platform/tenants/${grant.org.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {grant.org.name}
                        </Link>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">
                          {grant.orgId}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`rounded-4xl px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.1em] ${
                          grant.allowWrites
                            ? "bg-bad-muted text-bad"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {grant.allowWrites ? "read/write" : "read-only"}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate text-xs">
                      {grant.reason}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {grant.isOpen
                        ? "open"
                        : grant.endedAt
                          ? `${format(grant.endedAt, "d MMM HH:mm")}${grant.endedBy ? " (early)" : ""}`
                          : `expired ${format(grant.expiresAt, "d MMM HH:mm")}`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableFrame>
    </>
  );
}
