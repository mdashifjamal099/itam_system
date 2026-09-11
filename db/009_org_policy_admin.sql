-- ============================================================================
-- ITAM Platform — 009 Org policy admin function
--
-- org_policy rows are upserted (a tenant has none until an admin first
-- changes a default). Same shape as every other domain mutation: one
-- function, one transaction, audited alongside the change.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_update_org_policy(
  p_org_id      uuid,
  p_actor       uuid,
  p_max_holding_days      int,
  p_warranty_alert_days   int,
  p_handshake_ttl_minutes int
) RETURNS jsonb AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  IF p_max_holding_days <= 0 OR p_warranty_alert_days <= 0 OR p_handshake_ttl_minutes <= 0 THEN
    RAISE EXCEPTION 'Policy values must be positive integers' USING ERRCODE = 'check_violation';
  END IF;

  SELECT to_jsonb(fn_org_policy(p_org_id)) - 'org_id' - 'updated_at' INTO v_before;

  INSERT INTO org_policy (org_id, max_holding_days, warranty_alert_days, handshake_ttl_minutes, updated_at)
  VALUES (p_org_id, p_max_holding_days, p_warranty_alert_days, p_handshake_ttl_minutes, now())
  ON CONFLICT (org_id) DO UPDATE SET
    max_holding_days = EXCLUDED.max_holding_days,
    warranty_alert_days = EXCLUDED.warranty_alert_days,
    handshake_ttl_minutes = EXCLUDED.handshake_ttl_minutes,
    updated_at = now();

  SELECT to_jsonb(fn_org_policy(p_org_id)) - 'org_id' - 'updated_at' INTO v_after;

  INSERT INTO audit_log (org_id, entity_type, entity_id, actor_id, action, before, after)
  VALUES (p_org_id, 'org_policy', p_org_id, p_actor, 'policy.updated', v_before, v_after);

  RETURN jsonb_build_object('ok', true, 'policy', v_after);
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
