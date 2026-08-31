-- A pickup executive's phone can now retry safely.
--
-- `PickupAttempt` existed and nothing ever wrote one: a pickup could be
-- raised, assigned and cancelled, and there the product stopped. Recording
-- what happened at the door is the other half, and it is written the way
-- delivery is — as an offline queue, where the device confirms the act
-- immediately and tells the server whenever it next has signal.
--
-- That makes a duplicate send ordinary rather than exceptional: a reply lost
-- on the road is indistinguishable from a request that never arrived, so the
-- device sends again. The unique index is what makes the second send
-- harmless.
--
-- Nullable, because every attempt written before this column existed has no
-- key to carry — and in Postgres NULLs do not collide in a unique index, so
-- the old rows sit alongside the new ones without a backfill.

ALTER TABLE "pickup_attempt" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "pickup_attempt_orgId_idempotencyKey_key"
  ON "pickup_attempt"("orgId", "idempotencyKey");
