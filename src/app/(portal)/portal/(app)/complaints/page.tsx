import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { MessageSquarePlus } from "lucide-react";
import { canWrite, requireCustomerUser } from "@/lib/auth/customer-session";
import { listPortalComplaints } from "@/lib/portal/complaints";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, TableFrame } from "@/components/data/data-shell";
import { ComplaintStatusPill } from "@/components/portal/complaint-pill";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Complaints",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Every complaint on this account.
 *
 * A card list rather than a table: five columns of a complaint register
 * are unreadable at 375px, and the people who raise complaints are
 * disproportionately the ones standing in a warehouse with a phone.
 */
export default async function PortalComplaintsPage() {
  const session = await requireCustomerUser();
  const complaints = await listPortalComplaints(session);
  const mayRaise = canWrite(session);

  const live = complaints.filter((row) => row.tone !== "settled");

  return (
    <>
      <PageHeader
        title="Complaints"
        description={`Everything ${session.customerName} has raised, and where each one stands.`}
        actions={
          mayRaise && (
            <Button render={<Link href="/portal/complaints/new" />}>
              <MessageSquarePlus />
              Raise a complaint
            </Button>
          )
        }
      />

      {complaints.length === 0 ? (
        <TableFrame>
          <EmptyState
            title="Nothing raised"
            description={
              mayRaise
                ? "If something goes wrong, tell us here rather than chasing the branch — everything you send is logged and answered against a clock."
                : "Your colleagues have not raised anything."
            }
            action={
              mayRaise ? (
                <Button variant="outline" render={<Link href="/portal/complaints/new" />}>
                  Raise a complaint
                </Button>
              ) : undefined
            }
          />
        </TableFrame>
      ) : (
        <div className="flex flex-col gap-6">
          {live.length > 0 && (
            <p className="rounded-lg border border-info/30 bg-info-muted px-4 py-3 text-sm text-info">
              {live.length} complaint{live.length === 1 ? "" : "s"} still open.
            </p>
          )}

          <ul className="flex flex-col gap-3">
            {complaints.map((complaint) => (
              <li key={complaint.id}>
                <Link
                  href={`/portal/complaints/${complaint.id}`}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:border-primary/50"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ComplaintStatusPill
                      label={complaint.statusLabel}
                      tone={complaint.tone}
                    />
                    <span className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground">
                      {complaint.number}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {complaint.categoryLabel}
                    </span>
                    {complaint.awaitingFirstReply && (
                      <span className="rounded-sm bg-warn-muted px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-warn">
                        Awaiting our reply
                      </span>
                    )}
                  </div>

                  <p className="font-medium text-pretty">{complaint.subject}</p>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      Raised {format(complaint.createdAt, "dd MMM yyyy")} ·{" "}
                      {complaint.tone === "settled" ? "closed in" : "open for"}{" "}
                      <span className="tabular">{complaint.age}</span>
                    </span>
                    {complaint.lrNumber && (
                      <span className="font-mono">{complaint.lrNumber}</span>
                    )}
                    <span>
                      {complaint.messageCount}{" "}
                      {complaint.messageCount === 1 ? "message" : "messages"}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
