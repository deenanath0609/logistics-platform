import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/shell/page-header";
import { ModuleChips } from "@/components/platform/module-chips";
import { TenantStatusBadge } from "@/components/platform/status-badge";
import { getEnv } from "@/lib/env";
import { auditPlanModules, blockedReason } from "@/lib/platform/plan-modules";
import { recentAudit } from "@/lib/platform/audit-log";
import { grantsForOrg, tenantUsersFor } from "@/lib/platform/impersonation";
import { listOnboardingTasks, TASK_NOTES } from "@/lib/platform/onboarding";
import { firstOwnerName } from "@/lib/platform/provisioning";
import { getTenant } from "@/lib/platform/tenants";
import { listTenantCredentials } from "@/lib/platform/tenant-credentials";
import { credentialsKeyConfigured } from "@/lib/integrations/secrets";
import { operatorCan, requireCapability } from "@/lib/platform/session";
import { tenantOrigin } from "@/lib/tenant/host";
import { TenantIdentityForm } from "./identity-form";
import { TenantBrandingForm } from "./branding-form";
import { TenantLifecyclePanel } from "./lifecycle-panel";
import { OnboardingChecklist } from "./onboarding-checklist";
import { OpenSupportSessionForm } from "./impersonation-form";
import { OwnerPasswordPanel } from "./owner-password";
import { TenantCredentials } from "./credentials-form";
import { HANDOFF_COOKIE, readHandoff } from "../new/handoff";
import { EnterSessionButton } from "../../impersonation/enter-session-button";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<Metadata> {
  const { orgId } = await params;
  const detail = await getTenant(orgId);
  return { title: detail?.org.name ?? "Tenant" };
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description && (
          <p className="max-w-prose text-xs text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function Fact({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{value ?? "—"}</dd>
    </div>
  );
}

/**
 * One carrier, whole.
 *
 * The read-only operational summary sits above the editable controls on
 * purpose: an operator arriving from a support ticket needs to know what
 * state the tenant is in before being offered the buttons that change it.
 */
export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const operator = await requireCapability("tenant.read");
  const { orgId } = await params;

  const detail = await getTenant(orgId);
  if (!detail) notFound();

  const { org, usage, plans } = detail;
  const rootDomain = getEnv().APP_ROOT_DOMAIN;

  const canWrite = operatorCan(operator, "tenant.write");
  const canLifecycle = operatorCan(operator, "tenant.lifecycle");
  const canOnboard = operatorCan(operator, "onboarding.write");
  const canImpersonate = operatorCan(operator, "impersonate");

  const [tasks, grants, audit, users, credentials] = await Promise.all([
    listOnboardingTasks(orgId),
    canImpersonate ? grantsForOrg(orgId, 10) : Promise.resolve([]),
    operatorCan(operator, "audit.read")
      ? recentAudit(orgId, 10)
      : Promise.resolve([]),
    canImpersonate ? tenantUsersFor(orgId) : Promise.resolve([]),
    listTenantCredentials(orgId),
  ]);

  const blocking = tasks.filter((task) => task.isBlocking && !task.isDone);
  const latest = usage[0] ?? null;
  const origin = tenantOrigin(org, rootDomain);

  // Resolved from the plan's stored list rather than read off it. A tenant
  // with no plan still gets the always-on modules, which is why this is
  // computed even when `org.plan` is null.
  const modules = auditPlanModules(org.plan?.features ?? []);

  // Set only by the provisioning action, only moments ago, and only for
  // this tenant. Everywhere else this is null and the panel never renders.
  const freshPassword = readHandoff(
    (await cookies()).get(HANDOFF_COOKIE)?.value,
    orgId,
  );
  const firstOwner = freshPassword
    ? await firstOwnerName(orgId)
    : null;

  return (
    <>
      <PageHeader
        eyebrow="Tenant"
        title={org.name}
        description={org.legalName ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <TenantStatusBadge status={org.status} />
            <a
              href={origin}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {org.customDomain ?? `${org.subdomain}.${rootDomain}`}
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        }
      />

      <Link
        href="/platform/tenants"
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" /> All tenants
      </Link>

      {freshPassword && (
        <OwnerPasswordPanel
          orgId={org.id}
          ownerName={firstOwner}
          password={freshPassword}
          signInUrl={`${origin}/login`}
        />
      )}

      {org.status === "SUSPENDED" && org.suspendReason && (
        <p className="mb-6 rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-sm text-warn">
          Suspended{" "}
          {org.suspendedAt ? format(org.suspendedAt, "d MMM yyyy") : ""} —{" "}
          {org.suspendReason}
        </p>
      )}

      <div className="flex flex-col gap-5">
        <Section
          title="Operational summary"
          description="Read-only. Numbers are the most recent daily snapshot, not a live count."
        >
          <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <Fact
              label="Slug"
              value={<code className="font-mono">{org.slug}</code>}
            />
            <Fact label="LR prefix" value={org.lrPrefix} />
            <Fact label="Plan" value={org.plan?.name ?? "No plan"} />
            <Fact
              label="On platform since"
              value={format(org.createdAt, "d MMM yyyy")}
            />
            <Fact
              label="Activated"
              value={
                org.activatedAt ? format(org.activatedAt, "d MMM yyyy") : "never"
              }
            />
            <Fact label="GSTIN" value={org.gstin} />
            <Fact
              label="Registered at"
              value={[org.city, org.state].filter(Boolean).join(", ") || null}
            />
            <Fact label="Timezone" value={`${org.timezone} · ${org.currency}`} />
            <Fact
              label="Shipments (latest day)"
              value={latest?.shipments ?? null}
            />
            <Fact label="Deliveries" value={latest?.deliveries ?? null} />
            <Fact label="Active users" value={latest?.activeUsers ?? null} />
            <Fact label="Branches" value={latest?.branches ?? null} />
            <Fact label="Portal users" value={latest?.portalUsers ?? null} />
            <Fact label="Notifications" value={latest?.notifications ?? null} />
            <Fact label="API calls" value={latest?.apiCalls ?? null} />
            <Fact
              label="Snapshot date"
              value={latest ? format(latest.onDate, "d MMM yyyy") : "never run"}
            />
          </dl>
        </Section>

        <Section
          title="Modules this carrier has"
          description="Resolved the same way the app resolves them at sign-in, so this is what their staff can actually open — not a copy of what the plan says."
        >
          <ModuleChips
            granted={modules.granted}
            emptyText="Nothing at all, which should not be possible — the registry has no always-on module."
          />

          {org.plan ? (
            modules.blocked.length === 0 && modules.unrecognised.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Everything {org.plan.name} lists is granted.
              </p>
            ) : (
              <div className="flex flex-col gap-3 border-t pt-4">
                {modules.blocked.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <h3 className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-warn">
                      On {org.plan.name}, but not granted
                    </h3>
                    {modules.blocked.map((item) => (
                      <p key={item.key} className="text-xs text-warn">
                        {blockedReason(item)}
                      </p>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      Fix it on the plan, not here — the missing module has to
                      be added there, and every carrier on {org.plan.name} is
                      in the same position.
                    </p>
                  </div>
                )}

                {modules.unrecognised.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <h3 className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-bad">
                      Listed on the plan, but not a module
                    </h3>
                    <p className="text-xs text-bad">
                      <span className="font-mono">
                        {modules.unrecognised.join(", ")}
                      </span>{" "}
                      — free text left over from before plans were sold in
                      modules. It grants nothing, and re-saving {org.plan.name}{" "}
                      removes it.
                    </p>
                  </div>
                )}

                <Link
                  href={`/platform/plans/${org.plan.id}`}
                  className="self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Edit {org.plan.name}
                </Link>
              </div>
            )
          ) : (
            <p className="text-xs text-muted-foreground">
              No plan. A carrier mid-provisioning gets the always-on modules
              and nothing more, which is enough to book a consignment and
              administer their own staff.
            </p>
          )}
        </Section>

        <div className="grid gap-5 lg:grid-cols-2">
          <Section
            title="Routing and plan"
            description="Changing the subdomain takes effect immediately — the host cache is cleared on save, and so is the notification layer's copy of the link origin."
          >
            <TenantIdentityForm
              orgId={org.id}
              rootDomain={rootDomain}
              subdomain={org.subdomain}
              customDomain={org.customDomain}
              planId={org.planId}
              plans={plans}
              canWrite={canWrite}
            />
          </Section>

          <Section
            title="Lifecycle"
            description="Each change writes a row to the operator log with the reason given."
          >
            <TenantLifecyclePanel
              orgId={org.id}
              name={org.name}
              status={org.status}
              suspendReason={org.suspendReason}
              canWrite={canLifecycle}
            />
          </Section>
        </div>

        <Section
          title="White-label"
          description="Four surfaces, in the order ADR 001 puts them: public tracking, printed documents, notifications, then the app itself."
        >
          <TenantBrandingForm
            orgId={org.id}
            canWrite={canWrite}
            values={{
              primaryColorHex: org.primaryColorHex,
              accentColorHex: org.accentColorHex,
              logoUrl: org.logoUrl,
              faviconUrl: org.faviconUrl,
              documentFooter: org.documentFooter,
              termsText: org.termsText,
              supportEmail: org.supportEmail,
              supportPhone: org.supportPhone,
              dltSenderId: org.dltSenderId,
              smtpFrom: org.smtpFrom,
              whatsappNumber: org.whatsappNumber,
            }}
          />
        </Section>

        <Section
          title="Their accounts with the outside services"
          description="Messages already go out under this carrier's brand. This is whose gateway account they go out on — which decides whose bill they land on, whose rate limit they share, and who else stops sending when a key is revoked."
        >
          <TenantCredentials
            orgId={org.id}
            carrierName={org.name}
            canWrite={canWrite}
            keyConfigured={credentialsKeyConfigured()}
            slots={credentials.map((slot) => ({
              ...slot,
              // Dates are serialised across the server/client boundary here
              // rather than passed as `Date`, and rendered in the viewer's
              // locale on the other side.
              updatedAt: slot.updatedAt?.toISOString() ?? null,
              secretChangedAt: slot.secretChangedAt?.toISOString() ?? null,
            }))}
          />
        </Section>

        <section className="flex flex-col gap-4 rounded-lg border bg-card pb-2">
          <div className="flex flex-col gap-1 px-5 pt-5">
            <h2 className="text-sm font-semibold tracking-tight">
              Onboarding checklist
            </h2>
            <p className="text-xs text-muted-foreground">
              {blocking.length === 0
                ? "Nothing blocking. This tenant can be handed over."
                : `${blocking.length} blocking task(s) remain: ${blocking
                    .map((task) => task.key)
                    .join(", ")}.`}
            </p>
          </div>

          <OnboardingChecklist
            orgId={org.id}
            canWrite={canOnboard}
            tasks={tasks.map((task) => ({
              id: task.id,
              key: task.key,
              label: task.label,
              note: TASK_NOTES[task.key],
              isBlocking: task.isBlocking,
              isDone: task.isDone,
              doneAt: task.doneAt,
            }))}
          />
        </section>

        {canImpersonate && (
          <Section
            title="Support session"
            description="Time-boxed, reasoned, read-only unless deliberately widened, and audited on both opening and ending."
          >
            <OpenSupportSessionForm orgId={org.id} users={users} />

            {grants.length > 0 && (
              <div className="flex flex-col gap-2 border-t pt-4">
                <h3 className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
                  Recent sessions
                </h3>
                <ul className="divide-y text-sm">
                  {grants.map((grant) => {
                    return (
                      <li
                        key={grant.id}
                        className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                      >
                        <span>
                          <strong>{grant.platformAdmin.name}</strong> ·{" "}
                          {grant.allowWrites ? "read/write" : "read-only"} ·{" "}
                          <span className="text-muted-foreground">
                            {grant.reason}
                          </span>
                        </span>
                        <span className="flex items-center gap-3">
                          <span className="font-mono text-xs text-muted-foreground">
                            {grant.isOpen
                              ? `open, expires ${formatDistanceToNow(grant.expiresAt, { addSuffix: true })}`
                              : `ended ${format(grant.endedAt ?? grant.expiresAt, "d MMM HH:mm")}`}
                          </span>

                          {/* The way in is offered where the session was
                              opened, so an operator does not have to walk
                              to another screen to use what they just
                              created. Only their own, only while open. */}
                          {grant.isOpen &&
                            grant.platformAdminId === operator.id && (
                              <EnterSessionButton
                                grantId={grant.id}
                                carrierName={org.name}
                              />
                            )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Section>
        )}

        {audit.length > 0 && (
          <Section
            title="Operator actions on this tenant"
            description="From the platform log, which no tenant can read."
          >
            <ul className="divide-y text-sm">
              {audit.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                >
                  <span className="font-mono text-xs">{row.action}</span>
                  <span className="text-muted-foreground">
                    {row.platformAdmin?.name ?? "out of band"} ·{" "}
                    {format(row.createdAt, "d MMM HH:mm")}
                  </span>
                </li>
              ))}
            </ul>
            <Link
              href={`/platform/audit?org=${org.id}`}
              className="self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Everything against {org.name}
            </Link>
          </Section>
        )}
      </div>
    </>
  );
}
