-- Phase 9 — white-label multi-tenancy.
--
-- Adds the platform operator (a third identity population, deliberately
-- not a row in `user`), the tenant plan, and the tenancy and white-label
-- columns on `organization`.
--
-- The subdomain is added nullable, backfilled from the slug, and only
-- then made NOT NULL: an installed system has rows, and a required column
-- with no default would refuse to migrate. The existing tenant is also
-- marked ACTIVE rather than being left at the PROVISIONING default, which
-- would lock a running company out of its own platform on deploy.

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('OWNER', 'SUPPORT', 'BILLING', 'VIEWER');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PROVISIONING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "accentColorHex" TEXT,
ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "customDomain" TEXT,
ADD COLUMN     "dltSenderId" TEXT,
ADD COLUMN     "documentFooter" TEXT,
ADD COLUMN     "faviconUrl" TEXT,
ADD COLUMN     "planId" TEXT,
ADD COLUMN     "primaryColorHex" TEXT,
ADD COLUMN     "smtpFrom" TEXT,
ADD COLUMN     "status" "TenantStatus" NOT NULL DEFAULT 'PROVISIONING',
ADD COLUMN     "subdomain" TEXT,
ADD COLUMN     "supportEmail" TEXT,
ADD COLUMN     "supportPhone" TEXT,
ADD COLUMN     "suspendReason" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "termsText" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- ── Backfill before the constraint ──────────────────────────
-- Every tenant already has a unique slug, which is exactly what it will
-- be reached on. Nothing to decide, and no manual step on deploy.
UPDATE "organization" SET "subdomain" = "slug" WHERE "subdomain" IS NULL;
ALTER TABLE "organization" ALTER COLUMN "subdomain" SET NOT NULL;

-- A company that has been operating since Phase 1 is live, whatever the
-- new column's default says.
UPDATE "organization"
   SET "status" = 'ACTIVE', "activatedAt" = "createdAt"
 WHERE "status" = 'PROVISIONING';

-- CreateTable
CREATE TABLE "platform_admin" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL DEFAULT 'VIEWER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "platform_admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxUsers" INTEGER,
    "maxBranches" INTEGER,
    "maxShipmentsPerMonth" INTEGER,
    "maxPortalUsers" INTEGER,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "monthlyPrice" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_log" (
    "id" TEXT NOT NULL,
    "platformAdminId" TEXT,
    "action" TEXT NOT NULL,
    "targetOrgId" TEXT,
    "targetOrgSlug" TEXT,
    "entity" TEXT,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_grant" (
    "id" TEXT NOT NULL,
    "platformAdminId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "asUserId" TEXT,
    "reason" TEXT NOT NULL,
    "allowWrites" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,
    "ipAddress" TEXT,

    CONSTRAINT "impersonation_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_usage_snapshot" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "onDate" DATE NOT NULL,
    "shipments" INTEGER NOT NULL DEFAULT 0,
    "deliveries" INTEGER NOT NULL DEFAULT 0,
    "activeUsers" INTEGER NOT NULL DEFAULT 0,
    "branches" INTEGER NOT NULL DEFAULT 0,
    "portalUsers" INTEGER NOT NULL DEFAULT 0,
    "notifications" INTEGER NOT NULL DEFAULT 0,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "storageBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_usage_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_onboarding_task" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isBlocking" BOOLEAN NOT NULL DEFAULT false,
    "isDone" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_onboarding_task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admin_email_key" ON "platform_admin"("email");

-- CreateIndex
CREATE INDEX "platform_admin_isActive_idx" ON "platform_admin"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_plan_code_key" ON "tenant_plan"("code");

-- CreateIndex
CREATE INDEX "platform_audit_log_targetOrgId_createdAt_idx" ON "platform_audit_log"("targetOrgId", "createdAt");

-- CreateIndex
CREATE INDEX "platform_audit_log_platformAdminId_createdAt_idx" ON "platform_audit_log"("platformAdminId", "createdAt");

-- CreateIndex
CREATE INDEX "platform_audit_log_createdAt_idx" ON "platform_audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "impersonation_grant_platformAdminId_startedAt_idx" ON "impersonation_grant"("platformAdminId", "startedAt");

-- CreateIndex
CREATE INDEX "impersonation_grant_orgId_startedAt_idx" ON "impersonation_grant"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "impersonation_grant_expiresAt_idx" ON "impersonation_grant"("expiresAt");

-- CreateIndex
CREATE INDEX "tenant_usage_snapshot_onDate_idx" ON "tenant_usage_snapshot"("onDate");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_usage_snapshot_orgId_onDate_key" ON "tenant_usage_snapshot"("orgId", "onDate");

-- CreateIndex
CREATE INDEX "tenant_onboarding_task_orgId_isDone_idx" ON "tenant_onboarding_task"("orgId", "isDone");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_onboarding_task_orgId_key_key" ON "tenant_onboarding_task"("orgId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "organization_subdomain_key" ON "organization"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "organization_customDomain_key" ON "organization"("customDomain");

-- CreateIndex
CREATE INDEX "organization_status_idx" ON "organization"("status");

-- AddForeignKey
ALTER TABLE "organization" ADD CONSTRAINT "organization_planId_fkey" FOREIGN KEY ("planId") REFERENCES "tenant_plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "platform_admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_grant" ADD CONSTRAINT "impersonation_grant_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "platform_admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ── Append-only: the operator's own trail ───────────────────
-- Same rule as `audit_log` and `shipment_event`, and for a stronger
-- reason: this table records the operator suspending a company or opening
-- a support session inside one. An operator who can edit it can act
-- inside a tenant and erase that they did.
DROP TRIGGER IF EXISTS platform_audit_log_no_update ON platform_audit_log;
CREATE TRIGGER platform_audit_log_no_update
  BEFORE UPDATE ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_on_append_only_table();

DROP TRIGGER IF EXISTS platform_audit_log_no_delete ON platform_audit_log;
CREATE TRIGGER platform_audit_log_no_delete
  BEFORE DELETE ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_on_append_only_table();
