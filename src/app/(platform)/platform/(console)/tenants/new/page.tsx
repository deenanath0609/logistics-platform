import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shell/page-header";
import { getEnv } from "@/lib/env";
import { listPlans } from "@/lib/platform/plans";
import { listTemplateTenants } from "@/lib/platform/provisioning";
import { requireCapability } from "@/lib/platform/session";
import { ProvisionTenantForm } from "./provision-form";

export const metadata: Metadata = { title: "New tenant" };
export const dynamic = "force-dynamic";

/**
 * Provisioning a carrier from the console.
 *
 * This used to be `scripts/provision-tenant.ts` and nothing else, on the
 * reasoning that provisioning is rare and easier to review as code than as
 * a form. That held right up until somebody who is not a developer needed
 * to do it. The script still exists and now calls the same service, so
 * there is one implementation and one audit trail whichever door is used.
 *
 * Gated on `tenant.write`, which only OWNER holds — support and billing
 * can read every carrier and neither can create one.
 */
export default async function NewTenantPage() {
  await requireCapability("tenant.write");

  const [templates, plans] = await Promise.all([listTemplateTenants(), listPlans()]);

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="New tenant"
        description="Creates the carrier, copies a template's masters into it, opens the first owner's login, and writes the onboarding checklist — in one transaction."
      />

      <Link
        href="/platform/tenants"
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" /> All tenants
      </Link>

      {templates.length === 0 ? (
        // Nothing to copy from is a real state on a brand-new deployment,
        // and it has a specific answer rather than an empty dropdown: the
        // first carrier on the platform has to come from the seed, because
        // there is no template yet by definition.
        <p className="max-w-prose rounded-lg border border-warn/40 bg-warn-muted px-4 py-3 text-sm text-warn">
          There is no carrier to copy masters from yet. The first tenant on a
          platform has to be seeded — run <code className="font-mono">npm run db:seed</code>{" "}
          — after which every further carrier can be provisioned here.
        </p>
      ) : (
        <ProvisionTenantForm
          rootDomain={getEnv().APP_ROOT_DOMAIN}
          templates={templates.map((template) => ({
            id: template.id,
            name: template.name,
            slug: template.slug,
          }))}
          plans={plans.map((plan) => ({
            id: plan.id,
            code: plan.code,
            name: plan.name,
          }))}
        />
      )}
    </>
  );
}
