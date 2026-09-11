-- ============================================================================
-- ITAM Platform — 011 Condition photos on checkout/return
--
-- A photo taken at handoff (checkout) and at handback (return) is evidence of
-- an asset's condition at each end of a holding period — exactly the kind of
-- fact the append-only asset_state_event log already exists to carry. Rather
-- than adding a mutable photo_url column to asset (which would need its own
-- update path, defeating the point), the photo rides in the same jsonb
-- payload as everything else about that transition, so it inherits the same
-- audit and immutability guarantees for free.
--
-- Both functions gain a new trailing p_photo_url text DEFAULT NULL. Adding a
-- parameter changes the function's signature, so CREATE OR REPLACE alone
-- would register a second overload rather than replacing the original —
-- the old signatures are dropped explicitly first.
-- ============================================================================

DROP FUNCTION IF EXISTS fn_checkout_asset(uuid, uuid, uuid, text, int);

CREATE OR REPLACE FUNCTION fn_checkout_asset(
  p_asset_id    uuid,
  p_to_user     uuid,
  p_actor       uuid,
  p_otp_hash    text,
  p_ttl_minutes int DEFAULT 1440,
  p_photo_url   text DEFAULT NULL
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

  v_handshake := gen_random_uuid();

  v_result := fn_transition_asset(
    p_asset_id, 'PENDING_ACCEPTANCE', p_actor, 'asset.assigned',
    jsonb_build_object(
      'handshakeId', v_handshake, 'toUserId', p_to_user, 'expiresAt', v_expires,
      'photoUrl', p_photo_url),
    NULL);

  INSERT INTO custody_handshake (id, org_id, asset_id, to_user_id, initiated_by,
                                 otp_hash, otp_expires_at)
  VALUES (v_handshake, v_org, p_asset_id, p_to_user, p_actor, p_otp_hash, v_expires);

  RETURN v_result || jsonb_build_object('handshakeId', v_handshake, 'expiresAt', v_expires);
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS fn_return_asset(uuid, uuid);

CREATE OR REPLACE FUNCTION fn_return_asset(
  p_asset_id  uuid,
  p_actor     uuid,
  p_photo_url text DEFAULT NULL
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
    jsonb_build_object(
      'previousHolderId', v_holder, 'holdingDurationDays', v_days,
      'photoUrl', p_photo_url),
    NULL);

  -- db/005_operations.sql redefined fn_return_asset to also close recovery
  -- tasks on return. fn_resolve_recovery_tasks only exists once 005 has run,
  -- so guard the call for a database that somehow only has 001-002 applied.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_resolve_recovery_tasks') THEN
    PERFORM fn_resolve_recovery_tasks(p_asset_id);
  END IF;

  RETURN v_result || jsonb_build_object('ok', true, 'holdingDays', v_days);
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  v_role text := COALESCE(NULLIF(current_setting('itam.app_role', true), ''), 'itam_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', v_role);
  END IF;
END $$;
