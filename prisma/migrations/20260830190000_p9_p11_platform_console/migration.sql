-- The operator console, which no migration ever created.
--
-- Phases 9 and 11 built the platform side — the console the platform owner
-- provisions carriers from, the plans a carrier is sold, the impersonation
-- grants, the onboarding checklist, the usage snapshots — and every one of
-- those tables reached this database through `prisma db push` rather than
-- through a migration. The schema knew about them, the running database had
-- them, and the migration history did not. Nobody noticed, because nobody
-- had built this database from scratch since.
--
-- What that meant in practice: a clean install came up with no operator
-- console, no plans, and an `organization` table with no `subdomain` and no
-- `status` — which is to say the multi-tenant product did not exist on a new
-- server. It was found the first time CI applied the migrations to an empty
-- PostgreSQL, and it is the reason that job exists.
--
-- Generated with `prisma migrate diff --from-migrations --to-schema`, so it
-- is exactly the gap and nothing else.
--
-- On a database that already has these objects — this developer's, and any
-- other install predating today — mark it applied rather than running it:
--
--   npx prisma migrate resolve --applied 20260830190000_p9_p11_platform_console
--
-- `organization.subdomain` is added NOT NULL with no default, which is safe
-- only because on a fresh install the table is still empty at this point:
-- the seed runs after the migrations, not before.

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
ADD COLUMN     "subdomain" TEXT NOT NULL,
ADD COLUMN     "supportEmail" TEXT,
ADD COLUMN     "supportPhone" TEXT,
ADD COLUMN     "suspendReason" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "termsText" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

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
