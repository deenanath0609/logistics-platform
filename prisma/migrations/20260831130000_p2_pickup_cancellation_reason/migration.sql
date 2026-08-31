-- A cancelled pickup keeps the branch's notes.
--
-- `cancelPickup` wrote the cancellation reason into `notes`. That column is
-- not a scratchpad: it is what the branch typed for the executive — the gate
-- code, whom to ask for, which dock to use — and a cancellation overwrote
-- it. The information was gone, and it is exactly the information the next
-- attempt at the same address needs.
--
-- The reason gets its own column, and the person who called it off is
-- recorded beside the time it happened. `cancelledById` is a plain column
-- rather than a relation, the way `createdById` on this table already is.
--
-- Both nullable: every request cancelled before this existed has no reason
-- to carry, and there is nothing to backfill from — the reason those rows
-- once had was written over the notes and cannot be told apart from a note.

ALTER TABLE "pickup_request" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "pickup_request" ADD COLUMN "cancelledById" TEXT;
