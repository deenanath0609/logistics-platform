-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL', 'WHATSAPP', 'PUSH', 'IN_APP');

-- CreateEnum
CREATE TYPE "RecipientKind" AS ENUM ('CONSIGNOR', 'CONSIGNEE', 'CUSTOMER_USER', 'STAFF', 'BRANCH');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "CustomerUserRole" AS ENUM ('OWNER', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ComplaintCategory" AS ENUM ('DELAY', 'DAMAGE', 'MISSING', 'WRONG_DELIVERY', 'BILLING', 'POD_ISSUE', 'PICKUP_ISSUE', 'BEHAVIOUR', 'OTHER');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'ASSIGNED', 'INVESTIGATING', 'ACTION_TAKEN', 'RESOLVED', 'CLOSED', 'REOPENED');

-- CreateEnum
CREATE TYPE "ComplaintPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- AlterTable
ALTER TABLE "bulk_upload_batch" ADD COLUMN     "uploadedByCustomerUserId" TEXT;

-- CreateTable
CREATE TABLE "notification_template" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "eventType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recipientKind" "RecipientKind" NOT NULL DEFAULT 'CONSIGNOR',
    "dltTemplateId" TEXT,
    "dltSenderId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_log" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "eventType" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "recipientKind" "RecipientKind" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerRef" TEXT,
    "providerResponse" JSONB,
    "segments" INTEGER,
    "costAmount" DECIMAL(10,4),
    "error" TEXT,
    "shipmentId" TEXT,
    "customerId" TEXT,
    "branchId" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "customerUserId" TEXT,
    "userId" TEXT,
    "eventType" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscription" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "pausedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "webhook_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "error" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_user" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mobile" TEXT,
    "passwordHash" TEXT,
    "role" "CustomerUserRole" NOT NULL DEFAULT 'MEMBER',
    "visibleBranchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "customer_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaint" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "category" "ComplaintCategory" NOT NULL,
    "priority" "ComplaintPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "shipmentId" TEXT,
    "customerId" TEXT,
    "branchId" TEXT,
    "raisedByUserId" TEXT,
    "raisedByCustomerUserId" TEXT,
    "assignedToId" TEXT,
    "respondBy" TIMESTAMP(3),
    "resolveBy" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "closedAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaint_message" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorCustomerUserId" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT true,
    "attachmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaint_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_template_eventType_isActive_idx" ON "notification_template"("eventType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "notification_template_code_channel_language_key" ON "notification_template"("code", "channel", "language");

-- CreateIndex
CREATE INDEX "notification_log_status_queuedAt_idx" ON "notification_log"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "notification_log_shipmentId_idx" ON "notification_log"("shipmentId");

-- CreateIndex
CREATE INDEX "notification_log_customerId_queuedAt_idx" ON "notification_log"("customerId", "queuedAt");

-- CreateIndex
CREATE INDEX "notification_log_recipient_queuedAt_idx" ON "notification_log"("recipient", "queuedAt");

-- CreateIndex
CREATE INDEX "notification_preference_customerId_idx" ON "notification_preference"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_customerId_customerUserId_userId_ev_key" ON "notification_preference"("customerId", "customerUserId", "userId", "eventType", "channel");

-- CreateIndex
CREATE INDEX "webhook_subscription_customerId_isActive_idx" ON "webhook_subscription"("customerId", "isActive");

-- CreateIndex
CREATE INDEX "webhook_delivery_status_nextAttemptAt_idx" ON "webhook_delivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "webhook_delivery_subscriptionId_createdAt_idx" ON "webhook_delivery"("subscriptionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_user_email_key" ON "customer_user"("email");

-- CreateIndex
CREATE INDEX "customer_user_customerId_isActive_idx" ON "customer_user"("customerId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "complaint_number_key" ON "complaint"("number");

-- CreateIndex
CREATE INDEX "complaint_status_priority_createdAt_idx" ON "complaint"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "complaint_customerId_status_idx" ON "complaint"("customerId", "status");

-- CreateIndex
CREATE INDEX "complaint_shipmentId_idx" ON "complaint"("shipmentId");

-- CreateIndex
CREATE INDEX "complaint_assignedToId_status_idx" ON "complaint"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "complaint_message_complaintId_createdAt_idx" ON "complaint_message"("complaintId", "createdAt");

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "notification_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_subscription" ADD CONSTRAINT "webhook_subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "webhook_subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_user" ADD CONSTRAINT "customer_user_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_raisedByCustomerUserId_fkey" FOREIGN KEY ("raisedByCustomerUserId") REFERENCES "customer_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_message" ADD CONSTRAINT "complaint_message_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_message" ADD CONSTRAINT "complaint_message_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_message" ADD CONSTRAINT "complaint_message_authorCustomerUserId_fkey" FOREIGN KEY ("authorCustomerUserId") REFERENCES "customer_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_upload_batch" ADD CONSTRAINT "bulk_upload_batch_uploadedByCustomerUserId_fkey" FOREIGN KEY ("uploadedByCustomerUserId") REFERENCES "customer_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
