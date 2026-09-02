-- Row-level security, as a migration.
--
-- Until now the policies in ADR 001 §1 existed only in
-- `scripts/apply-rls.mjs`, run by hand once. That made the second
-- isolation mechanism drift silently away from the schema: any table added
-- by a later migration got an `orgId` column, got the Prisma extension's
-- filter (the generated registry is derived from the schema), and got no
-- policy at all — because nobody re-ran the script.
--
-- It had already happened. `tenant_credential`, added in
-- `20260830160000_p13_tenant_credentials`, holds every carrier's encrypted
-- account keys for SMS, SMTP, WhatsApp and GPS, and was the one
-- tenant-owned table in the product with no row-level security on it.
--
-- So the policies move here, where `prisma migrate deploy` reproduces them
-- on every environment. `apply-rls.mjs` is unchanged and still creates the
-- application role and grants — the half that is a deployment decision
-- rather than a schema fact — and still emits exactly the statements below
-- for the tables, so the two cannot disagree.
--
-- The loop is deliberate: it applies to every `orgId` table that exists at
-- this point, rather than to a list copied out of the schema that would go
-- stale the same way the script did.

DO $$
DECLARE
  t text;
  -- Carry `orgId` but belong to the platform operator, who reads across
  -- every tenant by design. Policies here would break the operator console.
  operator_owned text[] := ARRAY[
    'impersonation_grant',
    'tenant_usage_snapshot',
    'tenant_onboarding_task'
  ];
  -- `orgId` is nullable by design: the null row is the platform-wide
  -- default, readable by every tenant and writable by none.
  shared_default text[] := ARRAY['system_config'];
  using_clause text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'orgId'
      AND tb.table_type = 'BASE TABLE'
      AND NOT (c.table_name = ANY (operator_owned))
    ORDER BY c.table_name
  LOOP
    IF t = ANY (shared_default) THEN
      using_clause := '"orgId" IS NULL OR "orgId" = current_setting(''app.org_id'', true)';
    ELSE
      using_clause := '"orgId" = current_setting(''app.org_id'', true)';
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK ("orgId" = current_setting(''app.org_id'', true))',
      t,
      using_clause
    );
  END LOOP;
END $$;
