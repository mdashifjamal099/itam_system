-- ============================================================================
-- ITAM Platform — 010 Asset intake (procurement)
--
-- Previously the ONLY way a new asset entered the system was scripts/seed.mjs
-- doing a raw INSERT + fn_transition_asset call directly against the owner
-- connection — there was no admin-facing route or UI for it at all, discovered
-- live during a demo. This gives the app the same capability seed.mjs always
-- had: insert the row, then intake it through the real FSM (PROCURED ->
-- AVAILABLE) so it is audited exactly like every other transition, all inside
-- one function/transaction.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_create_asset(
  p_org_id           uuid,
  p_actor            uuid,
  p_asset_tag        text,
  p_serial_number    text,
  p_category         text,
  p_model            text,
  p_vendor           text,
  p_procurement_date date,
  p_warranty_expiry  date,
  p_location         text
) RETURNS jsonb AS $$
DECLARE
  v_id     uuid;
  v_result jsonb;
BEGIN
  INSERT INTO asset (org_id, asset_tag, serial_number, category, model,
                     procurement_date, warranty_expiry, location, metadata)
  VALUES (p_org_id, p_asset_tag, p_serial_number, p_category, p_model,
          p_procurement_date, p_warranty_expiry, p_location,
          CASE WHEN p_vendor IS NOT NULL THEN jsonb_build_object('vendor', p_vendor)
               ELSE '{}'::jsonb END)
  RETURNING id INTO v_id;

  -- Intake goes through the real FSM so it is audited like every other
  -- transition, not a bare INSERT that current_state's DEFAULT quietly covers.
  v_result := fn_transition_asset(v_id, 'AVAILABLE', p_actor, 'asset.intake');

  RETURN v_result || jsonb_build_object('ok', true, 'assetId', v_id);
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
