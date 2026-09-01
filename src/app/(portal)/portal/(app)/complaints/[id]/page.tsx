import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ChevronLeft } from "lucide-react";
import { canWrite, requireCustomerUser } from "@/lib/auth/customer-session";
import { requireTenantPage } from "@/lib/tenant/page";
import { getPortalComplaint } from "@/lib/portal/complaints";
import { PageHeader } from "@/components/shell/page-header";
import { ComplaintStatusPill } from "@/components/portal/complaint-pill";
import { ComplaintThread } from "@/components/portal/complaint-thread";

export const metadata: Metadata = {
  title: "Complaint",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

export default async function PortalComplaintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireCustomerUser();
  // The thread is a client component and cannot resolve the host itself, so
  // the name replies are signed with is read here and passed down.
  const { branding } = await requireTenantPage();
  const { id } = await params;

  // Scoped inside the query. Another account's complaint id is a 404 here,
  // not a forbidden page that confirms the record exists.
  const complaint = await getPortalComplaint(session, id);
  if (!complaint) notFound();

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
        eyebrow={`${complaint.number} · ${complaint.categoryLabel}`}
        title={complaint.subject}
        description={`Raised ${format(complaint.createdAt, "dd MMM yyyy, HH:mm")}.`}
        actions={
          <ComplaintStatusPill
            label={complaint.statusLabel}
            tone={complaint.tone}
          />
        }
      />

      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-4">
          <Fact
            label={complaint.tone === "settled" ? "Settled in" : "Open for"}
            value={<span className="tabular">{complaint.age}</span>}
          />
          <Fact
            label="Consignment"
            value={
              complaint.shipmentId && complaint.lrNumber ? (
                <Link
                  href={`/portal/shipments/${complaint.shipmentId}`}
                  className="font-mono underline underline-offset-4"
                >
                  {complaint.lrNumber}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              )
            }
          />
          <Fact
            label="Messages"
            value={<span className="tabular">{complaint.messageCount}</span>}
          />
          <Fact
            label="Resolved"
            value={
              complaint.resolvedAt ? (
                format(complaint.resolvedAt, "dd MMM yyyy")
              ) : (
                <span className="text-muted-foreground">Not yet</span>
              )
            }
          />
        </div>

        {complaint.awaitingFirstReply && (
          <p className="rounded-lg border border-warn/30 bg-warn-muted px-4 py-3 text-sm text-warn">
            Nobody has answered this yet. It is on the branch&rsquo;s queue with
            a deadline against it.
          </p>
        )}

        <section className="flex flex-col gap-2">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            What you told us
          </h2>
          <p className="rounded-lg border bg-card p-4 text-sm whitespace-pre-wrap">
            {complaint.description}
          </p>
        </section>

        {complaint.resolution && (
          <section className="flex flex-col gap-2">
            <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
              How it was resolved
            </h2>
            <p className="rounded-lg border border-ok/30 bg-ok-muted p-4 text-sm whitespace-pre-wrap text-ok">
              {complaint.resolution}
            </p>
          </section>
        )}

        {/*
          `canReply` is both halves: the complaint is open to replies at
          all, and this login is one that may write. `getPortalComplaint`
          answers only the first — it knows nothing about roles — and
          `replyToComplaint` refuses a VIEWER, so a box offered to one
          would be a box that fails on submit.
        */}
        <ComplaintThread
          complaintId={complaint.id}
          messages={complaint.messages}
          canReply={complaint.canReply && canWrite(session)}
          settled={complaint.tone === "settled"}
          carrierName={branding.name}
        />
      </div>
    </>
  );
}
