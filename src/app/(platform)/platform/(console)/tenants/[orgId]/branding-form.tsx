"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FormAlert,
  IDLE_FORM,
  SubmitButton,
} from "@/components/platform/form-bits";
import { saveBranding } from "./actions";

export type BrandingValues = {
  primaryColorHex: string | null;
  accentColorHex: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  documentFooter: string | null;
  termsText: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  dltSenderId: string | null;
  smtpFrom: string | null;
  whatsappNumber: string | null;
};

/**
 * The white-label surface, grouped the way ADR 001 §3 orders it — by how
 * many people who are not our users will see it.
 *
 * The DLT sender header is called out rather than left as one field among
 * ten: it is the only one on this form that cannot be changed by deciding
 * to change it, because it carries one to three weeks of external approval
 * behind it.
 */
export function TenantBrandingForm({
  orgId,
  values,
  canWrite,
}: {
  orgId: string;
  values: BrandingValues;
  canWrite: boolean;
}) {
  const [state, action] = useActionState(saveBranding.bind(null, orgId), IDLE_FORM);

  return (
    <form action={action} className="flex flex-col gap-6">
      <fieldset disabled={!canWrite} className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          <h3 className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
            Palette and marks
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Primary colour"
              htmlFor="primaryColorHex"
              hint="Hex. Overrides the --primary token; status colours are never touched, so a red brand does not make 'delivered' red."
            >
              <Input
                id="primaryColorHex"
                name="primaryColorHex"
                defaultValue={values.primaryColorHex ?? ""}
                placeholder="#1F6F8B"
              />
            </Field>
            <Field label="Accent colour" htmlFor="accentColorHex">
              <Input
                id="accentColorHex"
                name="accentColorHex"
                defaultValue={values.accentColorHex ?? ""}
                placeholder="#E4B363"
              />
            </Field>
            <Field label="Logo URL" htmlFor="logoUrl">
              <Input
                id="logoUrl"
                name="logoUrl"
                defaultValue={values.logoUrl ?? ""}
                placeholder="https://…"
              />
            </Field>
            <Field label="Favicon URL" htmlFor="faviconUrl">
              <Input
                id="faviconUrl"
                name="faviconUrl"
                defaultValue={values.faviconUrl ?? ""}
                placeholder="https://…"
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <h3 className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
            Printed documents
          </h3>
          <Field
            label="Document footer"
            htmlFor="documentFooter"
            hint="Appears on the LR, POD and invoice — the surfaces people physically hold."
          >
            <Textarea
              id="documentFooter"
              name="documentFooter"
              rows={2}
              defaultValue={values.documentFooter ?? ""}
            />
          </Field>
          <Field label="Terms text" htmlFor="termsText">
            <Textarea
              id="termsText"
              name="termsText"
              rows={4}
              defaultValue={values.termsText ?? ""}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-4">
          <h3 className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-muted-foreground">
            Contact and notifications
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Support email" htmlFor="supportEmail">
              <Input
                id="supportEmail"
                name="supportEmail"
                type="email"
                defaultValue={values.supportEmail ?? ""}
              />
            </Field>
            <Field label="Support phone" htmlFor="supportPhone">
              <Input
                id="supportPhone"
                name="supportPhone"
                defaultValue={values.supportPhone ?? ""}
              />
            </Field>
            <Field
              label="DLT sender ID"
              htmlFor="dltSenderId"
              hint="Only fill this in once registration is APPROVED. Sending under an unapproved header does not fail quietly — it fails at the gateway, and the delivery OTP never arrives."
            >
              <Input
                id="dltSenderId"
                name="dltSenderId"
                defaultValue={values.dltSenderId ?? ""}
                placeholder="ACMELG"
              />
            </Field>
            <Field label="SMTP From" htmlFor="smtpFrom">
              <Input
                id="smtpFrom"
                name="smtpFrom"
                defaultValue={values.smtpFrom ?? ""}
                placeholder="Acme Freight <no-reply@acme.com>"
              />
            </Field>
            <Field
              label="WhatsApp Business number"
              htmlFor="whatsappNumber"
              hint="E.164, with the country code. Their sender identity, like the DLT header — the account it is sent through is entered further down."
            >
              <Input
                id="whatsappNumber"
                name="whatsappNumber"
                defaultValue={values.whatsappNumber ?? ""}
                placeholder="+919876543210"
              />
            </Field>
          </div>
        </div>
      </fieldset>

      <FormAlert state={state} />

      {canWrite && (
        <SubmitButton className="self-start">Save white-label</SubmitButton>
      )}
    </form>
  );
}
