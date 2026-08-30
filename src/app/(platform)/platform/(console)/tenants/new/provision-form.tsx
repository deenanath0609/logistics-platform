"use client";

import { useActionState, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Field,
  FormAlert,
  IDLE_FORM,
  SubmitButton,
} from "@/components/platform/form-bits";
import { provisionTenantAction } from "./actions";

const SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

/** A slug is a name with the punctuation taken out. Suggested, never forced. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function Group({
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
          <p className="max-w-prose text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * Everything a carrier needs to exist.
 *
 * The slug and subdomain are suggested from the company name as it is
 * typed, and stop being suggested the moment the operator edits either —
 * a field that keeps overwriting what somebody just typed is worse than no
 * help at all. The host preview is assembled live for the same reason the
 * identity form does it: a subdomain is not an identifier, it is the
 * address that ends up printed on a consignee's tracking link.
 */
export function ProvisionTenantForm({
  rootDomain,
  templates,
  plans,
}: {
  rootDomain: string;
  templates: Array<{ id: string; name: string; slug: string }>;
  plans: Array<{ id: string; code: string; name: string }>;
}) {
  const [state, action] = useActionState(provisionTenantAction, IDLE_FORM);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [subdomainTouched, setSubdomainTouched] = useState(false);

  function onName(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
    // The subdomain gets the first word only: `acme.platform.com` is what a
    // carrier wants on a tracking link, not `acme-freight-private-limited`.
    if (!subdomainTouched) setSubdomain(slugify(value).split("-")[0] ?? "");
  }

  return (
    <form action={action} className="flex flex-col gap-5">
      <Group
        title="Identity"
        description="The name is what appears in the app and on documents. The slug is the stable identifier; the subdomain is the address."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name" htmlFor="name">
            <Input
              id="name"
              name="name"
              value={name}
              onChange={(event) => onName(event.target.value)}
              placeholder="Acme Freight"
              required
            />
          </Field>
          <Field
            label="Legal name"
            htmlFor="legalName"
            hint="As registered. Printed on invoices. Defaults to the company name."
          >
            <Input id="legalName" name="legalName" placeholder="Acme Freight Private Limited" />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Subdomain"
            htmlFor="subdomain"
            hint={`Serves ${subdomain || "…"}.${rootDomain}. Reserved labels and labels another carrier holds are refused.`}
          >
            <Input
              id="subdomain"
              name="subdomain"
              value={subdomain}
              onChange={(event) => {
                setSubdomainTouched(true);
                setSubdomain(event.target.value.trim().toLowerCase());
              }}
              required
            />
          </Field>
          <Field
            label="Slug"
            htmlFor="slug"
            hint="Lower-case letters, digits and hyphens. Held to the same rules as a hostname so it can become one later."
          >
            <Input
              id="slug"
              name="slug"
              value={slug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value.trim().toLowerCase());
              }}
              required
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="LR prefix"
            htmlFor="lrPrefix"
            hint="Two to four letters, printed on every consignment note. Upper-cased on save."
          >
            <Input id="lrPrefix" name="lrPrefix" placeholder="AF" maxLength={4} required />
          </Field>
          <Field
            label="Plan"
            htmlFor="planId"
            hint="Optional. A tenant with no plan has no limits enforced against it."
          >
            <select id="planId" name="planId" defaultValue="" className={SELECT_CLASS}>
              <option value="">No plan yet</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} ({plan.code})
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Group>

      <Group
        title="Template to copy from"
        description="Geography, service types, charge heads, tax rates, reason codes, vehicle types, number series, roles, notification templates and SLA policies are copied from this carrier. Branches, customers, users, vehicles and rate cards are not — those are the new carrier's own."
      >
        <Field label="Copy masters from" htmlFor="templateOrgId">
          <select
            id="templateOrgId"
            name="templateOrgId"
            defaultValue={templates[0]?.id ?? ""}
            className={SELECT_CLASS}
            required
          >
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} ({template.slug})
              </option>
            ))}
          </select>
        </Field>
      </Group>

      <Group
        title="Head office"
        description="One branch, created from these fields. The template's branch network is deliberately not copied — somebody else's Delhi hub is worse than no hub, because it looks like configuration rather than a mistake. The city must exist in the template's geography."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Branch code"
            htmlFor="branchCode"
            hint="Short and stable — it appears on manifests. Upper-cased on save."
          >
            <Input id="branchCode" name="branchCode" placeholder="HO-DEL" required />
          </Field>
          <Field label="Branch name" htmlFor="branchName">
            <Input id="branchName" name="branchName" placeholder="Head Office — Delhi" required />
          </Field>
        </div>

        <Field label="Address" htmlFor="branchAddress" hint="Printed on the LR and the invoice.">
          <Input id="branchAddress" name="branchAddress" placeholder="Corporate Office, Okhla Phase III" required />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="City"
            htmlFor="branchCity"
            hint="Matched against the template's cities."
          >
            <Input id="branchCity" name="branchCity" placeholder="Delhi" required />
          </Field>
          <Field
            label="PIN code"
            htmlFor="branchPincode"
            hint="Preferred over the city name when it is in the template's pincode master."
          >
            <Input id="branchPincode" name="branchPincode" inputMode="numeric" placeholder="110020" maxLength={6} required />
          </Field>
          <Field
            label="Phone"
            htmlFor="branchPhone"
            hint="Notification footers print the handling branch's number."
          >
            <Input id="branchPhone" name="branchPhone" placeholder="01141000100" />
          </Field>
        </div>
      </Group>

      <Group
        title="First owner"
        description="One login, holding the template's owner role, with a generated password shown once on the next screen. It carries `must change password`, so it cannot survive their first session."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name" htmlFor="ownerName">
            <Input id="ownerName" name="ownerName" placeholder="Priya Rao" required />
          </Field>
          <Field label="Mobile" htmlFor="ownerMobile" hint="This is what they sign in with.">
            <Input id="ownerMobile" name="ownerMobile" inputMode="tel" placeholder="9800000001" required />
          </Field>
          <Field label="Email" htmlFor="ownerEmail" hint="Optional.">
            <Input id="ownerEmail" name="ownerEmail" type="email" placeholder="priya@acmefreight.com" />
          </Field>
        </div>
      </Group>

      <FormAlert state={state} />

      <p className="max-w-prose text-xs text-muted-foreground">
        The tenant is created as <strong>PROVISIONING</strong> — reachable and
        workable, but not handed over — with the ten-item onboarding checklist
        written alongside it. DLT sender registration is the long pole and takes
        one to three weeks; start it today.
      </p>

      <SubmitButton className="self-start">Provision carrier</SubmitButton>
    </form>
  );
}
