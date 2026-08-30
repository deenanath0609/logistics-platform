-- The event log carries its own tenant key.
--
-- ADR 001 §1 says a child row reachable only through a scoped parent
-- inherits isolation through the foreign key. `shipment_event` turned out
-- not to be such a row: the adversarial suite reaches it directly with a
-- relation filter — `shipmentEvent.findMany({ where: { shipment: { id } } })`
-- — and the Prisma extension rewrites top-level `where` clauses, not nested
-- relation filters. It read another carrier's chain of custody.
--
-- Of all the tables to leave depending on every caller remembering to go
-- through the parent, this was the worst one: customer tracking, SLA and
-- billing are all projections off it.

DO $guard$
DECLARE org_count INT;
BEGIN
  SELECT count(*) INTO org_count FROM "organization";
  IF org_count > 2 THEN
    RAISE EXCEPTION 'Backfill derives orgId from each event''s shipment; % organisations present, review first.', org_count;
  END IF;
END
$guard$;

ALTER TABLE "shipment_event" ADD COLUMN "orgId" TEXT;

-- The table is append-only, enforced by trigger, and that is exactly the
-- guarantee worth keeping. Adding a column that names the carrier an event
-- already belonged to does not rewrite history — no recorded fact changes —
-- but it is still an UPDATE, so the trigger has to stand aside for it. It is
-- restored below, in the same transaction, so there is no window in which
-- the table is editable.
ALTER TABLE "shipment_event" DISABLE TRIGGER "shipment_event_no_update";

UPDATE "shipment_event" e SET "orgId" = s."orgId"
  FROM "shipment" s WHERE s.id = e."shipmentId";

ALTER TABLE "shipment_event" ENABLE TRIGGER "shipment_event_no_update";

DO $check$
DECLARE missing BIGINT;
BEGIN
  SELECT count(*) INTO missing FROM "shipment_event" WHERE "orgId" IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'Backfill missed % events', missing;
  END IF;
END
$check$;

ALTER TABLE "shipment_event" ALTER COLUMN "orgId" SET NOT NULL;

CREATE INDEX "shipment_event_orgId_occurredAt_idx" ON "shipment_event"("orgId", "occurredAt");
