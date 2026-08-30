-- Phase 9 — tenant isolation.
--
-- Twenty-eight tables gain an `orgId`, two nullable ones are tightened to
-- NOT NULL, and every document number and master code stops being unique
-- across the platform and becomes unique within a carrier. See
-- docs/adr/001-multi-tenancy.md.
--
-- The order matters: add nullable, backfill from whatever parent actually
-- knows the answer, prove nothing was missed, and only then make the column
-- required. Adding NOT NULL directly would fail on the first existing row.

-- Guard -------------------------------------------------------------------
-- The fallbacks below assign parentless rows to "the" organisation. That is
-- true only where there is exactly one. Running this against a database that
-- already holds two tenants would silently hand one tenant's masters to the
-- other, so it refuses instead.
--
-- Zero organisations is the other honest case, and refusing it was a bug:
-- a brand new database has no organisation and no rows either, so there is
-- nothing to backfill and nothing that could be assigned wrongly. Refusing
-- meant this migration could never be applied to a fresh install — which is
-- to say the product could not be deployed anywhere it had not already been
-- running. It surfaced the first time CI built a database from scratch.
--
-- So: one organisation backfills, more than one refuses, and none is allowed
-- through only after checking that every table about to gain an `orgId` is
-- genuinely empty. A database somebody has half-emptied still refuses, and
-- names the tables that stopped it.
DO $guard$
DECLARE
  org_count INT;
  target TEXT;
  rows_found BIGINT;
  populated TEXT[] := '{}';
BEGIN
  SELECT count(*) INTO org_count FROM "organization";

  IF org_count = 1 THEN
    RETURN;
  END IF;

  IF org_count > 1 THEN
    RAISE EXCEPTION 'Backfill assumes a single organisation, found %. Backfill by hand instead.', org_count;
  END IF;

  FOREACH target IN ARRAY ARRAY[
    'charge_type', 'city', 'customer_user', 'delivery_task', 'eta_snapshot',
    'eway_bill_record', 'geofence', 'gps_ping', 'inbound_receipt',
    'login_activity', 'notification_log', 'notification_preference',
    'notification_template', 'otp_token', 'outbox_event', 'package_type',
    'pincode', 'reason_code', 'report_run', 'route', 'service_type', 'state',
    'tax_rate', 'tracking_alert', 'vehicle_location', 'vehicle_type',
    'verification_token', 'zone'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %I', target) INTO rows_found;
    IF rows_found > 0 THEN
      populated := populated || target;
    END IF;
  END LOOP;

  IF array_length(populated, 1) > 0 THEN
    RAISE EXCEPTION
      'No organisation exists, but % still hold(s) rows. There is nobody to '
      'assign them to. Backfill by hand instead.',
      array_to_string(populated, ', ');
  END IF;
END
$guard$;

-- 1. Columns, nullable for now --------------------------------------------
ALTER TABLE "charge_type"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "city"                    ADD COLUMN "orgId" TEXT;
ALTER TABLE "customer_user"           ADD COLUMN "orgId" TEXT;
ALTER TABLE "delivery_task"           ADD COLUMN "orgId" TEXT;
ALTER TABLE "eta_snapshot"            ADD COLUMN "orgId" TEXT;
ALTER TABLE "eway_bill_record"        ADD COLUMN "orgId" TEXT;
ALTER TABLE "geofence"                ADD COLUMN "orgId" TEXT;
ALTER TABLE "gps_ping"                ADD COLUMN "orgId" TEXT;
ALTER TABLE "inbound_receipt"         ADD COLUMN "orgId" TEXT;
ALTER TABLE "login_activity"          ADD COLUMN "orgId" TEXT;
ALTER TABLE "notification_log"        ADD COLUMN "orgId" TEXT;
ALTER TABLE "notification_preference" ADD COLUMN "orgId" TEXT;
ALTER TABLE "notification_template"   ADD COLUMN "orgId" TEXT;
ALTER TABLE "otp_token"               ADD COLUMN "orgId" TEXT;
ALTER TABLE "outbox_event"            ADD COLUMN "orgId" TEXT;
ALTER TABLE "package_type"            ADD COLUMN "orgId" TEXT;
ALTER TABLE "pincode"                 ADD COLUMN "orgId" TEXT;
ALTER TABLE "reason_code"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "report_run"              ADD COLUMN "orgId" TEXT;
ALTER TABLE "route"                   ADD COLUMN "orgId" TEXT;
ALTER TABLE "service_type"            ADD COLUMN "orgId" TEXT;
ALTER TABLE "state"                   ADD COLUMN "orgId" TEXT;
ALTER TABLE "tax_rate"                ADD COLUMN "orgId" TEXT;
ALTER TABLE "tracking_alert"          ADD COLUMN "orgId" TEXT;
ALTER TABLE "vehicle_location"        ADD COLUMN "orgId" TEXT;
ALTER TABLE "vehicle_type"            ADD COLUMN "orgId" TEXT;
ALTER TABLE "verification_token"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "zone"                    ADD COLUMN "orgId" TEXT;

-- 2. Backfill --------------------------------------------------------------
-- Masters and platform-issued tokens have no parent to inherit from.
UPDATE "charge_type"           SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "package_type"          SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "service_type"          SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "tax_rate"              SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "reason_code"           SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "vehicle_type"          SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "state"                 SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "zone"                  SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "notification_template" SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "otp_token"             SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "verification_token"    SET "orgId" = (SELECT id FROM "organization" LIMIT 1);
UPDATE "outbox_event"          SET "orgId" = (SELECT id FROM "organization" LIMIT 1);

-- Geography is a chain: state to city to pincode.
UPDATE "city" c    SET "orgId" = s."orgId" FROM "state" s WHERE s.id = c."stateId";
UPDATE "pincode" p SET "orgId" = c."orgId" FROM "city" c  WHERE c.id = p."cityId";

-- Everything else takes the tenant from the row that owns it.
UPDATE "customer_user" cu   SET "orgId" = c."orgId" FROM "customer" c WHERE c.id = cu."customerId";
UPDATE "delivery_task" t    SET "orgId" = s."orgId" FROM "shipment" s WHERE s.id = t."shipmentId";
UPDATE "eta_snapshot" e     SET "orgId" = t."orgId" FROM "trip" t     WHERE t.id = e."tripId";
UPDATE "eway_bill_record" e SET "orgId" = s."orgId" FROM "shipment" s WHERE s.id = e."shipmentId";
UPDATE "inbound_receipt" r  SET "orgId" = b."orgId" FROM "branch" b   WHERE b.id = r."branchId";
UPDATE "tracking_alert" a   SET "orgId" = v."orgId" FROM "vehicle" v  WHERE v.id = a."vehicleId";
UPDATE "vehicle_location" l SET "orgId" = v."orgId" FROM "vehicle" v  WHERE v.id = l."vehicleId";
UPDATE "geofence" g         SET "orgId" = b."orgId" FROM "branch" b   WHERE b.id = g."branchId";
UPDATE "route" r            SET "orgId" = b."orgId" FROM "branch" b   WHERE b.id = r."originBranchId";
UPDATE "login_activity" la  SET "orgId" = u."orgId" FROM "app_user" u WHERE u.id = la."userId";
UPDATE "report_run" rr      SET "orgId" = u."orgId" FROM "app_user" u WHERE u.id = rr."userId";
UPDATE "notification_log" n SET "orgId" = s."orgId" FROM "shipment" s WHERE s.id = n."shipmentId";

-- A GPS fix knows its vehicle either by id or by the device bolted to it.
UPDATE "gps_ping" p SET "orgId" = v."orgId" FROM "vehicle" v WHERE v.id = p."vehicleId";
UPDATE "gps_ping" p SET "orgId" = v."orgId" FROM "vehicle" v
  WHERE p."orgId" IS NULL AND v."gpsDeviceId" = p."deviceId";

-- A preference belongs to whichever of the three subjects it names.
UPDATE "notification_preference" np SET "orgId" = c."orgId"  FROM "customer" c       WHERE c.id = np."customerId";
UPDATE "notification_preference" np SET "orgId" = u."orgId"  FROM "app_user" u       WHERE np."orgId" IS NULL AND u.id = np."userId";
UPDATE "notification_preference" np SET "orgId" = cu."orgId" FROM "customer_user" cu WHERE np."orgId" IS NULL AND cu.id = np."customerUserId";

-- Rows whose parent link is nullable and unset fall back to the one tenant.
UPDATE "geofence"                SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "route"                   SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "login_activity"          SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "report_run"              SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "notification_log"        SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "notification_preference" SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "gps_ping"                SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "delivery_task"           SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "eta_snapshot"            SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "eway_bill_record"        SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "tracking_alert"          SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "vehicle_location"        SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "customer_user"           SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "inbound_receipt"         SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "city"                    SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "pincode"                 SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;

-- The two columns that already existed but allowed NULL. A row that cannot
-- say whose it is cannot be filtered safely, so there is no such thing.
UPDATE "audit_log" a SET "orgId" = u."orgId" FROM "app_user" u WHERE a."orgId" IS NULL AND u.id = a."userId";
UPDATE "audit_log"   SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;
UPDATE "file_asset"  SET "orgId" = (SELECT id FROM "organization" LIMIT 1) WHERE "orgId" IS NULL;

-- 3. Prove the backfill was complete ---------------------------------------
-- Cheaper than discovering a missed table when the NOT NULL fails halfway.
DO $check$
DECLARE
  t TEXT;
  missing BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_log','charge_type','city','customer_user','delivery_task','eta_snapshot',
    'eway_bill_record','file_asset','geofence','gps_ping','inbound_receipt',
    'login_activity','notification_log','notification_preference','notification_template',
    'otp_token','outbox_event','package_type','pincode','reason_code','report_run',
    'route','service_type','state','tax_rate','tracking_alert','vehicle_location',
    'vehicle_type','verification_token','zone'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "orgId" IS NULL', t) INTO missing;
    IF missing > 0 THEN
      RAISE EXCEPTION 'Backfill missed % rows in %', missing, t;
    END IF;
  END LOOP;
END
$check$;

-- 4. Make the tenant key required ------------------------------------------
ALTER TABLE "audit_log"               ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "charge_type"             ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "city"                    ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "customer_user"           ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "delivery_task"           ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "eta_snapshot"            ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "eway_bill_record"        ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "file_asset"              ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "geofence"                ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "gps_ping"                ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "inbound_receipt"         ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "login_activity"          ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "notification_log"        ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "notification_preference" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "notification_template"   ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "otp_token"               ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "outbox_event"            ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "package_type"            ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "pincode"                 ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "reason_code"             ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "report_run"              ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "route"                   ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "service_type"            ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "state"                   ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "tax_rate"                ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "tracking_alert"          ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "vehicle_location"        ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "vehicle_type"            ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "verification_token"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "zone"                    ALTER COLUMN "orgId" SET NOT NULL;

-- 5. Uniqueness moves inside the tenant ------------------------------------
-- Document numbers come from a per-organisation NumberSeries and master
-- codes are a tenant's own vocabulary, so both collide across tenants by
-- construction. Identities move too: the same person may work for two
-- carriers, and the same attached vehicle may sit on two carriers' books.
DROP INDEX "app_user_email_key";
DROP INDEX "app_user_mobile_key";
DROP INDEX "charge_type_code_key";
DROP INDEX "city_code_key";
DROP INDEX "complaint_number_key";
DROP INDEX "credit_note_number_key";
DROP INDEX "customer_user_email_key";
DROP INDEX "delivery_run_number_key";
DROP INDEX "driver_mobile_key";
DROP INDEX "driver_settlement_number_key";
DROP INDEX "exception_dedupeKey_key";
DROP INDEX "exception_number_key";
DROP INDEX "gps_ping_deviceId_recordedAt_key";
DROP INDEX "invoice_number_key";
DROP INDEX "manifest_number_key";
DROP INDEX "notification_preference_customerId_customerUserId_userId_ev_key";
DROP INDEX "notification_template_code_channel_language_key";
DROP INDEX "package_type_code_key";
DROP INDEX "payment_number_key";
DROP INDEX "pickup_request_number_key";
DROP INDEX "pincode_code_key";
DROP INDEX "reason_code_category_code_key";
DROP INDEX "route_code_key";
DROP INDEX "service_type_code_key";
DROP INDEX "shipment_lrNumber_key";
DROP INDEX "state_code_key";
DROP INDEX "tax_rate_code_key";
DROP INDEX "trip_number_key";
DROP INDEX "vehicle_registrationNumber_key";
DROP INDEX "vehicle_type_code_key";
DROP INDEX "vendor_bill_number_key";
DROP INDEX "vendor_payment_number_key";
DROP INDEX "verification_token_identifier_token_key";
DROP INDEX "verification_token_token_key";
DROP INDEX "zone_code_key";

CREATE UNIQUE INDEX "app_user_orgId_email_key" ON "app_user"("orgId", "email");
CREATE UNIQUE INDEX "app_user_orgId_mobile_key" ON "app_user"("orgId", "mobile");
CREATE INDEX "audit_log_orgId_idx" ON "audit_log"("orgId");
CREATE UNIQUE INDEX "charge_type_orgId_code_key" ON "charge_type"("orgId", "code");
CREATE UNIQUE INDEX "city_orgId_code_key" ON "city"("orgId", "code");
CREATE UNIQUE INDEX "complaint_orgId_number_key" ON "complaint"("orgId", "number");
CREATE UNIQUE INDEX "credit_note_orgId_number_key" ON "credit_note"("orgId", "number");
CREATE UNIQUE INDEX "customer_user_orgId_email_key" ON "customer_user"("orgId", "email");
CREATE UNIQUE INDEX "delivery_run_orgId_number_key" ON "delivery_run"("orgId", "number");
CREATE INDEX "delivery_task_orgId_idx" ON "delivery_task"("orgId");
CREATE UNIQUE INDEX "driver_orgId_mobile_key" ON "driver"("orgId", "mobile");
CREATE UNIQUE INDEX "driver_settlement_orgId_number_key" ON "driver_settlement"("orgId", "number");
CREATE INDEX "eta_snapshot_orgId_idx" ON "eta_snapshot"("orgId");
CREATE INDEX "eway_bill_record_orgId_idx" ON "eway_bill_record"("orgId");
CREATE UNIQUE INDEX "exception_orgId_number_key" ON "exception"("orgId", "number");
CREATE UNIQUE INDEX "exception_orgId_dedupeKey_key" ON "exception"("orgId", "dedupeKey");
CREATE INDEX "file_asset_orgId_idx" ON "file_asset"("orgId");
CREATE INDEX "geofence_orgId_idx" ON "geofence"("orgId");
CREATE UNIQUE INDEX "gps_ping_orgId_deviceId_recordedAt_key" ON "gps_ping"("orgId", "deviceId", "recordedAt");
CREATE INDEX "inbound_receipt_orgId_idx" ON "inbound_receipt"("orgId");
CREATE UNIQUE INDEX "invoice_orgId_number_key" ON "invoice"("orgId", "number");
CREATE INDEX "login_activity_orgId_idx" ON "login_activity"("orgId");
CREATE UNIQUE INDEX "manifest_orgId_number_key" ON "manifest"("orgId", "number");
CREATE INDEX "notification_log_orgId_queuedAt_idx" ON "notification_log"("orgId", "queuedAt");
CREATE UNIQUE INDEX "notification_preference_orgId_customerId_customerUserId_use_key" ON "notification_preference"("orgId", "customerId", "customerUserId", "userId", "eventType", "channel");
CREATE UNIQUE INDEX "notification_template_orgId_code_channel_language_key" ON "notification_template"("orgId", "code", "channel", "language");
CREATE INDEX "otp_token_orgId_idx" ON "otp_token"("orgId");
CREATE INDEX "outbox_event_orgId_idx" ON "outbox_event"("orgId");
CREATE UNIQUE INDEX "package_type_orgId_code_key" ON "package_type"("orgId", "code");
CREATE UNIQUE INDEX "payment_orgId_number_key" ON "payment"("orgId", "number");
CREATE UNIQUE INDEX "pickup_request_orgId_number_key" ON "pickup_request"("orgId", "number");
CREATE UNIQUE INDEX "pincode_orgId_code_key" ON "pincode"("orgId", "code");
CREATE UNIQUE INDEX "reason_code_orgId_category_code_key" ON "reason_code"("orgId", "category", "code");
CREATE INDEX "report_run_orgId_idx" ON "report_run"("orgId");
CREATE UNIQUE INDEX "route_orgId_code_key" ON "route"("orgId", "code");
CREATE UNIQUE INDEX "service_type_orgId_code_key" ON "service_type"("orgId", "code");
CREATE UNIQUE INDEX "shipment_orgId_lrNumber_key" ON "shipment"("orgId", "lrNumber");
CREATE UNIQUE INDEX "state_orgId_code_key" ON "state"("orgId", "code");
CREATE UNIQUE INDEX "tax_rate_orgId_code_key" ON "tax_rate"("orgId", "code");
CREATE INDEX "tracking_alert_orgId_idx" ON "tracking_alert"("orgId");
CREATE UNIQUE INDEX "trip_orgId_number_key" ON "trip"("orgId", "number");
CREATE UNIQUE INDEX "vehicle_orgId_registrationNumber_key" ON "vehicle"("orgId", "registrationNumber");
CREATE INDEX "vehicle_location_orgId_idx" ON "vehicle_location"("orgId");
CREATE UNIQUE INDEX "vehicle_type_orgId_code_key" ON "vehicle_type"("orgId", "code");
CREATE UNIQUE INDEX "vendor_bill_orgId_number_key" ON "vendor_bill"("orgId", "number");
CREATE UNIQUE INDEX "vendor_payment_orgId_number_key" ON "vendor_payment"("orgId", "number");
CREATE UNIQUE INDEX "verification_token_orgId_token_key" ON "verification_token"("orgId", "token");
CREATE UNIQUE INDEX "verification_token_orgId_identifier_token_key" ON "verification_token"("orgId", "identifier", "token");
CREATE UNIQUE INDEX "zone_orgId_code_key" ON "zone"("orgId", "code");
