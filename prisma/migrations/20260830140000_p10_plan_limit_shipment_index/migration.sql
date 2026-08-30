-- Plan limits count a carrier's bookings for the current month on every
-- booking. That predicate is `org_id = ? AND booked_at >= ? AND booked_at < ?`,
-- and the only index that covered it was `(booked_at)` — which would walk
-- every carrier's month in order to count one carrier's, making the cost of
-- enforcing one company's cap a function of how many other companies are on
-- the platform.
--
-- Leading with `org_id` turns it into an index-only scan bounded by exactly
-- that carrier's month.
--
-- On a shipment table that is already large this build takes a write lock
-- for its duration. Create it by hand first if that matters:
--
--   CREATE INDEX CONCURRENTLY "shipment_orgId_bookedAt_idx"
--     ON "shipment" ("orgId", "bookedAt");
--
-- and the statement below then finds it already present and does nothing.
CREATE INDEX IF NOT EXISTS "shipment_orgId_bookedAt_idx"
  ON "shipment" ("orgId", "bookedAt");
