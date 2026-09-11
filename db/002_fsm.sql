-- ============================================================================
-- ITAM Platform — 002 Finite State Machine + Domain Transactions
--
-- fn_transition_asset is the ONE authoritative path for changing asset state.
-- A guard trigger rejects any other write to the projection columns, so API
-- code physically cannot bypass the FSM even with a raw connection.
--
-- Every fn_* below is a single implicit transaction containing:
--   domain mutation + asset_state_event + audit_log + event_outbox
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Legal transitions (SYSTEM_DESIGN.md §3.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transition_rules (
  from_state  asset_state NOT NULL,
  to_state    asset_state NOT NULL,
  description text,
  PRIMARY KEY (from_state, to_state)
);

INSERT INTO transition_rules (from_state, to_state, description) VALUES
  ('PROCURED',           'AVAILABLE',          'Inventory intake'),
  ('PROCURED',           'RETIRED',            'Dead on arrival'),
  ('AVAILABLE',          'PENDING_ACCEPTANCE', 'Admin initiates checkout'),
  ('AVAILABLE',          'MAINTENANCE',        'Proactive servicing'),
  ('AVAILABLE',          'RETIRED',            'End of life'),
  ('PENDING_ACCEPTANCE', 'AVAILABLE',          'Handshake expired or declined'),
  ('PENDING_ACCEPTANCE', 'ASSIGNED_ACTIVE',    'Employee verified custody'),
  ('ASSIGNED_ACTIVE',    'UNDER_INSPECTION',   'Return initiated'),
  ('ASSIGNED_ACTIVE',    'LOST',               'Loss or theft declared'),
  ('UNDER_INSPECTION',   'AVAILABLE',          'Passed inspection'),
  ('UNDER_INSPECTION',   'MAINTENANCE',        'Damage found'),
  ('UNDER_INSPECTION',   'RETIRED',            'Beyond economical repair'),
  ('MAINTENANCE',        'AVAILABLE',          'Repaired'),
  ('MAINTENANCE',        'RETIRED',            'Unrepairable'),
  ('LOST',               'UNDER_INSPECTION',   'Recovered, needs condition check'),
  ('LOST',               'RETIRED',            'Written off')
ON CONFLICT (from_state, to_state) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Guard: the projection columns are writable only from inside fn_transition_asset
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_asset_projection_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.current_state     IS DISTINCT FROM OLD.current_state
   OR NEW.current_holder_id IS DISTINCT FROM OLD.current_holder_id
   OR NEW.version           IS DISTINCT FROM OLD.version)
   AND current_setting('app.fsm_ok', true) <> '1' THEN
    RAISE EXCEPTION
      'asset.current_state/current_holder_id/version may only be changed by fn_transition_asset()'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asset_projection_guard ON asset;
CREATE TRIGGER trg_asset_projection_guard
  BEFORE UPDATE ON asset
  FOR EACH ROW EXECUTE FUNCTION fn_asset_projection_guard();

-- ---------------------------------------------------------------------------
-- Core transition primitive
--
-- p_expected_version: optional optimistic-concurrency check. Pass the version
-- the caller read; the call fails if another writer moved the aggregate first.
-- Pass NULL to skip (the FOR UPDATE lock still serializes writers).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_transition_asset(
  p_asset_id         uuid,
  p_to               asset_state,
  p_actor            uuid,
  p_event_type       text,
  p_payload          jsonb  DEFAULT '{}'::jsonb,
  p_new_holder       uuid   DEFAULT NULL,
  p_expected_version bigint DEFAULT NULL,
  p_emit_event       boolean DEFAULT true
) RETURNS jsonb AS $$
DECLARE
  v_from       asset_state;
  v_org        uuid;
  v_version    bigint;
  v_event_id   uuid;
  v_outbox_id  uuid;
BEGIN
  -- Serialize concurrent writers on this aggregate. Two admins checking out the
  -- same laptop: one wins, the other sees PENDING_ACCEPTANCE and gets a 409.
  SELECT current_state, org_id, version
    INTO v_from, v_org, v_version
  FROM asset WHERE id = p_asset_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset % not found', p_asset_id USING ERRCODE = 'no_data_found';
  END IF;

  IF p_expected_version IS NOT NULL AND p_expected_version <> v_version THEN
    RAISE EXCEPTION 'Stale asset version: expected %, actual %', p_expected_version, v_version
      USING ERRCODE = 'serialization_failure';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM transition_rules WHERE from_state = v_from AND to_state = p_to
  ) THEN
    RAISE EXCEPTION 'Illegal transition % -> % for asset %', v_from, p_to, p_asset_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_version := v_version + 1;

  -- 1. domain / projection mutation
  PERFORM set_config('app.fsm_ok', '1', true);
  UPDATE asset
  SET current_state     = p_to,
      current_holder_id = p_new_holder,
      version           = v_version,
      state_updated_at  = now()
  WHERE id = p_asset_id;
  PERFORM set_config('app.fsm_ok', '0', true);

  -- 2. append-only lifecycle event
  INSERT INTO asset_state_event (
    org_id, asset_id, asset_version, from_state, to_state, event_type, actor_id, payload)
  VALUES (v_org, p_asset_id, v_version, v_from, p_to, p_event_type, p_actor, p_payload)
  RETURNING event_id INTO v_event_id;

  -- 3. append-only audit record
  INSERT INTO audit_log (org_id, entity_type, entity_id, actor_id, action, before, after)
  VALUES (v_org, 'asset', p_asset_id, p_actor, p_event_type,
          jsonb_build_object('state', v_from, 'version', v_version - 1),
          jsonb_build_object('state', p_to, 'holder', p_new_holder, 'version', v_version));

  -- 4. outbox row, same transaction. Published later by the drainer.
  IF p_emit_event THEN
    INSERT INTO event_outbox (org_id, aggregate_id, event_type, actor_id, data)
    VALUES (v_org, p_asset_id, p_event_type, p_actor,
            p_payload || jsonb_build_object(
              'assetId', p_asset_id, 'fromState', v_from,
              'toState', p_to, 'assetVersion', v_version))
    RETURNING event_id INTO v_outbox_id;
  END IF;

  RETURN jsonb_build_object(
    'assetId', p_asset_id, 'fromState', v_from, 'toState', p_to,
    'version', v_version, 'eventId', v_event_id, 'outboxEventId', v_outbox_id);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Handshake step 1 — admin initiates checkout
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_checkout_asset(
  p_asset_id    uuid,
  p_to_user     uuid,
  p_actor       uuid,
  p_otp_hash    text,
  p_ttl_minutes int DEFAULT 1440
) RETURNS jsonb AS $$
DECLARE
  v_handshake uuid;
  v_org       uuid;
  v_expires   timestamptz := now() + make_interval(mins => p_ttl_minutes);
  v_result    jsonb;
BEGIN
  SELECT org_id INTO v_org FROM asset WHERE id = p_asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset % not found', p_asset_id USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = p_to_user AND org_id = v_org) THEN
    RAISE EXCEPTION 'Recipient % is not a member of this organization', p_to_user
      USING ERRCODE = 'check_violation';
  END IF;

  -- The FSM check must be the first thing that can reject this operation, so a
  -- losing racer sees "Illegal transition" rather than a unique-index violation
  -- on the handshake table. Allocate the id up front and transition first.
  v_handshake := gen_random_uuid();

  v_result := fn_transition_asset(
    p_asset_id, 'PENDING_ACCEPTANCE', p_actor, 'asset.assigned',
    jsonb_build_object('handshakeId', v_handshake, 'toUserId', p_to_user, 'expiresAt', v_expires),
    NULL);

  INSERT INTO custody_handshake (id, org_id, asset_id, to_user_id, initiated_by,
                                 otp_hash, otp_expires_at)
  VALUES (v_handshake, v_org, p_asset_id, p_to_user, p_actor, p_otp_hash, v_expires);

  RETURN v_result || jsonb_build_object('handshakeId', v_handshake, 'expiresAt', v_expires);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Handshake step 2 — employee verifies with OTP
--
-- Returns {ok:false,...} instead of raising on a bad OTP so the failed-attempt
-- counter survives the transaction. Raising would roll the increment back and
-- make the attempt limit unenforceable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_accept_custody(
  p_handshake_id uuid,
  p_actor        uuid,
  p_otp_hash     text,
  p_ip           text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  h        custody_handshake%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO h FROM custody_handshake WHERE id = p_handshake_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'HANDSHAKE_NOT_FOUND');
  END IF;
  IF h.to_user_id <> p_actor THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'NOT_RECIPIENT');
  END IF;
  IF h.status <> 'INITIATED' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'HANDSHAKE_' || h.status::text);
  END IF;
  IF h.otp_expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'OTP_EXPIRED');
  END IF;
  IF h.otp_attempts >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'TOO_MANY_ATTEMPTS');
  END IF;
  IF h.otp_hash IS DISTINCT FROM p_otp_hash THEN
    UPDATE custody_handshake SET otp_attempts = otp_attempts + 1 WHERE id = p_handshake_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'OTP_INVALID');
  END IF;

  UPDATE custody_handshake
  SET status = 'ACCEPTED', verified_at = now(), verified_ip = p_ip, otp_hash = NULL
  WHERE id = p_handshake_id;

  v_result := fn_transition_asset(
    h.asset_id, 'ASSIGNED_ACTIVE', h.to_user_id, 'custody.accepted',
    jsonb_build_object('handshakeId', h.id, 'userId', h.to_user_id, 'ip', p_ip),
    h.to_user_id);

  -- Open the custody period. uq_holding_open guarantees there was no other.
  INSERT INTO holding_period (org_id, asset_id, user_id, handshake_id, start_ts)
  VALUES (h.org_id, h.asset_id, h.to_user_id, h.id, now());

  RETURN v_result || jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Return — closes the custody period exactly once, sends asset to inspection
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

  RETURN v_result || jsonb_build_object('ok', true, 'holdingDays', v_days);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Inspection outcome routes the asset onward. The observed condition is
-- recorded on the event and maintenance_log — never written back onto the
-- already-closed holding_period.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_complete_inspection(
  p_asset_id  uuid,
  p_actor     uuid,
  p_condition asset_condition,
  p_notes     text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_org    uuid;
  v_to     asset_state;
  v_maint  uuid;
  v_result jsonb;
BEGIN
  SELECT org_id INTO v_org FROM asset WHERE id = p_asset_id FOR UPDATE;

  v_to := CASE p_condition
    WHEN 'GOOD'         THEN 'AVAILABLE'
    WHEN 'MINOR_DAMAGE' THEN 'MAINTENANCE'
    WHEN 'MAJOR_DAMAGE' THEN 'MAINTENANCE'
    WHEN 'UNUSABLE'     THEN 'RETIRED'
  END::asset_state;

  IF v_to = 'MAINTENANCE' THEN
    INSERT INTO maintenance_log (org_id, asset_id, reported_by, issue_type, severity,
                                 condition_found, resolution_notes)
    VALUES (v_org, p_asset_id, p_actor, p_condition::text,
            CASE WHEN p_condition = 'MAJOR_DAMAGE' THEN 'HIGH' ELSE 'MEDIUM' END,
            p_condition, p_notes)
    RETURNING id INTO v_maint;
  END IF;

  v_result := fn_transition_asset(
    p_asset_id, v_to, p_actor, 'asset.inspected',
    jsonb_build_object('condition', p_condition, 'notes', p_notes, 'maintenanceLogId', v_maint),
    NULL);

  RETURN v_result || jsonb_build_object('ok', true, 'maintenanceLogId', v_maint);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Backstop sweep for handshakes nobody ever accepted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_expire_handshakes() RETURNS int AS $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT id, asset_id, initiated_by FROM custody_handshake
    WHERE status = 'INITIATED' AND otp_expires_at < now()
    FOR UPDATE
  LOOP
    UPDATE custody_handshake SET status = 'EXPIRED' WHERE id = r.id;

    IF (SELECT current_state FROM asset WHERE id = r.asset_id) = 'PENDING_ACCEPTANCE' THEN
      PERFORM fn_transition_asset(
        r.asset_id, 'AVAILABLE', r.initiated_by, 'custody.handshake_expired',
        jsonb_build_object('handshakeId', r.id), NULL);
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Point-in-time custody lookup (SYSTEM_DESIGN.md §2.2)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_holder_at(p_asset_id uuid, p_at timestamptz)
RETURNS TABLE (user_id uuid, full_name text, start_ts timestamptz, end_ts timestamptz) AS $$
  SELECT hp.user_id, u.full_name, hp.start_ts, hp.end_ts
  FROM holding_period hp
  JOIN app_user u ON u.id = hp.user_id
  WHERE hp.asset_id = p_asset_id
    AND tstzrange(hp.start_ts, COALESCE(hp.end_ts, 'infinity'::timestamptz)) @> p_at;
$$ LANGUAGE sql STABLE;
