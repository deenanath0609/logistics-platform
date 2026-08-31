import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Mail, Phone } from "lucide-react";
import { PageHeader } from "@/components/shell/page-header";
import { PortalStatusPill } from "@/components/portal/status-pill";
import { canWrite, requireCustomerUser } from "@/lib/auth/customer-session";
import {
  complaintNotes,
  customerStatusNotes,
  PORTAL_ROLE_NOTE,
} from "@/lib/help/portal";
import { requireTenantPage } from "@/lib/tenant/page";

export const metadata: Metadata = {
  title: "Help",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The customer help screen.
 *
 * Written for the person who books the freight, not for the person who
 * moves it: no branch names, no manifests, no internal statuses — the
 * portal has never shown those and this page does not introduce them.
 *
 * Shown to every login, VIEWER included. What it *offers* narrows: a
 * viewer is told what booking is and where their colleagues do it, rather
 * than handed a button that would refuse them.
 */
export default async function PortalHelpPage() {
  const { branding } = await requireTenantPage();
  const session = await requireCustomerUser();
  const mayBook = canWrite(session);

  const statuses = customerStatusNotes();
  const complaints = complaintNotes();
  const role = PORTAL_ROLE_NOTE[session.role];

  return (
    <>
      <PageHeader
        eyebrow="Help"
        title="Using this portal"
        description={`How to send something with ${branding.name}, how to follow it, and what to do when it goes wrong.`}
      />

      {/* ── Booking ─────────────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Sending something
        </h2>

        <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
          <ol className="flex flex-col gap-3 text-sm">
            <li className="flex gap-3">
              <span className="font-mono text-xs text-muted-foreground tabular">
                01
              </span>
              <p className="max-w-prose text-muted-foreground">
                <strong className="font-medium text-foreground">
                  Save the addresses you use often.
                </strong>{" "}
                Every booking starts from a consignor and a consignee, and an
                address kept in the book is one you never type twice or get
                wrong at four in the afternoon.
              </p>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-xs text-muted-foreground tabular">
                02
              </span>
              <p className="max-w-prose text-muted-foreground">
                <strong className="font-medium text-foreground">
                  Book the consignment.
                </strong>{" "}
                You give the two addresses, what is in it, how many packages
                and what they weigh. You get an LR number back — that number
                is how everybody, on both sides, refers to this consignment
                from then on.
              </p>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-xs text-muted-foreground tabular">
                03
              </span>
              <p className="max-w-prose text-muted-foreground">
                <strong className="font-medium text-foreground">
                  Ask for a pickup.
                </strong>{" "}
                A booking says what is moving; a pickup request says come and
                get it. Someone is assigned, and you will see the request move
                from raised to collected.
              </p>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-xs text-muted-foreground tabular">
                04
              </span>
              <p className="max-w-prose text-muted-foreground">
                <strong className="font-medium text-foreground">
                  Sending many at once?
                </strong>{" "}
                Upload a spreadsheet instead. Every row is checked before
                anything is booked, so a bad column is a list of corrections
                rather than fifty wrong consignments.
              </p>
            </li>
          </ol>

          {mayBook ? (
            <div className="grid gap-2 border-t pt-4 sm:grid-cols-2">
              <HelpLink href="/portal/addresses" label="Saved addresses" />
              <HelpLink href="/portal/book" label="Book a shipment" />
              <HelpLink href="/portal/pickups" label="Request a pickup" />
              <HelpLink href="/portal/bulk" label="Bulk upload" />
            </div>
          ) : (
            <p className="border-t pt-4 text-sm text-muted-foreground">
              Your login can look but not book. Whoever owns this account can
              change that, or make the booking for you.
            </p>
          )}
        </div>
      </section>

      {/* ── Tracking ────────────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Following it
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Everything you have sent is under{" "}
            <Link
              href="/portal/shipments"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Shipments
            </Link>
            , newest first, and each one opens a timeline of where it has
            been. Your consignee does not need a login: the LR number on its
            own works on the public tracking page, which is the link to send
            them.
          </p>
        </div>

        <ul className="flex flex-col gap-2">
          {statuses.map((status) => (
            <li
              key={status.label}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border bg-card px-4 py-3"
            >
              <PortalStatusPill label={status.label} tone={status.tone} />
              <p className="min-w-[16rem] flex-1 text-sm text-muted-foreground text-pretty">
                {status.meaning}
              </p>
            </li>
          ))}
        </ul>

        <p className="max-w-prose text-xs text-muted-foreground">
          A consignment can sit on one of these for a while without anything
          being wrong — a lorry running overnight between two cities shows as
          in transit for the whole run.
        </p>
      </section>

      {/* ── Complaints ──────────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            When something goes wrong
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Raise it here rather than chasing the branch. A complaint is
            logged against your LR, answered by a named person, and measured
            against two clocks: how long before somebody replies, and how
            long before it is settled. Both start when you raise it and do
            not stop overnight or at the weekend.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {complaints.map((row) => (
            <div
              key={row.category}
              className="flex flex-col gap-1 rounded-lg border bg-card px-3.5 py-3"
            >
              <span className="text-sm font-medium">{row.label}</span>
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.1em] text-muted-foreground">
                <span className="tabular">{row.responseHours}h</span> to a
                reply ·{" "}
                <span className="tabular">{row.resolutionHours}h</span> to an
                answer
              </span>
            </div>
          ))}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <HelpLink href="/portal/complaints" label="Your complaints" />
          {mayBook && (
            <HelpLink href="/portal/complaints/new" label="Raise a complaint" />
          )}
        </div>
      </section>

      {/* ── Invoices and people ─────────────────────────────── */}
      <section className="mb-10 grid gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-medium">Invoices</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Every invoice raised against this account appears under{" "}
            <Link
              href="/portal/invoices"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Invoices
            </Link>{" "}
            with what is still outstanding, and each one can be downloaded as
            it was issued. If a figure looks wrong, raise a billing complaint
            against it rather than editing anything — the invoice is a
            document, and it is corrected by a credit note.
          </p>
        </div>

        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-medium">People on this account</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            You are signed in as{" "}
            <strong className="font-medium text-foreground">
              {role.label}
            </strong>{" "}
            — {role.can.toLowerCase()}
          </p>
          <ul className="flex flex-col gap-1 border-t pt-2 text-xs text-muted-foreground">
            {(
              Object.entries(PORTAL_ROLE_NOTE) as [
                keyof typeof PORTAL_ROLE_NOTE,
                (typeof PORTAL_ROLE_NOTE)[keyof typeof PORTAL_ROLE_NOTE],
              ][]
            ).map(([key, note]) => (
              <li key={key}>
                <span className="font-medium text-foreground">
                  {note.label}
                </span>{" "}
                — {note.can}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Contact ─────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Talking to a person
        </h2>

        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <p className="max-w-prose text-sm text-muted-foreground">
            A complaint raised here is the fastest route, because it lands
            against your consignment with everything already attached. For
            anything that is not about one consignment, {branding.name} can be
            reached directly.
          </p>

          {branding.supportPhone || branding.supportEmail ? (
            <ul className="flex flex-wrap gap-x-6 gap-y-2 border-t pt-3 text-sm">
              {branding.supportPhone && (
                <li className="flex items-center gap-2">
                  <Phone
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <a
                    href={`tel:${branding.supportPhone}`}
                    className="underline underline-offset-4"
                  >
                    {branding.supportPhone}
                  </a>
                </li>
              )}
              {branding.supportEmail && (
                <li className="flex items-center gap-2">
                  <Mail
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <a
                    href={`mailto:${branding.supportEmail}`}
                    className="underline underline-offset-4"
                  >
                    {branding.supportEmail}
                  </a>
                </li>
              )}
            </ul>
          ) : (
            <p className="border-t pt-3 text-sm text-muted-foreground">
              {branding.name} has not published a support number or address
              here yet. Raise a complaint against the consignment instead —
              that always reaches somebody.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

function HelpLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      {label}
      <ArrowRight
        className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
        aria-hidden
      />
    </Link>
  );
}
