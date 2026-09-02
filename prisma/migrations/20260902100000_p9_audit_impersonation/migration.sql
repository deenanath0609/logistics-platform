-- The carrier's own audit trail says when support was the one acting.
--
-- `audit_log."userId"` is a foreign key into `app_user`, so an impersonated
-- write can only ever name the tenant user the grant adopted — and did,
-- with nothing beside it. The operator half of that attribution lived only
-- in `platform_audit_log`, which no tenant can read. The result was a
-- carrier looking at an approval, a cancellation or a rate override in one
-- of their own people's names, with no way at all to learn it was us.
--
-- Nullable, and null for every row written before this and for every
-- ordinary one after it.

ALTER TABLE "audit_log" ADD COLUMN "impersonationGrantId" TEXT;

-- No foreign key on purpose: `impersonation_grant` is operator-owned and
-- outside the tenant's row-level security, and a relation would give a
-- tenant-scoped read a join out of its own tenant.
CREATE INDEX "audit_log_impersonationGrantId_idx"
  ON "audit_log" ("impersonationGrantId")
  WHERE "impersonationGrantId" IS NOT NULL;
