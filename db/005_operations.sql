-- ============================================================================
-- ITAM Platform — 005 Operational Domain
--
-- Adds the lifecycle paths the foundation left out: loss/recovery, offboarding
-- asset recovery, org policy, KPIs, and audit-chain verification.
--
-- Everything that mutates asset state still goes through fn_transition_asset,
-- so every addition here inherits the FSM, audit and outbox guarantees.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Per-tenant policy. "Overdue" is meaningless without a configured limit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_policy (
  org_id                uuid PRIMARY KEY REFERENCES organization(id),
  max_holding_days      int NOT NULL DEFAULT 365,
  warranty_alert_days   int NOT NULL DEFAULT 30,
  handshake_ttl_minutes int NOT NULL DEFAULT 1440,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION fn_org_policy(p_org uuid)
RETURNS org_policy AS $$
  SELECT COALESCE(
    (SELECT p FROM org_policy p WHERE p.org_id = p_org),
    ROW(p_org, 365, 30, 1440, now())::org_policy
  );
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Recovery tasks: an asset that must come back, with a reason and a deadline.
-- Created by offboarding and by the overdue sweep; resolved automatically when
-- the asset leaves ASSIGNED_ACTIVE.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_task (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organization(id),
  asset_id    uuid NOT NULL REFERENCES asset(id),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  reason      text NOT NULL,                       -- OFFBOARDING | OVERDUE
  due_date    date,
  status      text NOT NULL DEFAULT 'OPEN',        -- OPEN | RESOLVED | ESCALATED
  reminders   int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- One open task per asset+reason; the sweep is idempotent because of this.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recovery_open
  ON recovery_task (asset_id, reason) WHERE status <> 'RESOLVED';
CREATE INDEX IF NOT EXISTS idx_recovery_open
  ON recovery_task (org_id, status) WHERE status <> 'RESOLVED';

CREATE OR REPLACE FUNCTION fn_resolve_recovery_tasks(p_asset_id uuid) RETURNS int AS $$
DECLARE n int;
BEGIN
  UPDATE recovery_task
  SET status = 'RESOLVED', resolved_at = now()
  WHERE asset_id = p_asset_id AND status <> 'RESOLVED';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Loss declaration. Skips inspection: the asset is not physically present.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_declare_lost(
  p_asset_id uuid,
  p_actor    uuid,
  p_notes    text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_holder uuid;
  v_result jsonb;
BEGIN
  SELECT current_holder_id INTO v_holder FROM asset WHERE id = p_asset_id FOR UPDATE;

  -- Custody ends at the moment of declaration, same close-once rule as a return.
  UPDATE holding_period
  SET end_ts = now(), closed_by = p_actor
  WHERE asset_id = p_asset_id AND end_ts IS NULL;

  v_result := fn_transition_asset(
    p_asset_id, 'LOST', p_actor, 'asset.lost',
    jsonb_build_object('lastKnownUserId', v_holder, 'notes', p_notes),
    NULL);

  PERFORM fn_resolve_recovery_tasks(p_asset_id);

  RETURN v_result || jsonb_build_object('ok', true, 'lastKnownUserId', v_holder);
END;
$$ LANGUAGE plpgsql;

-- Recovered assets must be inspected before re-entering circulation.
CREATE OR REPLACE FUNCTION fn_recover_lost(
  p_asset_id uuid,
  p_actor    uuid,
  p_notes    text DEFAULT NULL
) RETURNS jsonb AS $$
BEGIN
  RETURN fn_transition_asset(
    p_asset_id, 'UNDER_INSPECTION', p_actor, 'asset.recovered',
    jsonb_build_object('notes', p_notes), NULL
  ) || jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Offboarding. Driven by HRIS webhook or an admin action.
-- Does NOT force asset state: an asset still physically held stays
-- ASSIGNED_ACTIVE. It creates recovery obligations instead, which is the honest
-- model — HR saying someone left does not make a laptop appear on a desk.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_offboard_user(
  p_user_id     uuid,
  p_actor       uuid,
  p_last_day    date DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_org      uuid;
  r          record;
  v_created  int := 0;
  v_assets   jsonb := '[]'::jsonb;
BEGIN
  SELECT org_id INTO v_org FROM app_user WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % not found', p_user_id USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE app_user SET employment_status = 'TERMINATED' WHERE id = p_user_id;

  INSERT INTO audit_log (org_id, entity_type, entity_id, actor_id, action, after)
  VALUES (v_org, 'app_user', p_user_id, p_actor, 'user.offboarded',
          jsonb_build_object('lastWorkingDay', p_last_day));

  FOR r IN
    SELECT id FROM asset
    WHERE current_holder_id = p_user_id AND current_state = 'ASSIGNED_ACTIVE'
  LOOP
    INSERT INTO recovery_task (org_id, asset_id, user_id, reason, due_date)
    VALUES (v_org, r.id, p_user_id, 'OFFBOARDING', COALESCE(p_last_day, CURRENT_DATE))
    ON CONFLICT DO NOTHING;
    v_created := v_created + 1;
    v_assets := v_assets || to_jsonb(r.id);
  END LOOP;

  INSERT INTO event_outbox (org_id, aggregate_type, aggregate_id, event_type, actor_id, data)
  VALUES (v_org, 'user', p_user_id, 'employee.offboarding', p_actor,
          jsonb_build_object('userId', p_user_id, 'lastWorkingDay', p_last_day,
                             'assetsToRecover', v_assets));

  RETURN jsonb_build_object('ok', true, 'recoveryTasks', v_created, 'assets', v_assets);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Overdue sweep: assets held beyond the tenant's policy limit.
-- Idempotent — the partial unique index means re-running creates nothing new,
-- it only bumps the reminder counter.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_sweep_overdue(p_org uuid) RETURNS jsonb AS $$
DECLARE
  v_max   int := (fn_org_policy(p_org)).max_holding_days;
  r       record;
  v_new   int := 0;
  v_remind int := 0;
BEGIN
  FOR r IN
    SELECT a.id AS asset_id, a.current_holder_id AS user_id, hp.start_ts
    FROM asset a
    JOIN holding_period hp ON hp.asset_id = a.id AND hp.end_ts IS NULL
    WHERE a.org_id = p_org
      AND a.current_state = 'ASSIGNED_ACTIVE'
      AND hp.start_ts < now() - make_interval(days => v_max)
  LOOP
    DECLARE v_was_inserted bool;
    BEGIN
      INSERT INTO recovery_task (org_id, asset_id, user_id, reason, due_date)
      VALUES (p_org, r.asset_id, r.user_id, 'OVERDUE', CURRENT_DATE)
      ON CONFLICT (asset_id, reason) WHERE status <> 'RESOLVED'
      DO UPDATE SET reminders = recovery_task.reminders + 1
      RETURNING (xmax = 0) INTO v_was_inserted;

      IF v_was_inserted THEN v_new := v_new + 1; END IF;
    END;

    INSERT INTO event_outbox (org_id, aggregate_id, event_type, data)
    VALUES (p_org, r.asset_id, 'asset.overdue',
            jsonb_build_object('assetId', r.asset_id, 'userId', r.user_id,
                               'heldSince', r.start_ts, 'limitDays', v_max));
    v_remind := v_remind + 1;
  END LOOP;

  RETURN jsonb_build_object('overdue', v_remind, 'tasks', v_new);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Warranty expiry notice
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_sweep_warranty(p_org uuid) RETURNS jsonb AS $$
DECLARE
  v_days int := (fn_org_policy(p_org)).warranty_alert_days;
  r      record;
  n      int := 0;
BEGIN
  FOR r IN
    SELECT id, asset_tag, warranty_expiry FROM asset
    WHERE org_id = p_org
      AND current_state NOT IN ('RETIRED', 'LOST')
      AND warranty_expiry IS NOT NULL
      AND warranty_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + v_days
  LOOP
    -- Deduplicated downstream by the outbox event id + processed_event ledger.
    INSERT INTO event_outbox (org_id, aggregate_id, event_type, data)
    VALUES (p_org, r.id, 'asset.warranty_expiring',
            jsonb_build_object('assetId', r.id, 'assetTag', r.asset_tag,
                               'warrantyExpiry', r.warranty_expiry));
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('expiring', n);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Audit chain verification. Recomputes each entity's hash chain and reports the
-- first row where the stored hash stops matching the recomputed one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_verify_audit_chain(p_org uuid)
RETURNS TABLE (entity_type text, entity_id uuid, broken_at bigint) AS $$
DECLARE
  r        record;
  v_prev   text;
  v_expect text;
  v_last_e text := NULL;
  v_last_i uuid := NULL;
BEGIN
  FOR r IN
    SELECT * FROM audit_log
    WHERE org_id = p_org
    ORDER BY entity_type, entity_id, id
  LOOP
    IF r.entity_type IS DISTINCT FROM v_last_e OR r.entity_id IS DISTINCT FROM v_last_i THEN
      v_prev := NULL;                         -- new chain
      v_last_e := r.entity_type;
      v_last_i := r.entity_id;
    END IF;

    v_expect := encode(digest(
      coalesce(v_prev, '') || r.entity_type || r.entity_id::text ||
      coalesce(r.actor_id::text, '') || r.action ||
      coalesce(r.before::text, '') || coalesce(r.after::text, '') ||
      r.occurred_at::text, 'sha256'), 'hex');

    IF r.row_hash IS DISTINCT FROM v_expect THEN
      entity_type := r.entity_type;
      entity_id   := r.entity_id;
      broken_at   := r.id;
      RETURN NEXT;
    END IF;

    v_prev := r.row_hash;
  END LOOP;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- Dashboard KPIs, one round trip.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_org_kpis(p_org uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'byState', COALESCE((
      SELECT jsonb_object_agg(current_state, n)
      FROM (SELECT current_state, count(*) n FROM asset WHERE org_id = p_org
            GROUP BY current_state) s), '{}'::jsonb),
    'total',           (SELECT count(*) FROM asset WHERE org_id = p_org),
    'pendingHandshakes', (SELECT count(*) FROM custody_handshake
                          WHERE org_id = p_org AND status = 'INITIATED'),
    'openRecoveryTasks', (SELECT count(*) FROM recovery_task
                          WHERE org_id = p_org AND status <> 'RESOLVED'),
    'openMaintenance', (SELECT count(*) FROM maintenance_log
                        WHERE org_id = p_org AND closed_at IS NULL),
    'avgHoldingDays',  (SELECT ROUND(AVG(
                          EXTRACT(epoch FROM (COALESCE(end_ts, now()) - start_ts)) / 86400.0)::numeric, 1)
                        FROM holding_period WHERE org_id = p_org),
    'warrantyExpiringSoon', (SELECT count(*) FROM asset
                        WHERE org_id = p_org AND warranty_expiry IS NOT NULL
                          AND current_state NOT IN ('RETIRED','LOST')
                          AND warranty_expiry BETWEEN CURRENT_DATE
                              AND CURRENT_DATE + (fn_org_policy(p_org)).warranty_alert_days),
    'unpublishedEvents', (SELECT count(*) FROM event_outbox
                        WHERE org_id = p_org AND published_at IS NULL)
  );
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Return and loss must close any outstanding recovery obligation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_return_asset(
  p_asset_id uuid,
  p_actor    uuid
) RETURNS jsonb AS $$
DECLARE
  v_holder uuid;
  v_days   numeric;
  v_result jsonb;
BEGIN
  SELECT current_holder_id INTO v_holder FROM asset WHERE id = p_asset_id FOR UPDATE;

  UPDATE holding_period
  SET end_ts = now(), closed_by = p_actor
  WHERE asset_id = p_asset_id AND end_ts IS NULL
  RETURNING EXTRACT(epoch FROM (end_ts - start_ts)) / 86400.0 INTO v_days;

  v_result := fn_transition_asset(
    p_asset_id, 'UNDER_INSPECTION', p_actor, 'asset.returned',
    jsonb_build_object('previousHolderId', v_holder, 'holdingDurationDays', v_days),
    NULL);

  PERFORM fn_resolve_recovery_tasks(p_asset_id);

  RETURN v_result || jsonb_build_object('ok', true, 'holdingDays', v_days);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- RLS for the new tenant tables
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_policy', 'recovery_task'] LOOP
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

-- ---------------------------------------------------------------------------
-- Scheduled jobs must enumerate tenants before they can scope to one.
--
-- A dedicated BYPASSRLS role would be the textbook answer, but granting
-- BYPASSRLS requires superuser, which Neon does not hand out. So system jobs
-- announce themselves with a transaction-local flag that only the cron and
-- worker paths ever set, and ONLY the organization list is readable that way.
-- Everything downstream still runs under normal per-tenant context.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS system_org_list ON organization;
CREATE POLICY system_org_list ON organization
  FOR SELECT
  USING (current_setting('app.system', true) = '1');

DO $$
DECLARE
  v_role text := COALESCE(NULLIF(current_setting('itam.app_role', true), ''), 'itam_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON org_policy, recovery_task TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', v_role);
  END IF;
END $$;
