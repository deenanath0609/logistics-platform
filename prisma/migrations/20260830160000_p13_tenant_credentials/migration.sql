-- Each carrier's own account with an outside service.
--
-- Today one SMS gateway account, one SMTP relay and one GPS vendor serve
-- every carrier on the platform, read from process environment variables.
-- Messages already go out under each carrier's brand, but through our
-- account — which means one carrier's spend, one carrier's rate limit, and
-- one revoked key taking down everybody.
--
-- Deliberately its own table rather than more columns on `organization`.
-- Branding is read on nearly every request; a secret that rides along with
-- it ends up in log lines and React payloads. This table is read only by
-- the code about to call the service.
CREATE TYPE "CredentialKind" AS ENUM ('SMS', 'SMTP', 'WHATSAPP', 'GPS');

CREATE TABLE "tenant_credential" (
  "id"          TEXT NOT NULL,
  "orgId"       TEXT NOT NULL,
  "kind"        "CredentialKind" NOT NULL,
  -- Ciphertext, never a plaintext key. Nullable because a carrier can be
  -- given the slot before they have supplied the key — an ordinary state
  -- during onboarding, not an error.
  "secret"      TEXT,
  "settings"    JSONB,
  "updatedById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tenant_credential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_credential_orgId_kind_key" ON "tenant_credential"("orgId", "kind");
CREATE INDEX "tenant_credential_orgId_idx" ON "tenant_credential"("orgId");

-- The carrier's own WhatsApp Business number. Sender identity like the DLT
-- header, not a credential, so it sits with the rest of the branding.
ALTER TABLE "organization" ADD COLUMN "whatsappNumber" TEXT;
