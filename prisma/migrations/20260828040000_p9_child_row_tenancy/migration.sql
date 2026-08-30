-- Every tenant-owned table carries the tenant key.
--
-- This closes the class of hole the adversarial suite found on the event
-- log. ADR 001 §1 originally said a child row reachable only through a
-- scoped parent inherits isolation through its foreign key; the amendment
-- at the foot of that document explains why that was wrong. Two reasons,
-- either of which is sufficient:
--
--   1. The Prisma extension rewrites a top-level `where`, not a nested
--      relation filter, so `child.findMany({ where: { parent: { id } } })`
--      crossed tenants. "Reached through its parent" is a property of every
--      call site, present and future, and nothing enforces it.
--   2. A row-level security policy can only be written on a table that
--      holds the tenant key. Every table without one was a hole in the
--      backstop in exactly the place the application layer also had one —
--      the two mechanisms failing together rather than independently.
--
-- Forty-five tables, all derived from a parent that already holds the key.
-- Where a parent gains its own key in this same migration, the derivation
-- walks past it to one that does not.

DO $guard$
DECLARE org_count INT;
BEGIN
  SELECT count(*) INTO org_count FROM "organization";
  IF org_count > 2 THEN
    RAISE EXCEPTION 'Backfill derives orgId per row from its parent; % organisations present, review first.', org_count;
  END IF;
END
$guard$;

-- 1. Columns, nullable for now --------------------------------------------
ALTER TABLE "branch_holiday"        ADD COLUMN "orgId" TEXT;
ALTER TABLE "bulk_upload_row"       ADD COLUMN "orgId" TEXT;
ALTER TABLE "charge_rule"           ADD COLUMN "orgId" TEXT;
ALTER TABLE "cod_collection"        ADD COLUMN "orgId" TEXT;
ALTER TABLE "cod_deposit"           ADD COLUMN "orgId" TEXT;
ALTER TABLE "cod_remittance"        ADD COLUMN "orgId" TEXT;
ALTER TABLE "complaint_message"     ADD COLUMN "orgId" TEXT;
ALTER TABLE "customer_address"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "customer_contact"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "delivery_attempt"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "driver_document"       ADD COLUMN "orgId" TEXT;
ALTER TABLE "exception_action"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "freight_calculation"   ADD COLUMN "orgId" TEXT;
ALTER TABLE "geofence_event"        ADD COLUMN "orgId" TEXT;
ALTER TABLE "inbound_receipt_line"  ADD COLUMN "orgId" TEXT;
ALTER TABLE "invoice_line"          ADD COLUMN "orgId" TEXT;
ALTER TABLE "loading_sheet"         ADD COLUMN "orgId" TEXT;
ALTER TABLE "loading_sheet_line"    ADD COLUMN "orgId" TEXT;
ALTER TABLE "maintenance_record"    ADD COLUMN "orgId" TEXT;
ALTER TABLE "manifest_line"         ADD COLUMN "orgId" TEXT;
ALTER TABLE "package_location"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "payment_allocation"    ADD COLUMN "orgId" TEXT;
ALTER TABLE "pickup_assignment"     ADD COLUMN "orgId" TEXT;
ALTER TABLE "pickup_attempt"        ADD COLUMN "orgId" TEXT;
ALTER TABLE "pod"                   ADD COLUMN "orgId" TEXT;
ALTER TABLE "pod_asset"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "rate_card_version"     ADD COLUMN "orgId" TEXT;
ALTER TABLE "rate_slab"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "receipt_discrepancy"   ADD COLUMN "orgId" TEXT;
ALTER TABLE "role_permission"       ADD COLUMN "orgId" TEXT;
ALTER TABLE "route_leg"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "shipment_charge"       ADD COLUMN "orgId" TEXT;
ALTER TABLE "shipment_sla"          ADD COLUMN "orgId" TEXT;
ALTER TABLE "sort_bin"              ADD COLUMN "orgId" TEXT;
ALTER TABLE "trip_event"            ADD COLUMN "orgId" TEXT;
ALTER TABLE "trip_expense"          ADD COLUMN "orgId" TEXT;
ALTER TABLE "user_branch_scope"     ADD COLUMN "orgId" TEXT;
ALTER TABLE "user_role"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "vehicle_document"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "vehicle_status_log"    ADD COLUMN "orgId" TEXT;
ALTER TABLE "vendor_bank_account"   ADD COLUMN "orgId" TEXT;
ALTER TABLE "vendor_bill_line"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "vendor_rate_contract"  ADD COLUMN "orgId" TEXT;
ALTER TABLE "vendor_rate_line"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "zone_pincode"          ADD COLUMN "orgId" TEXT;

-- 2. Backfill from the owning row -----------------------------------------
UPDATE "branch_holiday" c       SET "orgId" = p."orgId" FROM "branch" p              WHERE p.id = c."branchId";
UPDATE "bulk_upload_row" c      SET "orgId" = p."orgId" FROM "bulk_upload_batch" p   WHERE p.id = c."batchId";
UPDATE "cod_collection" c       SET "orgId" = p."orgId" FROM "shipment" p            WHERE p.id = c."shipmentId";
UPDATE "cod_deposit" c          SET "orgId" = p."orgId" FROM "branch" p              WHERE p.id = c."branchId";
UPDATE "cod_remittance" c       SET "orgId" = p."orgId" FROM "customer" p            WHERE p.id = c."customerId";
UPDATE "complaint_message" c    SET "orgId" = p."orgId" FROM "complaint" p           WHERE p.id = c."complaintId";
UPDATE "customer_address" c     SET "orgId" = p."orgId" FROM "customer" p            WHERE p.id = c."customerId";
UPDATE "customer_contact" c     SET "orgId" = p."orgId" FROM "customer" p            WHERE p.id = c."customerId";
UPDATE "delivery_attempt" c     SET "orgId" = p."orgId" FROM "delivery_task" p       WHERE p.id = c."taskId";
UPDATE "driver_document" c      SET "orgId" = p."orgId" FROM "driver" p              WHERE p.id = c."driverId";
UPDATE "exception_action" c     SET "orgId" = p."orgId" FROM "exception" p           WHERE p.id = c."exceptionId";
UPDATE "freight_calculation" c  SET "orgId" = p."orgId" FROM "shipment" p            WHERE p.id = c."shipmentId";
UPDATE "geofence_event" c       SET "orgId" = p."orgId" FROM "geofence" p            WHERE p.id = c."geofenceId";
UPDATE "inbound_receipt_line" c SET "orgId" = p."orgId" FROM "inbound_receipt" p     WHERE p.id = c."receiptId";
UPDATE "invoice_line" c         SET "orgId" = p."orgId" FROM "invoice" p             WHERE p.id = c."invoiceId";
UPDATE "loading_sheet" c        SET "orgId" = p."orgId" FROM "branch" p              WHERE p.id = c."branchId";
UPDATE "loading_sheet_line" c   SET "orgId" = p."orgId" FROM "shipment_package" p    WHERE p.id = c."packageId";
UPDATE "maintenance_record" c   SET "orgId" = p."orgId" FROM "vehicle" p             WHERE p.id = c."vehicleId";
UPDATE "manifest_line" c        SET "orgId" = p."orgId" FROM "manifest" p            WHERE p.id = c."manifestId";
UPDATE "package_location" c     SET "orgId" = p."orgId" FROM "shipment_package" p    WHERE p.id = c."packageId";
UPDATE "payment_allocation" c   SET "orgId" = p."orgId" FROM "payment" p             WHERE p.id = c."paymentId";
UPDATE "pickup_assignment" c    SET "orgId" = p."orgId" FROM "pickup_request" p      WHERE p.id = c."pickupRequestId";
UPDATE "pod" c                  SET "orgId" = p."orgId" FROM "shipment" p            WHERE p.id = c."shipmentId";
UPDATE "rate_card_version" c    SET "orgId" = p."orgId" FROM "rate_card" p           WHERE p.id = c."rateCardId";
UPDATE "receipt_discrepancy" c  SET "orgId" = p."orgId" FROM "inbound_receipt" p     WHERE p.id = c."receiptId";
UPDATE "role_permission" c      SET "orgId" = p."orgId" FROM "role" p                WHERE p.id = c."roleId";
UPDATE "route_leg" c            SET "orgId" = p."orgId" FROM "route" p               WHERE p.id = c."routeId";
UPDATE "shipment_charge" c      SET "orgId" = p."orgId" FROM "shipment" p            WHERE p.id = c."shipmentId";
UPDATE "shipment_sla" c         SET "orgId" = p."orgId" FROM "shipment" p            WHERE p.id = c."shipmentId";
UPDATE "sort_bin" c             SET "orgId" = p."orgId" FROM "branch" p              WHERE p.id = c."branchId";
UPDATE "trip_event" c           SET "orgId" = p."orgId" FROM "trip" p                WHERE p.id = c."tripId";
UPDATE "trip_expense" c         SET "orgId" = p."orgId" FROM "trip" p                WHERE p.id = c."tripId";
UPDATE "user_branch_scope" c    SET "orgId" = p."orgId" FROM "app_user" p            WHERE p.id = c."userId";
UPDATE "user_role" c            SET "orgId" = p."orgId" FROM "app_user" p            WHERE p.id = c."userId";
UPDATE "vehicle_document" c     SET "orgId" = p."orgId" FROM "vehicle" p             WHERE p.id = c."vehicleId";
UPDATE "vehicle_status_log" c   SET "orgId" = p."orgId" FROM "vehicle" p             WHERE p.id = c."vehicleId";
UPDATE "vendor_bank_account" c  SET "orgId" = p."orgId" FROM "vendor" p              WHERE p.id = c."vendorId";
UPDATE "vendor_bill_line" c     SET "orgId" = p."orgId" FROM "vendor_bill" p         WHERE p.id = c."billId";
UPDATE "vendor_rate_contract" c SET "orgId" = p."orgId" FROM "vendor" p              WHERE p.id = c."vendorId";
UPDATE "zone_pincode" c         SET "orgId" = p."orgId" FROM "zone" p                WHERE p.id = c."zoneId";

-- Two hops, because the immediate parent only gains its own key in this
-- same migration and would still be NULL at this point.
UPDATE "charge_rule" c SET "orgId" = rc."orgId"
  FROM "rate_card_version" v JOIN "rate_card" rc ON rc.id = v."rateCardId"
  WHERE v.id = c."versionId";

UPDATE "rate_slab" c SET "orgId" = rc."orgId"
  FROM "rate_card_version" v JOIN "rate_card" rc ON rc.id = v."rateCardId"
  WHERE v.id = c."versionId";

UPDATE "pickup_attempt" c SET "orgId" = pr."orgId"
  FROM "pickup_assignment" pa JOIN "pickup_request" pr ON pr.id = pa."pickupRequestId"
  WHERE pa.id = c."assignmentId";

UPDATE "pod_asset" c SET "orgId" = s."orgId"
  FROM "pod" pd JOIN "shipment" s ON s.id = pd."shipmentId"
  WHERE pd.id = c."podId";

UPDATE "vendor_rate_line" c SET "orgId" = v."orgId"
  FROM "vendor_rate_contract" vrc JOIN "vendor" v ON v.id = vrc."vendorId"
  WHERE vrc.id = c."contractId";

-- 3. Cross-checks ---------------------------------------------------------
-- A zone and a pincode are both tenant-owned, so a zone membership row
-- whose two sides disagree would mean a zone already spans carriers. Free
-- to check here, and impossible to notice later.
DO $crosscheck$
DECLARE straddling BIGINT;
BEGIN
  SELECT count(*) INTO straddling
  FROM "zone_pincode" zp
  JOIN "pincode" p ON p.id = zp."pincodeId"
  WHERE p."orgId" <> zp."orgId";

  IF straddling > 0 THEN
    RAISE EXCEPTION '% zone memberships join a zone and a pincode owned by different organisations', straddling;
  END IF;
END
$crosscheck$;

DO $check$
DECLARE
  t TEXT;
  missing BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branch_holiday','bulk_upload_row','charge_rule','cod_collection','cod_deposit',
    'cod_remittance','complaint_message','customer_address','customer_contact',
    'delivery_attempt','driver_document','exception_action','freight_calculation',
    'geofence_event','inbound_receipt_line','invoice_line','loading_sheet',
    'loading_sheet_line','maintenance_record','manifest_line','package_location',
    'payment_allocation','pickup_assignment','pickup_attempt','pod','pod_asset',
    'rate_card_version','rate_slab','receipt_discrepancy','role_permission',
    'route_leg','shipment_charge','shipment_sla','sort_bin','trip_event',
    'trip_expense','user_branch_scope','user_role','vehicle_document',
    'vehicle_status_log','vendor_bank_account','vendor_bill_line',
    'vendor_rate_contract','vendor_rate_line','zone_pincode'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "orgId" IS NULL', t) INTO missing;
    IF missing > 0 THEN
      RAISE EXCEPTION 'Backfill missed % rows in %', missing, t;
    END IF;
  END LOOP;
END
$check$;

-- 4. Make the tenant key required -----------------------------------------
ALTER TABLE "branch_holiday"        ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "bulk_upload_row"       ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "charge_rule"           ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "cod_collection"        ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "cod_deposit"           ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "cod_remittance"        ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "complaint_message"     ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "customer_address"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "customer_contact"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "delivery_attempt"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "driver_document"       ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "exception_action"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "freight_calculation"   ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "geofence_event"        ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "inbound_receipt_line"  ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "invoice_line"          ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "loading_sheet"         ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "loading_sheet_line"    ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "maintenance_record"    ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "manifest_line"         ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "package_location"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "payment_allocation"    ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "pickup_assignment"     ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "pickup_attempt"        ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "pod"                   ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "pod_asset"             ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "rate_card_version"     ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "rate_slab"             ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "receipt_discrepancy"   ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "role_permission"       ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "route_leg"             ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "shipment_charge"       ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "shipment_sla"          ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "sort_bin"              ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "trip_event"            ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "trip_expense"          ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "user_branch_scope"     ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "user_role"             ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "vehicle_document"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "vehicle_status_log"    ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "vendor_bank_account"   ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "vendor_bill_line"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "vendor_rate_contract"  ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "vendor_rate_line"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "zone_pincode"          ALTER COLUMN "orgId" SET NOT NULL;

-- 5. Indexes --------------------------------------------------------------
CREATE INDEX "branch_holiday_orgId_idx"        ON "branch_holiday"("orgId");
CREATE INDEX "bulk_upload_row_orgId_idx"       ON "bulk_upload_row"("orgId");
CREATE INDEX "charge_rule_orgId_idx"           ON "charge_rule"("orgId");
CREATE INDEX "cod_collection_orgId_idx"        ON "cod_collection"("orgId");
CREATE INDEX "cod_deposit_orgId_idx"           ON "cod_deposit"("orgId");
CREATE INDEX "cod_remittance_orgId_idx"        ON "cod_remittance"("orgId");
CREATE INDEX "complaint_message_orgId_idx"     ON "complaint_message"("orgId");
CREATE INDEX "customer_address_orgId_idx"      ON "customer_address"("orgId");
CREATE INDEX "customer_contact_orgId_idx"      ON "customer_contact"("orgId");
CREATE INDEX "delivery_attempt_orgId_idx"      ON "delivery_attempt"("orgId");
CREATE INDEX "driver_document_orgId_idx"       ON "driver_document"("orgId");
CREATE INDEX "exception_action_orgId_idx"      ON "exception_action"("orgId");
CREATE INDEX "freight_calculation_orgId_idx"   ON "freight_calculation"("orgId");
CREATE INDEX "geofence_event_orgId_idx"        ON "geofence_event"("orgId");
CREATE INDEX "inbound_receipt_line_orgId_idx"  ON "inbound_receipt_line"("orgId");
CREATE INDEX "invoice_line_orgId_idx"          ON "invoice_line"("orgId");
CREATE INDEX "loading_sheet_orgId_idx"         ON "loading_sheet"("orgId");
CREATE INDEX "loading_sheet_line_orgId_idx"    ON "loading_sheet_line"("orgId");
CREATE INDEX "maintenance_record_orgId_idx"    ON "maintenance_record"("orgId");
CREATE INDEX "manifest_line_orgId_idx"         ON "manifest_line"("orgId");
CREATE INDEX "package_location_orgId_idx"      ON "package_location"("orgId");
CREATE INDEX "payment_allocation_orgId_idx"    ON "payment_allocation"("orgId");
CREATE INDEX "pickup_assignment_orgId_idx"     ON "pickup_assignment"("orgId");
CREATE INDEX "pickup_attempt_orgId_idx"        ON "pickup_attempt"("orgId");
CREATE INDEX "pod_orgId_idx"                   ON "pod"("orgId");
CREATE INDEX "pod_asset_orgId_idx"             ON "pod_asset"("orgId");
CREATE INDEX "rate_card_version_orgId_idx"     ON "rate_card_version"("orgId");
CREATE INDEX "rate_slab_orgId_idx"             ON "rate_slab"("orgId");
CREATE INDEX "receipt_discrepancy_orgId_idx"   ON "receipt_discrepancy"("orgId");
CREATE INDEX "role_permission_orgId_idx"       ON "role_permission"("orgId");
CREATE INDEX "route_leg_orgId_idx"             ON "route_leg"("orgId");
CREATE INDEX "shipment_charge_orgId_idx"       ON "shipment_charge"("orgId");
CREATE INDEX "shipment_sla_orgId_idx"          ON "shipment_sla"("orgId");
CREATE INDEX "sort_bin_orgId_idx"              ON "sort_bin"("orgId");
CREATE INDEX "trip_event_orgId_idx"            ON "trip_event"("orgId");
CREATE INDEX "trip_expense_orgId_idx"          ON "trip_expense"("orgId");
CREATE INDEX "user_branch_scope_orgId_idx"     ON "user_branch_scope"("orgId");
CREATE INDEX "user_role_orgId_idx"             ON "user_role"("orgId");
CREATE INDEX "vehicle_document_orgId_idx"      ON "vehicle_document"("orgId");
CREATE INDEX "vehicle_status_log_orgId_idx"    ON "vehicle_status_log"("orgId");
CREATE INDEX "vendor_bank_account_orgId_idx"   ON "vendor_bank_account"("orgId");
CREATE INDEX "vendor_bill_line_orgId_idx"      ON "vendor_bill_line"("orgId");
CREATE INDEX "vendor_rate_contract_orgId_idx"  ON "vendor_rate_contract"("orgId");
CREATE INDEX "vendor_rate_line_orgId_idx"      ON "vendor_rate_line"("orgId");
CREATE INDEX "zone_pincode_orgId_idx"          ON "zone_pincode"("orgId");

-- 6. Two more client-generated keys move inside the tenant -----------------
-- Both are minted by an offline field queue, so two carriers' devices can
-- produce the same string. On the event log a collision is worse than a
-- duplicate row: it makes a real event look like a retry and swallows it.
DROP INDEX "delivery_attempt_idempotencyKey_key";
DROP INDEX "shipment_event_idempotencyKey_key";

CREATE UNIQUE INDEX "delivery_attempt_orgId_idempotencyKey_key" ON "delivery_attempt"("orgId", "idempotencyKey");
CREATE UNIQUE INDEX "shipment_event_orgId_idempotencyKey_key" ON "shipment_event"("orgId", "idempotencyKey");
