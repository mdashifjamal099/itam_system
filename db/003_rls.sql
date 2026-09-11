-- ============================================================================
-- ITAM Platform — 003 Tenant Isolation & Append-Only Enforcement
--
-- This file is what makes the audit guarantee real. Triggers alone are not
-- enough: a table owner can ALTER TABLE ... DISABLE TRIGGER. So the application
-- connects as `itam_app`, which is NOT the owner and has no UPDATE/DELETE grant
-- on the append-only tables. It cannot bypass the rule even with a raw psql
-- session and full application credentials.
--
-- Tenant context is transaction-local (set_config(..., is_local => true)).
-- This matters specifically because Neon's pooled endpoint (PgBouncer,
-- transaction mode) reuses backends across tenants between transactions.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Application role
--
-- migrate.mjs sets itam.app_password (and optionally itam.app_role) before
-- running this file. If the password is absent the role step is skipped so
-- the migration still works against a database whose roles are managed
-- externally (e.g. the Neon console).
--
-- The role name is configurable (default 'itam_app') specifically so the test
-- suite can use a DIFFERENT role than development. CREATE ROLE / ALTER ROLE
-- are CLUSTER-WIDE in Postgres, not per-database: migrating a same-named role
-- against an isolated test database would silently reset its password for
-- every other database on the same instance, including the dev database.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pw   text := NULLIF(current_setting('itam.app_password', true), '');
  v_role text := COALESCE(NULLIF(current_setting('itam.app_role', true), ''), 'itam_app');
BEGIN
  IF v_pw IS NULL THEN
    RAISE NOTICE 'itam.app_password not set — skipping role creation';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', v_role, v_pw);
  ELSE
    EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', v_role, v_pw);
  END IF;
END $$;

DO $$
DECLARE
  v_role text := COALESCE(NULLIF(current_setting('itam.app_role', true), ''), 'itam_app');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    RETURN;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', v_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', v_role);
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', v_role);

  -- The whole point of this file.
  EXECUTE format('REVOKE UPDATE, DELETE ON audit_log FROM %I', v_role);
  EXECUTE format('REVOKE UPDATE, DELETE ON asset_state_event FROM %I', v_role);
  -- Transition rules are configuration, not application data.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON transition_rules FROM %I', v_role);
  -- Holding periods may be closed (UPDATE) but never removed.
  EXECUTE format('REVOKE DELETE ON holding_period FROM %I', v_role);
  -- Organizations are provisioned out of band, not by the app.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON organization FROM %I', v_role);

  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO %I', v_role);
END $$;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- FORCE so that even the table owner is subject to the policy — otherwise a
-- migration or admin script silently reads across tenants.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'app_user', 'asset', 'asset_state_event', 'custody_handshake',
    'holding_period', 'maintenance_log', 'event_outbox',
    'integration_attempt', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (org_id = fn_current_org())
        WITH CHECK (org_id = fn_current_org())
    $f$, t);
  END LOOP;
END $$;

-- organization: a tenant may see only its own row.
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organization;
CREATE POLICY tenant_isolation ON organization
  USING (id = fn_current_org());

-- processed_event is keyed by broker event id and carries no tenant data.
-- Left outside RLS deliberately; it holds no business content.

-- ---------------------------------------------------------------------------
-- Escape hatch for operators: a role that may bypass RLS for cross-tenant
-- maintenance (outbox drain, handshake expiry sweep). Deliberately separate
-- from the application role and separately audited.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_role text := COALESCE(NULLIF(current_setting('itam.app_role', true), ''), 'itam_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    -- The drainer needs to see unpublished rows across all tenants.
    EXECUTE format('DROP POLICY IF EXISTS outbox_drainer ON event_outbox');
    EXECUTE format($f$
      CREATE POLICY outbox_drainer ON event_outbox
        FOR SELECT
        USING (current_setting('app.drainer', true) = '1')
    $f$);

    EXECUTE format('DROP POLICY IF EXISTS outbox_drainer_update ON event_outbox');
    EXECUTE format($f$
      CREATE POLICY outbox_drainer_update ON event_outbox
        FOR UPDATE
        USING (current_setting('app.drainer', true) = '1')
        WITH CHECK (current_setting('app.drainer', true) = '1')
    $f$);
  END IF;
END $$;
