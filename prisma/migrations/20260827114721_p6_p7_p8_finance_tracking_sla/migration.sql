-- CreateEnum
CREATE TYPE "VendorKind" AS ENUM ('TRANSPORTER', 'BROKER', 'ATTACHED_OWNER', 'SERVICE');

-- CreateEnum
CREATE TYPE "RateBasis" AS ENUM ('PER_KG', 'PER_PACKAGE', 'FLAT', 'PER_KM', 'PER_TRIP', 'PER_VEHICLE');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'CREDITED');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'CHEQUE', 'NEFT', 'RTGS', 'UPI', 'CARD', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "VendorBillStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'DISPUTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SlaState" AS ENUM ('ON_TIME', 'AT_RISK', 'BREACHED', 'MET', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ExceptionKind" AS ENUM ('SLA_AT_RISK', 'SLA_BREACHED', 'NO_GPS_UPDATE', 'VEHICLE_STOPPED', 'ROUTE_DEVIATION', 'DELIVERY_FAILED', 'SHORT_RECEIVED', 'EXCESS_RECEIVED', 'DAMAGED', 'POD_PENDING', 'HUB_DWELL', 'COD_SHORTFALL', 'CUSTOMER_COMPLAINT', 'DOCUMENT_EXPIRED', 'OTHER');

-- CreateEnum
CREATE TYPE "ExceptionPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "GeofenceDirection" AS ENUM ('ENTER', 'EXIT');

-- CreateEnum
CREATE TYPE "TrackingAlertKind" AS ENUM ('ROUTE_DEVIATION', 'STOPPAGE', 'SIGNAL_LOST', 'OVERSPEED', 'NIGHT_DRIVING');

-- CreateTable
CREATE TABLE "vendor" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "kind" "VendorKind" NOT NULL DEFAULT 'TRANSPORTER',
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "address" TEXT,
    "cityId" TEXT,
    "paymentTermDays" INTEGER,
    "tdsPercent" DECIMAL(5,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_bank_account" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "bankName" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_bank_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "rate_card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card_version" (
    "id" TEXT NOT NULL,
    "rateCardId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_card_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_slab" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "serviceTypeId" TEXT,
    "mode" "ShipmentMode",
    "originZoneId" TEXT,
    "destinationZoneId" TEXT,
    "originCityId" TEXT,
    "destinationCityId" TEXT,
    "vehicleTypeId" TEXT,
    "weightFromKg" DECIMAL(10,3),
    "weightToKg" DECIMAL(10,3),
    "basis" "RateBasis" NOT NULL DEFAULT 'PER_KG',
    "rate" DECIMAL(12,4) NOT NULL,
    "minimumCharge" DECIMAL(14,2),
    "minimumChargeableKg" DECIMAL(10,3),
    "transitHours" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_slab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_rule" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "chargeTypeId" TEXT NOT NULL,
    "basis" "ChargeBasis" NOT NULL,
    "rate" DECIMAL(12,4) NOT NULL,
    "minimumAmount" DECIMAL(14,2),
    "maximumAmount" DECIMAL(14,2),
    "appliesWhen" JSONB,
    "isAutomatic" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_surcharge_rule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "percent" DECIMAL(6,3) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "fuel_surcharge_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "freight_calculation" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "versionId" TEXT,
    "trace" JSONB NOT NULL,
    "chargeableWeight" DECIMAL(10,3) NOT NULL,
    "freightAmount" DECIMAL(14,2) NOT NULL,
    "chargesTotal" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "grandTotal" DECIMAL(14,2) NOT NULL,
    "stage" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "freight_calculation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "customerId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "periodFrom" DATE,
    "periodTo" DATE,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountDue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "isReverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "placeOfSupply" TEXT,
    "customerGstin" TEXT,
    "notes" TEXT,
    "documentAssetId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "issuedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "chargeTypeId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "rate" DECIMAL(12,4) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "taxPercent" DECIMAL(6,3),
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "hsnSac" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "documentAssetId" TEXT,

    CONSTRAINT "credit_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "branchId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "tdsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "mode" "PaymentMode" NOT NULL DEFAULT 'NEFT',
    "reference" TEXT,
    "receivedOn" DATE NOT NULL,
    "unallocated" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocation" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_rate_contract" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_rate_contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_rate_line" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "originBranchId" TEXT,
    "destinationBranchId" TEXT,
    "vehicleTypeId" TEXT,
    "basis" "RateBasis" NOT NULL DEFAULT 'PER_TRIP',
    "rate" DECIMAL(12,4) NOT NULL,
    "minimumAmount" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_rate_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_bill" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" "VendorBillStatus" NOT NULL DEFAULT 'DRAFT',
    "billDate" DATE NOT NULL,
    "dueDate" DATE,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tdsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advanceAdjusted" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountDue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "varianceAmount" DECIMAL(14,2),
    "varianceNote" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "vendor_bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_bill_line" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "tripId" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "taxPercent" DECIMAL(6,3),
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "vendor_bill_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_payment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "mode" "PaymentMode" NOT NULL DEFAULT 'NEFT',
    "reference" TEXT,
    "paidOn" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "vendor_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_settlement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "tripId" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "tripEarning" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advancesPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "expensesClaimed" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deductionNote" TEXT,
    "netPayable" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "driver_settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policy" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceTypeId" TEXT,
    "originZoneId" TEXT,
    "destinationZoneId" TEXT,
    "originCityId" TEXT,
    "destinationCityId" TEXT,
    "transitHours" INTEGER NOT NULL,
    "useWorkingHours" BOOLEAN NOT NULL DEFAULT true,
    "respectCutoff" BOOLEAN NOT NULL DEFAULT true,
    "atRiskPercent" INTEGER NOT NULL DEFAULT 80,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sla_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_sla" (
    "shipmentId" TEXT NOT NULL,
    "policyId" TEXT,
    "state" "SlaState" NOT NULL DEFAULT 'ON_TIME',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "atRiskAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "varianceMinutes" INTEGER,
    "breachReason" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipment_sla_pkey" PRIMARY KEY ("shipmentId")
);

-- CreateTable
CREATE TABLE "exception" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "ExceptionKind" NOT NULL,
    "priority" "ExceptionPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "shipmentId" TEXT,
    "tripId" TEXT,
    "vehicleId" TEXT,
    "branchId" TEXT,
    "ownerBranchId" TEXT,
    "assignedToId" TEXT,
    "reasonCodeId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "escalateAt" TIMESTAMP(3),
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,
    "closedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'system',
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exception_action" (
    "id" TEXT NOT NULL,
    "exceptionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_rule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "ExceptionKind" NOT NULL,
    "level" INTEGER NOT NULL,
    "afterMinutes" INTEGER NOT NULL,
    "notifyRoleCode" TEXT,
    "notifyUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escalation_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_report" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ownerId" TEXT,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "schedule" TEXT,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_run" (
    "id" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "format" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_provider_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'poll',
    "baseUrl" TEXT,
    "apiKey" TEXT,
    "webhookSecret" TEXT,
    "pollIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastPolledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_provider_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gps_ping" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "speedKmph" DECIMAL(6,2),
    "heading" INTEGER,
    "ignition" BOOLEAN,
    "odometerKm" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT,
    "providerRef" TEXT,

    CONSTRAINT "gps_ping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_location" (
    "vehicleId" TEXT NOT NULL,
    "deviceId" TEXT,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "speedKmph" DECIMAL(6,2),
    "heading" INTEGER,
    "ignition" BOOLEAN,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "insideGeofenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pendingFenceId" TEXT,
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "nearestBranchId" TEXT,
    "distanceToNearestKm" DECIMAL(8,2),

    CONSTRAINT "vehicle_location_pkey" PRIMARY KEY ("vehicleId")
);

-- CreateTable
CREATE TABLE "geofence_event" (
    "id" TEXT NOT NULL,
    "geofenceId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "tripId" TEXT,
    "direction" "GeofenceDirection" NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dwellMinutes" INTEGER,
    "propagated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "geofence_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_alert" (
    "id" TEXT NOT NULL,
    "kind" "TrackingAlertKind" NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "tripId" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "deviationMetres" INTEGER,
    "durationMinutes" INTEGER,
    "speedKmph" DECIMAL(6,2),
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "exceptionId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eta_snapshot" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estimatedArrivalAt" TIMESTAMP(3) NOT NULL,
    "remainingKm" DECIMAL(10,2),
    "averageSpeedKmph" DECIMAL(6,2),
    "method" TEXT NOT NULL DEFAULT 'gps',
    "confidence" TEXT,

    CONSTRAINT "eta_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_kind_isActive_idx" ON "vendor"("kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_orgId_code_key" ON "vendor"("orgId", "code");

-- CreateIndex
CREATE INDEX "vendor_bank_account_vendorId_idx" ON "vendor_bank_account"("vendorId");

-- CreateIndex
CREATE INDEX "rate_card_customerId_isActive_idx" ON "rate_card"("customerId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "rate_card_orgId_code_key" ON "rate_card"("orgId", "code");

-- CreateIndex
CREATE INDEX "rate_card_version_effectiveFrom_idx" ON "rate_card_version"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "rate_card_version_rateCardId_version_key" ON "rate_card_version"("rateCardId", "version");

-- CreateIndex
CREATE INDEX "rate_slab_versionId_idx" ON "rate_slab"("versionId");

-- CreateIndex
CREATE INDEX "rate_slab_serviceTypeId_idx" ON "rate_slab"("serviceTypeId");

-- CreateIndex
CREATE INDEX "charge_rule_versionId_idx" ON "charge_rule"("versionId");

-- CreateIndex
CREATE INDEX "fuel_surcharge_rule_effectiveFrom_idx" ON "fuel_surcharge_rule"("effectiveFrom");

-- CreateIndex
CREATE INDEX "freight_calculation_shipmentId_createdAt_idx" ON "freight_calculation"("shipmentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_number_key" ON "invoice"("number");

-- CreateIndex
CREATE INDEX "invoice_customerId_status_idx" ON "invoice"("customerId", "status");

-- CreateIndex
CREATE INDEX "invoice_status_dueDate_idx" ON "invoice"("status", "dueDate");

-- CreateIndex
CREATE INDEX "invoice_invoiceDate_idx" ON "invoice"("invoiceDate");

-- CreateIndex
CREATE INDEX "invoice_line_invoiceId_idx" ON "invoice_line"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_line_shipmentId_idx" ON "invoice_line"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_number_key" ON "credit_note"("number");

-- CreateIndex
CREATE INDEX "credit_note_invoiceId_idx" ON "credit_note"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_number_key" ON "payment"("number");

-- CreateIndex
CREATE INDEX "payment_customerId_receivedOn_idx" ON "payment"("customerId", "receivedOn");

-- CreateIndex
CREATE INDEX "payment_allocation_invoiceId_idx" ON "payment_allocation"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocation_paymentId_invoiceId_key" ON "payment_allocation"("paymentId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_rate_contract_vendorId_code_key" ON "vendor_rate_contract"("vendorId", "code");

-- CreateIndex
CREATE INDEX "vendor_rate_line_contractId_idx" ON "vendor_rate_line"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_bill_number_key" ON "vendor_bill"("number");

-- CreateIndex
CREATE INDEX "vendor_bill_vendorId_status_idx" ON "vendor_bill"("vendorId", "status");

-- CreateIndex
CREATE INDEX "vendor_bill_status_dueDate_idx" ON "vendor_bill"("status", "dueDate");

-- CreateIndex
CREATE INDEX "vendor_bill_line_billId_idx" ON "vendor_bill_line"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_payment_number_key" ON "vendor_payment"("number");

-- CreateIndex
CREATE INDEX "vendor_payment_vendorId_paidOn_idx" ON "vendor_payment"("vendorId", "paidOn");

-- CreateIndex
CREATE UNIQUE INDEX "driver_settlement_number_key" ON "driver_settlement"("number");

-- CreateIndex
CREATE INDEX "driver_settlement_driverId_status_idx" ON "driver_settlement"("driverId", "status");

-- CreateIndex
CREATE INDEX "sla_policy_serviceTypeId_isActive_idx" ON "sla_policy"("serviceTypeId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policy_orgId_code_key" ON "sla_policy"("orgId", "code");

-- CreateIndex
CREATE INDEX "shipment_sla_state_dueAt_idx" ON "shipment_sla"("state", "dueAt");

-- CreateIndex
CREATE INDEX "shipment_sla_dueAt_idx" ON "shipment_sla"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "exception_number_key" ON "exception"("number");

-- CreateIndex
CREATE UNIQUE INDEX "exception_dedupeKey_key" ON "exception"("dedupeKey");

-- CreateIndex
CREATE INDEX "exception_status_priority_detectedAt_idx" ON "exception"("status", "priority", "detectedAt");

-- CreateIndex
CREATE INDEX "exception_ownerBranchId_status_idx" ON "exception"("ownerBranchId", "status");

-- CreateIndex
CREATE INDEX "exception_assignedToId_status_idx" ON "exception"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "exception_kind_status_idx" ON "exception"("kind", "status");

-- CreateIndex
CREATE INDEX "exception_shipmentId_idx" ON "exception"("shipmentId");

-- CreateIndex
CREATE INDEX "exception_action_exceptionId_createdAt_idx" ON "exception_action"("exceptionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "escalation_rule_orgId_kind_level_key" ON "escalation_rule"("orgId", "kind", "level");

-- CreateIndex
CREATE INDEX "saved_report_reportKey_ownerId_idx" ON "saved_report"("reportKey", "ownerId");

-- CreateIndex
CREATE INDEX "report_run_reportKey_createdAt_idx" ON "report_run"("reportKey", "createdAt");

-- CreateIndex
CREATE INDEX "report_run_userId_createdAt_idx" ON "report_run"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_provider_config_orgId_code_key" ON "tracking_provider_config"("orgId", "code");

-- CreateIndex
CREATE INDEX "gps_ping_vehicleId_recordedAt_idx" ON "gps_ping"("vehicleId", "recordedAt");

-- CreateIndex
CREATE INDEX "gps_ping_recordedAt_idx" ON "gps_ping"("recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "gps_ping_deviceId_recordedAt_key" ON "gps_ping"("deviceId", "recordedAt");

-- CreateIndex
CREATE INDEX "vehicle_location_recordedAt_idx" ON "vehicle_location"("recordedAt");

-- CreateIndex
CREATE INDEX "geofence_event_vehicleId_occurredAt_idx" ON "geofence_event"("vehicleId", "occurredAt");

-- CreateIndex
CREATE INDEX "geofence_event_geofenceId_occurredAt_idx" ON "geofence_event"("geofenceId", "occurredAt");

-- CreateIndex
CREATE INDEX "tracking_alert_vehicleId_detectedAt_idx" ON "tracking_alert"("vehicleId", "detectedAt");

-- CreateIndex
CREATE INDEX "tracking_alert_kind_resolvedAt_idx" ON "tracking_alert"("kind", "resolvedAt");

-- CreateIndex
CREATE INDEX "eta_snapshot_tripId_computedAt_idx" ON "eta_snapshot"("tripId", "computedAt");

-- CreateIndex
CREATE INDEX "eta_snapshot_shipmentId_computedAt_idx" ON "eta_snapshot"("shipmentId", "computedAt");

-- AddForeignKey
ALTER TABLE "vendor_bank_account" ADD CONSTRAINT "vendor_bank_account_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_version" ADD CONSTRAINT "rate_card_version_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "rate_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_slab" ADD CONSTRAINT "rate_slab_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "rate_card_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_rule" ADD CONSTRAINT "charge_rule_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "rate_card_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_rule" ADD CONSTRAINT "charge_rule_chargeTypeId_fkey" FOREIGN KEY ("chargeTypeId") REFERENCES "charge_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freight_calculation" ADD CONSTRAINT "freight_calculation_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_rate_contract" ADD CONSTRAINT "vendor_rate_contract_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_rate_line" ADD CONSTRAINT "vendor_rate_line_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "vendor_rate_contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bill" ADD CONSTRAINT "vendor_bill_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bill_line" ADD CONSTRAINT "vendor_bill_line_billId_fkey" FOREIGN KEY ("billId") REFERENCES "vendor_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_payment" ADD CONSTRAINT "vendor_payment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_settlement" ADD CONSTRAINT "driver_settlement_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver" ADD CONSTRAINT "driver_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_sla" ADD CONSTRAINT "shipment_sla_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception" ADD CONSTRAINT "exception_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception" ADD CONSTRAINT "exception_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception" ADD CONSTRAINT "exception_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_action" ADD CONSTRAINT "exception_action_exceptionId_fkey" FOREIGN KEY ("exceptionId") REFERENCES "exception"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_event" ADD CONSTRAINT "geofence_event_geofenceId_fkey" FOREIGN KEY ("geofenceId") REFERENCES "geofence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
