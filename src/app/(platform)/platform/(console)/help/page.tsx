import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/shell/page-header";
import { TenantStatusBadge } from "@/components/platform/status-badge";
import { MODULES } from "@/lib/modules/modules";
import { MODULE_KEYS } from "@/lib/modules/registry";
import { ONBOARDING_TASKS, TASK_NOTES } from "@/lib/platform/onboarding";
import { MODULE_GROUPS, alwaysOnModules } from "@/lib/platform/plan-modules";
import { PLATFORM_ROLE_LABEL } from "@/lib/platform/roles";
import { operatorCan, requireOperator } from "@/lib/platform/session";

export const metadata: Metadata = { title: "Help" };
export const dynamic = "force-dynamic";

/**
 * The operator help screen.
 *
 * `requireOperator` rather than `requireCapability`: this is the one page
 * in the console every role opens, and a BILLING login being refused the
 * page that explains what BILLING may do would be a small joke at their
 * expense. The links out of it still respect capabilities, so nothing here
 * walks anybody into a 403.
 *
 * The module catalogue is rendered from `MODULES` itself. Those
 * descriptions are already written for exactly this reader — somebody
 * deciding what a carrier is buying — so restating them here would produce
 * a second, worse copy that drifts.
 */
export default async function ConsoleHelpPage() {
  const operator = await requireOperator();

  const blocking = ONBOARDING_TASKS.filter((task) => task.isBlocking);
  const optional = ONBOARDING_TASKS.filter((task) => !task.isBlocking);
  const alwaysOn = alwaysOnModules();

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Running the console"
        description={`What each thing in here does to a real carrier. You are signed in as ${PLATFORM_ROLE_LABEL[operator.role]}.`}
      />

      {/* ── Provisioning ────────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Provisioning a carrier
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Onboarding copies a template carrier&rsquo;s masters into a new
            tenant. What is copied is the shape of a carrier&rsquo;s world —
            geography, package and service types, charge heads, roles,
            notification templates, SLA ladders. What is never copied is
            anything operational or commercial: branches, routes, customers,
            users, vehicles, drivers, rate cards, and every transactional
            table. A copied rate card would be somebody else&rsquo;s prices
            quietly billed to somebody else&rsquo;s customer.
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">
              Blocking — the carrier cannot be handed over without these
            </h3>
            <p className="text-xs text-muted-foreground">
              The difference between &ldquo;not done yet&rdquo; and
              &ldquo;cannot go live&rdquo;. A carrier that goes live unable to
              send a delivery OTP has a broken product, not an incomplete one.
            </p>
          </div>
          <ul className="flex flex-col gap-2 border-t pt-3">
            {blocking.map((task) => (
              <li key={task.key} className="flex flex-col gap-0.5">
                <span className="text-sm">{task.label}</span>
                {TASK_NOTES[task.key] && (
                  <span className="max-w-prose text-xs text-muted-foreground">
                    {TASK_NOTES[task.key]}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <h3 className="border-t pt-3 text-sm font-medium">
            Wanted, but not blocking
          </h3>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {optional.map((task) => (
              <li key={task.key}>{task.label}</li>
            ))}
          </ul>
        </div>

        {operatorCan(operator, "onboarding.write") && (
          <ConsoleLink href="/platform/tenants/new" label="Provision a carrier" />
        )}
      </section>

      {/* ── Plans ───────────────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            What a plan grants
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            A plan is a set of modules. A module owns route prefixes and the
            permissions that only make sense inside it, so switching one off
            removes a whole capability rather than leaving a half-lit screen.
            Permissions answer &ldquo;may this person do it&rdquo;; modules
            answer &ldquo;did this company pay for it&rdquo;, and the two are
            independent.
          </p>
        </div>

        <div className="flex flex-col gap-1 rounded-lg border border-dashed bg-muted/40 px-4 py-3">
          <p className="text-sm">
            <strong className="font-medium">
              On every plan, including no plan at all:
            </strong>{" "}
            {alwaysOn.map((key) => MODULES[key].label).join(", ")}.
          </p>
          <p className="max-w-prose text-xs text-muted-foreground">
            {alwaysOn.map((key) => MODULES[key].description).join(" ")}
          </p>
        </div>

        {MODULE_GROUPS.map((group) => (
          <section key={group.title} className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <h3 className="text-sm font-medium">{group.title}</h3>
              <p className="max-w-prose text-xs text-muted-foreground">
                {group.description}
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {group.keys.map((key) => {
                const definition = MODULES[key];
                const requires = definition.requires ?? [];

                return (
                  <div
                    key={key}
                    className="flex flex-col gap-1.5 rounded-lg border bg-card p-3.5"
                  >
                    <span className="text-sm font-medium">
                      {definition.label}
                    </span>
                    <span className="text-xs text-muted-foreground text-pretty">
                      {definition.description}
                    </span>
                    {requires.length > 0 && (
                      <span className="font-mono text-[0.6rem] uppercase tracking-[0.1em] text-muted-foreground">
                        Needs {requires.map((need) => MODULES[need].label).join(" + ")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        <p className="max-w-prose text-xs text-muted-foreground">
          A module whose prerequisite is missing is not granted at all, even
          when the plan names it — the plan screen shows that as blocked
          rather than silently honouring it. There are {MODULE_KEYS.length}{" "}
          modules in total.
        </p>

        {operatorCan(operator, "plan.read") && (
          <ConsoleLink href="/platform/plans" label="Plans" />
        )}
      </section>

      {/* ── Lifecycle ───────────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Suspending versus closing
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Both need a reason, and the reason is required by the product
            rather than by the column: suspending a company without recording
            why is the entry in the operator log most likely to be needed a
            year later.
          </p>
        </div>

        <ul className="flex flex-col gap-2">
          <li className="flex flex-col gap-1.5 rounded-lg border bg-card p-4">
            <TenantStatusBadge status="SUSPENDED" className="self-start" />
            <p className="max-w-prose text-sm text-muted-foreground">
              Still reachable, but every write is refused in the data layer.
              Their operations team can read their own consignment history
              while a payment dispute is settled. A suspension is not a
              lockout and must not become one.
            </p>
          </li>
          <li className="flex flex-col gap-1.5 rounded-lg border bg-card p-4">
            <TenantStatusBadge status="CLOSED" className="self-start" />
            <p className="max-w-prose text-sm text-muted-foreground">
              Sign-in refused entirely and the host stops resolving — their
              subdomain becomes a 404 rather than a login page. Data is
              retained; closing is not deletion.
            </p>
          </li>
          <li className="flex flex-col gap-1.5 rounded-lg border bg-card p-4">
            <TenantStatusBadge status="ACTIVE" className="self-start" />
            <p className="max-w-prose text-sm text-muted-foreground">
              Normal service. Reactivating clears the suspension and its
              reason; the audit row recording why they were suspended stays.
            </p>
          </li>
        </ul>

        <p className="max-w-prose text-xs text-muted-foreground">
          Retiring a plan from the price list is a separate thing entirely and
          switches nothing off for carriers already on it. Non-payment is
          expressed as a suspended tenant.
        </p>
      </section>

      {/* ── Support sessions ────────────────────────────────── */}
      <section className="mb-10 flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Support sessions
        </h2>

        <div className="flex flex-col gap-3 rounded-lg border border-warn/40 bg-warn-muted p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-warn">
            <ShieldAlert className="size-4 shrink-0" aria-hidden />
            Going inside a carrier is recorded, start to finish
          </p>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-warn/90">
            <li>
              A grant is always against one named carrier, and is opened from
              that carrier&rsquo;s own page — where the reason you type has
              context.
            </li>
            <li>
              It is time-boxed. It expires on its own; it can also be ended
              early, by you or by anyone else who can see it.
            </li>
            <li>
              Read-only unless writes were explicitly asked for. Read-only is
              the right answer for almost every support question.
            </li>
            <li>
              While you are inside, a banner sits at the top of the
              carrier&rsquo;s screens saying so. It is not dismissible.
            </li>
            <li>
              Every grant, and every action taken under it, is written to the
              operator log against your name — including sessions that simply
              expired.
            </li>
          </ul>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {operatorCan(operator, "impersonate") && (
            <ConsoleLink
              href="/platform/impersonation"
              label="Support sessions"
            />
          )}
          {operatorCan(operator, "audit.read") && (
            <ConsoleLink href="/platform/audit" label="Operator log" />
          )}
        </div>
      </section>

      {/* ── Escalation ──────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          Who you escalate to
        </h2>

        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <p className="max-w-prose text-sm text-muted-foreground">
            <strong className="font-medium text-foreground">Nobody.</strong>{" "}
            This console is the top of the product. There is no support desk
            above it and no one to appeal a decision to — a carrier&rsquo;s
            own administrators cannot grant themselves a module, and we are
            who they are told to ask. Every carrier has a support number of
            their own for their staff; the operator team is where that chain
            ends.
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">
            Which is the whole reason the log exists. If you are unsure
            whether an action is yours to take, the useful question is not who
            can approve it — it is whether the row it writes will read well to
            somebody else in six months.
          </p>
          <p className="border-t pt-3 text-xs text-muted-foreground">
            What your own login may do is fixed by its role:{" "}
            {PLATFORM_ROLE_LABEL[operator.role]}. Only an OWNER can change
            that.
          </p>
        </div>
      </section>
    </>
  );
}

function ConsoleLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 rounded-lg border bg-card px-3.5 py-2.5 text-sm transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      {label}
      <ArrowRight
        className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
        aria-hidden
      />
    </Link>
  );
}
