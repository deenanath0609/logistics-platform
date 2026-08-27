-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('CORPORATE', 'RETAIL', 'WALK_IN');

-- CreateEnum
CREATE TYPE "PaymentTerm" AS ENUM ('PREPAID', 'CREDIT', 'CASH');

-- CreateEnum
CREATE TYPE "AddressKind" AS ENUM ('PICKUP', 'DELIVERY', 'BILLING');

-- CreateEnum
CREATE TYPE "PickupStatus" AS ENUM ('REQUESTED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PickupSlot" AS ENUM ('MORNING', 'AFTERNOON', 'EVENING', 'ANYTIME');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('COLLECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('BOOKED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'RECEIVED_AT_ORIGIN', 'PROCESSED', 'MANIFESTED', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED_AT_HUB', 'RECEIVED_AT_HUB', 'ASSIGNED_FOR_DELIVERY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'POD_UPLOADED', 'CLOSED', 'RTO_INITIATED', 'RTO_IN_TRANSIT', 'RTO_DELIVERED', 'LOST', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShipmentEventType" AS ENUM ('BOOKING_CREATED', 'BOOKING_AMENDED', 'PICKUP_ASSIGNED', 'PICKUP_ATTEMPTED', 'PICKUP_COMPLETED', 'INBOUND_SCAN', 'WEIGHT_CAPTURED', 'SORTED', 'MANIFEST_ADDED', 'MANIFEST_REMOVED', 'LOADED', 'GATE_OUT', 'IN_TRANSIT_PING', 'GEOFENCE_ENTER', 'GEOFENCE_EXIT', 'GATE_IN', 'UNLOADED', 'DISCREPANCY_RAISED', 'DAMAGE_RECORDED', 'HELD', 'HOLD_RELEASED', 'DELIVERY_ASSIGNED', 'RUN_STARTED', 'DELIVERY_ATTEMPTED', 'DELIVERED', 'COD_COLLECTED', 'POD_SYNCED', 'RTO_INITIATED', 'CANCELLED', 'CLOSED', 'STATUS_CORRECTED');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('WEB', 'FIELD_APP', 'API', 'GPS', 'SYSTEM', 'IMPORT');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('PAID', 'TO_PAY', 'TBB', 'COD');

-- CreateEnum
CREATE TYPE "ShipmentPackageStatus" AS ENUM ('PENDING', 'IN_NETWORK', 'DELIVERED', 'DAMAGED', 'MISSING', 'RETURNED');

-- CreateEnum
CREATE TYPE "BulkBatchStatus" AS ENUM ('UPLOADED', 'VALIDATED', 'PARTIALLY_COMMITTED', 'COMMITTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "BulkRowStatus" AS ENUM ('PENDING', 'VALID', 'INVALID', 'COMMITTED', 'SKIPPED');

-- CreateTable
CREATE TABLE "customer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "type" "CustomerType" NOT NULL DEFAULT 'CORPORATE',
    "branchId" TEXT,
    "phone" TEXT NOT NULL,
    "altPhone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "billingAddress" TEXT,
    "billingCityId" TEXT,
    "billingPincode" TEXT,
    "paymentTerm" "PaymentTerm" NOT NULL DEFAULT 'CASH',
    "creditLimit" DECIMAL(14,2),
    "creditDays" INTEGER,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockReason" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_address" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "AddressKind" NOT NULL DEFAULT 'PICKUP',
    "contactName" TEXT,
    "phone" TEXT,
    "address" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "landmark" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contact" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_request" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "status" "PickupStatus" NOT NULL DEFAULT 'REQUESTED',
    "shipmentId" TEXT,
    "customerId" TEXT,
    "addressId" TEXT,
    "contactName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "landmark" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "requestedDate" DATE NOT NULL,
    "slot" "PickupSlot" NOT NULL DEFAULT 'ANYTIME',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "expectedPackages" INTEGER,
    "expectedWeight" DECIMAL(10,3),
    "goodsDescription" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "pickup_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_assignment" (
    "id" TEXT NOT NULL,
    "pickupRequestId" TEXT NOT NULL,
    "assignedToId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" "PickupStatus" NOT NULL DEFAULT 'ASSIGNED',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "pickup_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_attempt" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "outcome" "AttemptOutcome" NOT NULL,
    "reasonCodeId" TEXT,
    "packagesCollected" INTEGER,
    "weightCollected" DECIMAL(10,3),
    "receiverName" TEXT,
    "photoAssetId" TEXT,
    "signatureAssetId" TEXT,
    "otpVerified" BOOLEAN NOT NULL DEFAULT false,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "deviceId" TEXT,
    "remarks" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "pickup_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "lrNumber" TEXT NOT NULL,
    "mode" "ShipmentMode" NOT NULL,
    "serviceTypeId" TEXT NOT NULL,
    "bookingBranchId" TEXT NOT NULL,
    "originBranchId" TEXT NOT NULL,
    "destinationBranchId" TEXT NOT NULL,
    "currentBranchId" TEXT,
    "currentStatus" "ShipmentStatus" NOT NULL DEFAULT 'BOOKED',
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "isOnHold" BOOLEAN NOT NULL DEFAULT false,
    "holdReasonId" TEXT,
    "consignorId" TEXT,
    "consignorName" TEXT NOT NULL,
    "consignorCompany" TEXT,
    "consignorPhone" TEXT NOT NULL,
    "consignorEmail" TEXT,
    "consignorAddress" TEXT NOT NULL,
    "consignorCityId" TEXT NOT NULL,
    "consignorPincode" TEXT NOT NULL,
    "consignorGstin" TEXT,
    "consigneeName" TEXT NOT NULL,
    "consigneeCompany" TEXT,
    "consigneePhone" TEXT NOT NULL,
    "consigneeEmail" TEXT,
    "consigneeAddress" TEXT NOT NULL,
    "consigneeCityId" TEXT NOT NULL,
    "consigneePincode" TEXT NOT NULL,
    "consigneeLandmark" TEXT,
    "consigneeGstin" TEXT,
    "packageCount" INTEGER NOT NULL,
    "packageTypeId" TEXT,
    "actualWeight" DECIMAL(10,3) NOT NULL,
    "volumetricWeight" DECIMAL(10,3),
    "chargeableWeight" DECIMAL(10,3) NOT NULL,
    "declaredValue" DECIMAL(14,2),
    "goodsDescription" TEXT NOT NULL,
    "specialInstructions" TEXT,
    "isFragile" BOOLEAN NOT NULL DEFAULT false,
    "paymentType" "PaymentType" NOT NULL DEFAULT 'PAID',
    "codAmount" DECIMAL(14,2),
    "freightAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "chargesTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "isReverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "customerReference" TEXT,
    "ewayBillNumber" TEXT,
    "ewayBillExpiry" TIMESTAMP(3),
    "invoiceNumber" TEXT,
    "invoiceValue" DECIMAL(14,2),
    "bookedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bookedById" TEXT,
    "pickupRequired" BOOLEAN NOT NULL DEFAULT true,
    "pickedUpAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "expectedDeliveryAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReasonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_package" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "barcode" TEXT NOT NULL,
    "packageTypeId" TEXT,
    "weight" DECIMAL(10,3),
    "lengthCm" DECIMAL(8,2),
    "breadthCm" DECIMAL(8,2),
    "heightCm" DECIMAL(8,2),
    "contents" TEXT,
    "status" "ShipmentPackageStatus" NOT NULL DEFAULT 'PENDING',
    "currentBranchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipment_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_charge" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "chargeTypeId" TEXT NOT NULL,
    "basis" "ChargeBasis" NOT NULL,
    "rate" DECIMAL(12,4) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "taxRateId" TEXT,
    "taxPercent" DECIMAL(6,3),
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_event" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "packageId" TEXT,
    "eventType" "ShipmentEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clockDriftSeconds" INTEGER,
    "branchId" TEXT,
    "userId" TEXT,
    "vehicleId" TEXT,
    "tripId" TEXT,
    "manifestId" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "deviceId" TEXT,
    "reasonCodeId" TEXT,
    "remarks" TEXT,
    "attachmentId" TEXT,
    "source" "EventSource" NOT NULL DEFAULT 'WEB',
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB,
    "resultingStatus" "ShipmentStatus",

    CONSTRAINT "shipment_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_upload_batch" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT,
    "fileName" TEXT NOT NULL,
    "fileAssetId" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "committedRows" INTEGER NOT NULL DEFAULT 0,
    "status" "BulkBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_upload_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_upload_row" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "status" "BulkRowStatus" NOT NULL DEFAULT 'PENDING',
    "errors" JSONB,
    "shipmentId" TEXT,
    "lrNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_upload_row_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_branchId_isActive_idx" ON "customer"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "customer_phone_idx" ON "customer"("phone");

-- CreateIndex
CREATE INDEX "customer_name_idx" ON "customer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "customer_orgId_code_key" ON "customer"("orgId", "code");

-- CreateIndex
CREATE INDEX "customer_address_customerId_kind_idx" ON "customer_address"("customerId", "kind");

-- CreateIndex
CREATE INDEX "customer_contact_customerId_idx" ON "customer_contact"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_request_number_key" ON "pickup_request"("number");

-- CreateIndex
CREATE INDEX "pickup_request_branchId_status_requestedDate_idx" ON "pickup_request"("branchId", "status", "requestedDate");

-- CreateIndex
CREATE INDEX "pickup_request_shipmentId_idx" ON "pickup_request"("shipmentId");

-- CreateIndex
CREATE INDEX "pickup_request_customerId_idx" ON "pickup_request"("customerId");

-- CreateIndex
CREATE INDEX "pickup_assignment_assignedToId_status_idx" ON "pickup_assignment"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "pickup_assignment_pickupRequestId_idx" ON "pickup_assignment"("pickupRequestId");

-- CreateIndex
CREATE INDEX "pickup_attempt_assignmentId_idx" ON "pickup_attempt"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_attempt_assignmentId_attemptNumber_key" ON "pickup_attempt"("assignmentId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_lrNumber_key" ON "shipment"("lrNumber");

-- CreateIndex
CREATE INDEX "shipment_currentStatus_bookedAt_idx" ON "shipment"("currentStatus", "bookedAt");

-- CreateIndex
CREATE INDEX "shipment_originBranchId_currentStatus_idx" ON "shipment"("originBranchId", "currentStatus");

-- CreateIndex
CREATE INDEX "shipment_destinationBranchId_currentStatus_idx" ON "shipment"("destinationBranchId", "currentStatus");

-- CreateIndex
CREATE INDEX "shipment_currentBranchId_idx" ON "shipment"("currentBranchId");

-- CreateIndex
CREATE INDEX "shipment_consignorId_bookedAt_idx" ON "shipment"("consignorId", "bookedAt");

-- CreateIndex
CREATE INDEX "shipment_consigneePhone_idx" ON "shipment"("consigneePhone");

-- CreateIndex
CREATE INDEX "shipment_customerReference_idx" ON "shipment"("customerReference");

-- CreateIndex
CREATE INDEX "shipment_bookedAt_idx" ON "shipment"("bookedAt");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_package_barcode_key" ON "shipment_package"("barcode");

-- CreateIndex
CREATE INDEX "shipment_package_shipmentId_idx" ON "shipment_package"("shipmentId");

-- CreateIndex
CREATE INDEX "shipment_package_currentBranchId_status_idx" ON "shipment_package"("currentBranchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_package_shipmentId_sequence_key" ON "shipment_package"("shipmentId", "sequence");

-- CreateIndex
CREATE INDEX "shipment_charge_shipmentId_idx" ON "shipment_charge"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_event_idempotencyKey_key" ON "shipment_event"("idempotencyKey");

-- CreateIndex
CREATE INDEX "shipment_event_shipmentId_occurredAt_idx" ON "shipment_event"("shipmentId", "occurredAt");

-- CreateIndex
CREATE INDEX "shipment_event_eventType_occurredAt_idx" ON "shipment_event"("eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "shipment_event_branchId_occurredAt_idx" ON "shipment_event"("branchId", "occurredAt");

-- CreateIndex
CREATE INDEX "shipment_event_occurredAt_idx" ON "shipment_event"("occurredAt");

-- CreateIndex
CREATE INDEX "bulk_upload_batch_branchId_createdAt_idx" ON "bulk_upload_batch"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "bulk_upload_row_batchId_status_idx" ON "bulk_upload_row"("batchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_upload_row_batchId_rowNumber_key" ON "bulk_upload_row"("batchId", "rowNumber");

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_billingCityId_fkey" FOREIGN KEY ("billingCityId") REFERENCES "city"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contact" ADD CONSTRAINT "customer_contact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "customer_address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_request" ADD CONSTRAINT "pickup_request_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_assignment" ADD CONSTRAINT "pickup_assignment_pickupRequestId_fkey" FOREIGN KEY ("pickupRequestId") REFERENCES "pickup_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_assignment" ADD CONSTRAINT "pickup_assignment_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_attempt" ADD CONSTRAINT "pickup_attempt_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "pickup_assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_attempt" ADD CONSTRAINT "pickup_attempt_reasonCodeId_fkey" FOREIGN KEY ("reasonCodeId") REFERENCES "reason_code"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_serviceTypeId_fkey" FOREIGN KEY ("serviceTypeId") REFERENCES "service_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_packageTypeId_fkey" FOREIGN KEY ("packageTypeId") REFERENCES "package_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_bookingBranchId_fkey" FOREIGN KEY ("bookingBranchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_originBranchId_fkey" FOREIGN KEY ("originBranchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_destinationBranchId_fkey" FOREIGN KEY ("destinationBranchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_currentBranchId_fkey" FOREIGN KEY ("currentBranchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_consignorId_fkey" FOREIGN KEY ("consignorId") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_consignorCityId_fkey" FOREIGN KEY ("consignorCityId") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_consigneeCityId_fkey" FOREIGN KEY ("consigneeCityId") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_bookedById_fkey" FOREIGN KEY ("bookedById") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_holdReasonId_fkey" FOREIGN KEY ("holdReasonId") REFERENCES "reason_code"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_cancelReasonId_fkey" FOREIGN KEY ("cancelReasonId") REFERENCES "reason_code"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_package" ADD CONSTRAINT "shipment_package_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_package" ADD CONSTRAINT "shipment_package_packageTypeId_fkey" FOREIGN KEY ("packageTypeId") REFERENCES "package_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_package" ADD CONSTRAINT "shipment_package_currentBranchId_fkey" FOREIGN KEY ("currentBranchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_charge" ADD CONSTRAINT "shipment_charge_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_charge" ADD CONSTRAINT "shipment_charge_chargeTypeId_fkey" FOREIGN KEY ("chargeTypeId") REFERENCES "charge_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_charge" ADD CONSTRAINT "shipment_charge_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "tax_rate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_event" ADD CONSTRAINT "shipment_event_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_event" ADD CONSTRAINT "shipment_event_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "shipment_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_event" ADD CONSTRAINT "shipment_event_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_event" ADD CONSTRAINT "shipment_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_event" ADD CONSTRAINT "shipment_event_reasonCodeId_fkey" FOREIGN KEY ("reasonCodeId") REFERENCES "reason_code"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_upload_batch" ADD CONSTRAINT "bulk_upload_batch_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_upload_row" ADD CONSTRAINT "bulk_upload_row_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "bulk_upload_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
