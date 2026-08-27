-- CreateEnum
CREATE TYPE "VehicleOwnership" AS ENUM ('OWN', 'VENDOR', 'ATTACHED');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'LOADING', 'DISPATCHED', 'IN_TRANSIT', 'AT_HUB', 'UNLOADING', 'MAINTENANCE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('RC', 'INSURANCE', 'FITNESS', 'PERMIT_NATIONAL', 'PERMIT_STATE', 'PUC', 'ROAD_TAX', 'DRIVING_LICENCE', 'ID_PROOF', 'ADDRESS_PROOF', 'POLICE_VERIFICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('AVAILABLE', 'ON_TRIP', 'ON_LEAVE', 'SUSPENDED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ScanType" AS ENUM ('INBOUND', 'OUTBOUND', 'SORT', 'LOAD', 'UNLOAD', 'DELIVERY_OUT', 'DELIVERY_IN', 'AUDIT');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('OPEN', 'CLOSED', 'RECONCILED');

-- CreateEnum
CREATE TYPE "DiscrepancyKind" AS ENUM ('SHORT', 'EXCESS', 'DAMAGED', 'MISROUTED', 'SEAL_BROKEN');

-- CreateEnum
CREATE TYPE "DeliveryRunStatus" AS ENUM ('PLANNED', 'STARTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryTaskStatus" AS ENUM ('PENDING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PodAssetKind" AS ENUM ('SIGNATURE', 'DELIVERY_PHOTO', 'PACKAGE_PHOTO', 'ID_PROOF');

-- CreateEnum
CREATE TYPE "CodMode" AS ENUM ('CASH', 'UPI', 'CARD', 'CHEQUE', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "CodState" AS ENUM ('COLLECTED', 'DEPOSITED', 'RECONCILED', 'REMITTED');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'VERIFIED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "RemittanceStatus" AS ENUM ('DRAFT', 'SENT', 'SETTLED');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('PLANNED', 'VEHICLE_REPORTED', 'LOADING', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED', 'UNLOADING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ManifestStatus" AS ENUM ('DRAFT', 'CLOSED', 'DISPATCHED', 'RECEIVED', 'RECONCILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LoadingSheetStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "vehicle_type" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacityKg" DECIMAL(10,2) NOT NULL,
    "capacityCft" DECIMAL(10,2),
    "lengthFt" DECIMAL(6,2),
    "widthFt" DECIMAL(6,2),
    "heightFt" DECIMAL(6,2),
    "axles" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "vehicleTypeId" TEXT NOT NULL,
    "ownership" "VehicleOwnership" NOT NULL DEFAULT 'OWN',
    "vendorId" TEXT,
    "branchId" TEXT,
    "status" "VehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
    "gpsDeviceId" TEXT,
    "fastagId" TEXT,
    "currentOdometerKm" INTEGER,
    "make" TEXT,
    "model" TEXT,
    "manufactureYear" INTEGER,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_document" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "documentNumber" TEXT,
    "issuedOn" DATE,
    "expiresOn" DATE,
    "fileAssetId" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_status_log" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "fromStatus" "VehicleStatus",
    "toStatus" "VehicleStatus" NOT NULL,
    "tripId" TEXT,
    "branchId" TEXT,
    "userId" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_status_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_record" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dueOn" DATE,
    "dueOdometerKm" INTEGER,
    "completedOn" DATE,
    "costAmount" DECIMAL(14,2),
    "downtimeDays" INTEGER,
    "vendorName" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "altMobile" TEXT,
    "address" TEXT,
    "cityId" TEXT,
    "userId" TEXT,
    "vendorId" TEXT,
    "branchId" TEXT,
    "licenceNumber" TEXT,
    "licenceClass" TEXT,
    "licenceExpiry" DATE,
    "bloodGroup" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "status" "DriverStatus" NOT NULL DEFAULT 'AVAILABLE',
    "photoAssetId" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_document" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "documentNumber" TEXT,
    "issuedOn" DATE,
    "expiresOn" DATE,
    "fileAssetId" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_record" (
    "id" TEXT NOT NULL,
    "scanType" "ScanType" NOT NULL,
    "barcode" TEXT NOT NULL,
    "packageId" TEXT,
    "shipmentId" TEXT,
    "branchId" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "manifestId" TEXT,
    "tripId" TEXT,
    "loadingSheetId" TEXT,
    "receiptId" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "isExpected" BOOLEAN NOT NULL DEFAULT true,
    "remarks" TEXT,

    CONSTRAINT "scan_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_receipt" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "manifestId" TEXT,
    "tripId" TEXT,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'OPEN',
    "expectedShipments" INTEGER NOT NULL DEFAULT 0,
    "expectedPackages" INTEGER NOT NULL DEFAULT 0,
    "scannedPackages" INTEGER NOT NULL DEFAULT 0,
    "shortPackages" INTEGER NOT NULL DEFAULT 0,
    "excessPackages" INTEGER NOT NULL DEFAULT 0,
    "damagedPackages" INTEGER NOT NULL DEFAULT 0,
    "sealIntact" BOOLEAN,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "remarks" TEXT,

    CONSTRAINT "inbound_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_receipt_line" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "expectedPackages" INTEGER NOT NULL,
    "scannedPackages" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_receipt_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_discrepancy" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "kind" "DiscrepancyKind" NOT NULL,
    "shipmentId" TEXT,
    "packageId" TEXT,
    "barcode" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "reasonCodeId" TEXT,
    "ownerBranchId" TEXT,
    "photoAssetId" TEXT,
    "remarks" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "receipt_discrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sort_bin" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "destinationBranchId" TEXT,
    "capacity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sort_bin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_location" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "binId" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placedById" TEXT,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "package_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_run" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "status" "DeliveryRunStatus" NOT NULL DEFAULT 'PLANNED',
    "agentId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "runDate" DATE NOT NULL,
    "totalTasks" INTEGER NOT NULL DEFAULT 0,
    "completedTasks" INTEGER NOT NULL DEFAULT 0,
    "failedTasks" INTEGER NOT NULL DEFAULT 0,
    "codExpected" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "codCollected" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "delivery_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_task" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "shipmentId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "status" "DeliveryTaskStatus" NOT NULL DEFAULT 'PENDING',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "codAmount" DECIMAL(14,2),
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempt" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "outcome" "AttemptOutcome" NOT NULL,
    "reasonCodeId" TEXT,
    "receiverName" TEXT,
    "receiverRelation" TEXT,
    "otpVerified" BOOLEAN NOT NULL DEFAULT false,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "deviceId" TEXT,
    "remarks" TEXT,
    "photoAssetId" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clockDriftSeconds" INTEGER,
    "agentId" TEXT,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "delivery_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pod" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "receiverName" TEXT NOT NULL,
    "receiverRelation" TEXT,
    "receiverPhone" TEXT,
    "signatureAssetId" TEXT,
    "photoAssetId" TEXT,
    "otpReference" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentId" TEXT,
    "remarks" TEXT,
    "documentAssetId" TEXT,
    "generatedAt" TIMESTAMP(3),

    CONSTRAINT "pod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pod_asset" (
    "id" TEXT NOT NULL,
    "podId" TEXT NOT NULL,
    "kind" "PodAssetKind" NOT NULL,
    "fileAssetId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cod_collection" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "taskId" TEXT,
    "branchId" TEXT NOT NULL,
    "agentId" TEXT,
    "amountExpected" DECIMAL(14,2) NOT NULL,
    "amountCollected" DECIMAL(14,2) NOT NULL,
    "mode" "CodMode" NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "state" "CodState" NOT NULL DEFAULT 'COLLECTED',
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "depositId" TEXT,
    "remittanceId" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cod_collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cod_deposit" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "depositDate" DATE NOT NULL,
    "amountDeclared" DECIMAL(14,2) NOT NULL,
    "amountVerified" DECIMAL(14,2),
    "shortfall" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "mode" "CodMode" NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "slipAssetId" TEXT,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cod_remittance" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "RemittanceStatus" NOT NULL DEFAULT 'DRAFT',
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "grossAmount" DECIMAL(14,2) NOT NULL,
    "feeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "paidAt" TIMESTAMP(3),
    "adviceAssetId" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "cod_remittance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'PLANNED',
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "vendorId" TEXT,
    "routeId" TEXT,
    "originBranchId" TEXT NOT NULL,
    "destinationBranchId" TEXT NOT NULL,
    "plannedDepartureAt" TIMESTAMP(3),
    "actualDepartureAt" TIMESTAMP(3),
    "plannedArrivalAt" TIMESTAMP(3),
    "actualArrivalAt" TIMESTAMP(3),
    "startOdometerKm" INTEGER,
    "endOdometerKm" INTEGER,
    "distanceKm" DECIMAL(10,2),
    "ftlShipmentId" TEXT,
    "sealNumber" TEXT,
    "sealBrokenBy" TEXT,
    "freightPayable" DECIMAL(14,2),
    "advancePaid" DECIMAL(14,2),
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_event" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "branchId" TEXT,
    "userId" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "odometerKm" INTEGER,
    "remarks" TEXT,
    "payload" JSONB,

    CONSTRAINT "trip_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manifest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "ManifestStatus" NOT NULL DEFAULT 'DRAFT',
    "tripId" TEXT,
    "originBranchId" TEXT NOT NULL,
    "destinationBranchId" TEXT NOT NULL,
    "totalShipments" INTEGER NOT NULL DEFAULT 0,
    "totalPackages" INTEGER NOT NULL DEFAULT 0,
    "totalWeight" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "manifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manifest_line" (
    "id" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "packageCount" INTEGER NOT NULL,
    "weight" DECIMAL(10,3) NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById" TEXT,

    CONSTRAINT "manifest_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loading_sheet" (
    "id" TEXT NOT NULL,
    "tripId" TEXT,
    "manifestId" TEXT,
    "branchId" TEXT NOT NULL,
    "status" "LoadingSheetStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,

    CONSTRAINT "loading_sheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loading_sheet_line" (
    "id" TEXT NOT NULL,
    "loadingSheetId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scannedById" TEXT,

    CONSTRAINT "loading_sheet_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_expense" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "incurredOn" DATE NOT NULL,
    "paidBy" TEXT,
    "billAssetId" TEXT,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "trip_expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eway_bill_record" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "ewayBillNumber" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "vehicleNumber" TEXT,
    "fromPlace" TEXT,
    "validUpto" TIMESTAMP(3),
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "isSuccess" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "eway_bill_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_type_code_key" ON "vehicle_type"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_registrationNumber_key" ON "vehicle"("registrationNumber");

-- CreateIndex
CREATE INDEX "vehicle_status_isActive_idx" ON "vehicle"("status", "isActive");

-- CreateIndex
CREATE INDEX "vehicle_branchId_idx" ON "vehicle"("branchId");

-- CreateIndex
CREATE INDEX "vehicle_gpsDeviceId_idx" ON "vehicle"("gpsDeviceId");

-- CreateIndex
CREATE INDEX "vehicle_document_vehicleId_kind_idx" ON "vehicle_document"("vehicleId", "kind");

-- CreateIndex
CREATE INDEX "vehicle_document_expiresOn_idx" ON "vehicle_document"("expiresOn");

-- CreateIndex
CREATE INDEX "vehicle_status_log_vehicleId_createdAt_idx" ON "vehicle_status_log"("vehicleId", "createdAt");

-- CreateIndex
CREATE INDEX "maintenance_record_vehicleId_completedOn_idx" ON "maintenance_record"("vehicleId", "completedOn");

-- CreateIndex
CREATE UNIQUE INDEX "driver_mobile_key" ON "driver"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "driver_userId_key" ON "driver"("userId");

-- CreateIndex
CREATE INDEX "driver_status_isActive_idx" ON "driver"("status", "isActive");

-- CreateIndex
CREATE INDEX "driver_licenceExpiry_idx" ON "driver"("licenceExpiry");

-- CreateIndex
CREATE UNIQUE INDEX "driver_orgId_code_key" ON "driver"("orgId", "code");

-- CreateIndex
CREATE INDEX "driver_document_driverId_kind_idx" ON "driver_document"("driverId", "kind");

-- CreateIndex
CREATE INDEX "driver_document_expiresOn_idx" ON "driver_document"("expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "scan_record_idempotencyKey_key" ON "scan_record"("idempotencyKey");

-- CreateIndex
CREATE INDEX "scan_record_branchId_scannedAt_idx" ON "scan_record"("branchId", "scannedAt");

-- CreateIndex
CREATE INDEX "scan_record_barcode_scannedAt_idx" ON "scan_record"("barcode", "scannedAt");

-- CreateIndex
CREATE INDEX "scan_record_shipmentId_idx" ON "scan_record"("shipmentId");

-- CreateIndex
CREATE INDEX "scan_record_manifestId_scanType_idx" ON "scan_record"("manifestId", "scanType");

-- CreateIndex
CREATE INDEX "inbound_receipt_branchId_status_idx" ON "inbound_receipt"("branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_receipt_line_receiptId_shipmentId_key" ON "inbound_receipt_line"("receiptId", "shipmentId");

-- CreateIndex
CREATE INDEX "receipt_discrepancy_receiptId_kind_idx" ON "receipt_discrepancy"("receiptId", "kind");

-- CreateIndex
CREATE INDEX "receipt_discrepancy_shipmentId_idx" ON "receipt_discrepancy"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "sort_bin_branchId_code_key" ON "sort_bin"("branchId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "package_location_packageId_key" ON "package_location"("packageId");

-- CreateIndex
CREATE INDEX "package_location_branchId_binId_idx" ON "package_location"("branchId", "binId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_run_number_key" ON "delivery_run"("number");

-- CreateIndex
CREATE INDEX "delivery_run_branchId_runDate_status_idx" ON "delivery_run"("branchId", "runDate", "status");

-- CreateIndex
CREATE INDEX "delivery_run_agentId_runDate_idx" ON "delivery_run"("agentId", "runDate");

-- CreateIndex
CREATE INDEX "delivery_task_branchId_status_idx" ON "delivery_task"("branchId", "status");

-- CreateIndex
CREATE INDEX "delivery_task_shipmentId_idx" ON "delivery_task"("shipmentId");

-- CreateIndex
CREATE INDEX "delivery_task_runId_sequence_idx" ON "delivery_task"("runId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempt_idempotencyKey_key" ON "delivery_attempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "delivery_attempt_shipmentId_attemptedAt_idx" ON "delivery_attempt"("shipmentId", "attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempt_taskId_attemptNumber_key" ON "delivery_attempt"("taskId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "pod_taskId_key" ON "pod"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "pod_shipmentId_key" ON "pod"("shipmentId");

-- CreateIndex
CREATE INDEX "pod_deliveredAt_idx" ON "pod"("deliveredAt");

-- CreateIndex
CREATE INDEX "pod_asset_podId_idx" ON "pod_asset"("podId");

-- CreateIndex
CREATE UNIQUE INDEX "cod_collection_shipmentId_key" ON "cod_collection"("shipmentId");

-- CreateIndex
CREATE INDEX "cod_collection_branchId_state_idx" ON "cod_collection"("branchId", "state");

-- CreateIndex
CREATE INDEX "cod_collection_agentId_collectedAt_idx" ON "cod_collection"("agentId", "collectedAt");

-- CreateIndex
CREATE INDEX "cod_deposit_branchId_depositDate_idx" ON "cod_deposit"("branchId", "depositDate");

-- CreateIndex
CREATE INDEX "cod_deposit_agentId_depositDate_idx" ON "cod_deposit"("agentId", "depositDate");

-- CreateIndex
CREATE INDEX "cod_remittance_customerId_status_idx" ON "cod_remittance"("customerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trip_number_key" ON "trip"("number");

-- CreateIndex
CREATE INDEX "trip_status_plannedDepartureAt_idx" ON "trip"("status", "plannedDepartureAt");

-- CreateIndex
CREATE INDEX "trip_vehicleId_status_idx" ON "trip"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "trip_driverId_status_idx" ON "trip"("driverId", "status");

-- CreateIndex
CREATE INDEX "trip_event_tripId_occurredAt_idx" ON "trip_event"("tripId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "manifest_number_key" ON "manifest"("number");

-- CreateIndex
CREATE INDEX "manifest_status_createdAt_idx" ON "manifest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "manifest_originBranchId_status_idx" ON "manifest"("originBranchId", "status");

-- CreateIndex
CREATE INDEX "manifest_destinationBranchId_status_idx" ON "manifest"("destinationBranchId", "status");

-- CreateIndex
CREATE INDEX "manifest_line_shipmentId_idx" ON "manifest_line"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "manifest_line_manifestId_shipmentId_key" ON "manifest_line"("manifestId", "shipmentId");

-- CreateIndex
CREATE INDEX "loading_sheet_branchId_status_idx" ON "loading_sheet"("branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "loading_sheet_line_loadingSheetId_packageId_key" ON "loading_sheet_line"("loadingSheetId", "packageId");

-- CreateIndex
CREATE INDEX "trip_expense_tripId_idx" ON "trip_expense"("tripId");

-- CreateIndex
CREATE INDEX "eway_bill_record_shipmentId_createdAt_idx" ON "eway_bill_record"("shipmentId", "createdAt");

-- CreateIndex
CREATE INDEX "eway_bill_record_ewayBillNumber_idx" ON "eway_bill_record"("ewayBillNumber");

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_vehicleTypeId_fkey" FOREIGN KEY ("vehicleTypeId") REFERENCES "vehicle_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_document" ADD CONSTRAINT "vehicle_document_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_status_log" ADD CONSTRAINT "vehicle_status_log_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_record" ADD CONSTRAINT "maintenance_record_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver" ADD CONSTRAINT "driver_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_document" ADD CONSTRAINT "driver_document_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_record" ADD CONSTRAINT "scan_record_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "shipment_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_record" ADD CONSTRAINT "scan_record_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_record" ADD CONSTRAINT "scan_record_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_record" ADD CONSTRAINT "scan_record_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_receipt" ADD CONSTRAINT "inbound_receipt_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_receipt" ADD CONSTRAINT "inbound_receipt_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES "manifest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_receipt_line" ADD CONSTRAINT "inbound_receipt_line_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "inbound_receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_receipt_line" ADD CONSTRAINT "inbound_receipt_line_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_discrepancy" ADD CONSTRAINT "receipt_discrepancy_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "inbound_receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_discrepancy" ADD CONSTRAINT "receipt_discrepancy_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sort_bin" ADD CONSTRAINT "sort_bin_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_location" ADD CONSTRAINT "package_location_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "shipment_package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_location" ADD CONSTRAINT "package_location_binId_fkey" FOREIGN KEY ("binId") REFERENCES "sort_bin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_run" ADD CONSTRAINT "delivery_run_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_run" ADD CONSTRAINT "delivery_run_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_task" ADD CONSTRAINT "delivery_task_runId_fkey" FOREIGN KEY ("runId") REFERENCES "delivery_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_task" ADD CONSTRAINT "delivery_task_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_task" ADD CONSTRAINT "delivery_task_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "delivery_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod" ADD CONSTRAINT "pod_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "delivery_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod" ADD CONSTRAINT "pod_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_asset" ADD CONSTRAINT "pod_asset_podId_fkey" FOREIGN KEY ("podId") REFERENCES "pod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_collection" ADD CONSTRAINT "cod_collection_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_collection" ADD CONSTRAINT "cod_collection_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_collection" ADD CONSTRAINT "cod_collection_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "cod_deposit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_collection" ADD CONSTRAINT "cod_collection_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "cod_remittance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_deposit" ADD CONSTRAINT "cod_deposit_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_remittance" ADD CONSTRAINT "cod_remittance_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_originBranchId_fkey" FOREIGN KEY ("originBranchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_destinationBranchId_fkey" FOREIGN KEY ("destinationBranchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_ftlShipmentId_fkey" FOREIGN KEY ("ftlShipmentId") REFERENCES "shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_event" ADD CONSTRAINT "trip_event_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifest" ADD CONSTRAINT "manifest_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifest" ADD CONSTRAINT "manifest_originBranchId_fkey" FOREIGN KEY ("originBranchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifest" ADD CONSTRAINT "manifest_destinationBranchId_fkey" FOREIGN KEY ("destinationBranchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifest_line" ADD CONSTRAINT "manifest_line_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES "manifest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifest_line" ADD CONSTRAINT "manifest_line_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loading_sheet" ADD CONSTRAINT "loading_sheet_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loading_sheet_line" ADD CONSTRAINT "loading_sheet_line_loadingSheetId_fkey" FOREIGN KEY ("loadingSheetId") REFERENCES "loading_sheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loading_sheet_line" ADD CONSTRAINT "loading_sheet_line_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "shipment_package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_expense" ADD CONSTRAINT "trip_expense_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
