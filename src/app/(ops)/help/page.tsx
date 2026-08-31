import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Mail, Phone } from "lucide-react";
import { PageHeader } from "@/components/shell/page-header";
import { TableFrame } from "@/components/data/data-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can, requireUser } from "@/lib/auth/session";
import {
  COMMON_JOBS,
  JOURNEY,
  SCOPE_LABEL,
  statusNotesFor,
} from "@/lib/help/staff";
import { moduleGateFor } from "@/lib/modules/refusal";
import { getTenantModules } from "@/lib/modules/tenant-modules";
import { SYSTEM_ROLES } from "@/lib/rbac/permissions";
import { requireTenantPage } from "@/lib/tenant/page";

export const metadata: Metadata = { title: "Help" };
export const dynamic = "force-dynamic";

/**
 * The staff help screen.
 *
 * Reachable by everybody — it is the one entry in `nav.ts` with no
 * permission, because the people who most need it are the ones holding the
 * fewest. What it *shows* still narrows: a link into a screen this person
 * cannot open, or a section their carrier never bought, would send them to
 * a refusal page, so links appear only when they would work. The
 * explanation around them does not narrow, because how a consignment moves
 * is the same fact whoever is reading it.
 */
export default async function HelpPage() {
  const { branding } = await requireTenantPage();
  const user = await requireUser();
  const modules = await getTenantModules();

  /** A link is offered only when both gates in front of it would open. */
  const reachable = (href: string, permission: string) =>
    can(user, permission) && moduleGateFor(href, modules).allowed;

  const jobs = COMMON_JOBS.filter((job) => reachable(job.href, job.permission));

  return (
    <>
      <PageHeader
        eyebrow="Help"
        title="How this works"
        description={`What happens to a consignment between the counter and the consignee, what each status means, and where the work is done in ${branding.name}.`}
      />

      {/* ── The journey ─────────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            The journey
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            A consignment only ever changes status because somebody recorded
            an event against it. Nothing edits a status directly — the
            timeline is the truth, and the status is what the timeline adds
            up to.
          </p>
        </div>

        <ol className="flex flex-col gap-3">
          {JOURNEY.map((stage, index) => {
            const notes = statusNotesFor(stage.statuses);
            const open = reachable(stage.href, stage.permission);

            return (
              <li
                key={stage.key}
                className="flex flex-col gap-3 rounded-lg border bg-card p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 className="flex items-baseline gap-2.5 text-sm font-medium">
                    <span className="font-mono text-[0.65rem] text-muted-foreground tabular">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {stage.title}
                  </h3>
                  {open && (
                    <Link
                      href={stage.href}
                      className="flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                    >
                      Open
                      <ArrowRight className="size-3" aria-hidden />
                    </Link>
                  )}
                </div>

                <p className="max-w-prose text-sm text-muted-foreground">
                  {stage.blurb}
                </p>

                <ul className="flex flex-col gap-1.5 border-t pt-3">
                  {notes.map((note) => (
                    <li
                      key={note.status}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
                    >
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
                        {note.label}
                      </span>
                      <span className="text-muted-foreground">
                        {note.arrivals.length > 0
                          ? note.arrivals.join(" · ")
                          : "Only ever reached by a status correction"}
                      </span>
                      {note.customerLabel && (
                        <span className="text-muted-foreground/70">
                          — the customer is told &ldquo;{note.customerLabel}
                          &rdquo;
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      </section>

      {/* ── Common jobs ─────────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Where to go
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Only the jobs your own login can do. If something you expect is
            missing, it is either a permission your role does not hold or a
            section your company has not bought — and those two have
            different people who can fix them.
          </p>
        </div>

        {jobs.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-muted/40 px-4 py-3.5 text-sm text-muted-foreground">
            Your login holds none of the permissions behind these screens.
            That is usually a role that has not been assigned yet — ask your
            branch manager.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {jobs.map((job) => (
              <Link
                key={job.task}
                href={job.href}
                className="group flex items-center justify-between gap-3 rounded-lg border bg-card px-3.5 py-3 transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                <span className="text-sm text-pretty">{job.task}</span>
                <ArrowRight
                  className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
                  aria-hidden
                />
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ── Roles ───────────────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Who does what
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            A role bundles permissions; its scope decides how much data those
            permissions reach. Both are checked in the data layer, so a
            missing menu item is convenience — not the boundary. Your carrier
            may have renamed these or added its own.
          </p>
        </div>

        <TableFrame>
          <Table className="min-w-[620px]">
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>What they do</TableHead>
                <TableHead>Sees</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SYSTEM_ROLES.map((role) => (
                <TableRow key={role.code}>
                  <TableCell className="font-medium">{role.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {role.description}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {SCOPE_LABEL[role.scope]}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>

        {can(user, "user.read") && (
          <p className="text-xs text-muted-foreground">
            The roles this carrier actually uses, and every permission in
            each, are at{" "}
            <Link
              href="/admin/roles"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Roles &amp; permissions
            </Link>
            .
          </p>
        )}
      </section>

      {/* ── Contact ─────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          If you are still stuck
        </h2>

        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <p className="max-w-prose text-sm text-muted-foreground">
            Start with your branch manager — most of what goes wrong here is a
            permission or a master that has not been set up yet, and both are
            fixed inside {branding.name}. Anything the product itself refuses
            because it is not on your plan can only be changed by whoever
            manages your company&rsquo;s subscription.
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
              yet. An administrator can add one in the carrier&rsquo;s own
              settings, and it will appear here.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
