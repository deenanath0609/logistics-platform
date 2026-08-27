-- Append-only enforcement for the event log and the audit trail.
--
-- The application already routes every status change through the state
-- machine, but "we promise not to" is not an integrity guarantee. A stray
-- migration, a psql session, or a future developer with a good reason can
-- all rewrite history. These triggers make that impossible.
--
-- A correction is a NEW compensating event carrying a reason code — never
-- an edit to an existing row. This is what lets the timeline settle a
-- damage dispute six months after the fact.

CREATE OR REPLACE FUNCTION reject_mutation_on_append_only_table()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Record a compensating entry instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- ── shipment_event ──────────────────────────────────────────
DROP TRIGGER IF EXISTS shipment_event_no_update ON shipment_event;
CREATE TRIGGER shipment_event_no_update
  BEFORE UPDATE ON shipment_event
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_on_append_only_table();

DROP TRIGGER IF EXISTS shipment_event_no_delete ON shipment_event;
CREATE TRIGGER shipment_event_no_delete
  BEFORE DELETE ON shipment_event
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_on_append_only_table();

-- ── audit_log ───────────────────────────────────────────────
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_on_append_only_table();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_on_append_only_table();

-- Note: `prisma migrate reset` drops the schema wholesale, so it is not
-- blocked by these triggers. Cascade deletes from a parent shipment ARE
-- blocked by design — shipments are soft-deleted, never removed.
