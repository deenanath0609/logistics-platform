-- Three tables the first pass left inheriting isolation through a foreign
-- key, where the code does not actually reach them through that key.
--
-- `shipment_package` is resolved by barcode alone at the dock, and the
-- barcode was globally unique — so a scanner in one carrier could resolve,
-- and stamp, another carrier's package. The event append downstream refused
-- correctly, but by then the package row and the scan record were written.
--
-- `scan_record` is written before anything downstream can refuse it, and its
-- client-generated idempotency key was globally unique, so two carriers'
-- offline queues could collide.
--
-- `webhook_delivery` is drained per tenant and redriven by id straight off
-- an operations screen. Both currently work only because a human remembered
-- to join the subscription in the `where`.

-- The same guard as the pass before it, and the same correction: no
-- organisation at all means a fresh database with nothing to backfill, not a
-- database to refuse. See 20260828010000_p9_multi_tenancy.
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

  FOREACH target IN ARRAY ARRAY['scan_record', 'shipment_package', 'webhook_delivery'] LOOP
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

ALTER TABLE "shipment_package" ADD COLUMN "orgId" TEXT;
ALTER TABLE "scan_record"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "webhook_delivery" ADD COLUMN "orgId" TEXT;

UPDATE "shipment_package" p SET "orgId" = s."orgId"
  FROM "shipment" s WHERE s.id = p."shipmentId";

UPDATE "scan_record" r SET "orgId" = b."orgId"
  FROM "branch" b WHERE b.id = r."branchId";

UPDATE "webhook_delivery" d SET "orgId" = w."orgId"
  FROM "webhook_subscription" w WHERE w.id = d."subscriptionId";

DO $check$
DECLARE
  t TEXT;
  missing BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY['shipment_package', 'scan_record', 'webhook_delivery'] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "orgId" IS NULL', t) INTO missing;
    IF missing > 0 THEN
      RAISE EXCEPTION 'Backfill missed % rows in %', missing, t;
    END IF;
  END LOOP;
END
$check$;

ALTER TABLE "shipment_package" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "scan_record"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "webhook_delivery" ALTER COLUMN "orgId" SET NOT NULL;

DROP INDEX "shipment_package_barcode_key";
DROP INDEX "scan_record_idempotencyKey_key";

CREATE UNIQUE INDEX "shipment_package_orgId_barcode_key" ON "shipment_package"("orgId", "barcode");
CREATE UNIQUE INDEX "scan_record_orgId_idempotencyKey_key" ON "scan_record"("orgId", "idempotencyKey");
CREATE INDEX "webhook_delivery_orgId_status_nextAttemptAt_idx" ON "webhook_delivery"("orgId", "status", "nextAttemptAt");
