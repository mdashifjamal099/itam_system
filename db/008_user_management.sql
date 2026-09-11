-- ============================================================================
-- ITAM Platform — 008 Admin user provisioning
--
-- Admin-invite model (not public signup): an ASSET_ADMIN/SUPER_ADMIN creates
-- accounts inside their own org. There is deliberately no route that lets a
-- caller specify an arbitrary org_id — every function here takes org_id as a
-- parameter but the route layer always passes the CALLING ADMIN's own
-- actor.org_id, and RLS's WITH CHECK on app_user backs that up at the DB
-- layer regardless of what the route does.
--
-- Both functions follow the same shape as every other domain mutation in this
-- system: one function, one transaction, audit_log written alongside the
-- actual change — never as an afterthought bolted onto route code.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_create_user(
  p_org_id     uuid,
  p_actor      uuid,
  p_employee_id text,
  p_full_name  text,
  p_email      text,
  p_department text,
  p_role       user_role,
  p_password_hash text
) RETURNS jsonb AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO app_user (org_id, employee_id, full_name, email, department, role, password_hash)
  VALUES (p_org_id, p_employee_id, p_full_name, lower(p_email), p_department, p_role, p_password_hash)
  RETURNING id INTO v_id;

  INSERT INTO audit_log (org_id, entity_type, entity_id, actor_id, action, after)
  VALUES (p_org_id, 'app_user', v_id, p_actor, 'user.created',
          jsonb_build_object('email', lower(p_email), 'role', p_role, 'department', p_department));

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$ LANGUAGE plpgsql;

-- All three optional fields use COALESCE-over-NULL, so a caller updates only
-- what it passes and leaves everything else untouched.
CREATE OR REPLACE FUNCTION fn_update_user(
  p_org_id      uuid,
  p_actor       uuid,
  p_target      uuid,
  p_role        user_role DEFAULT NULL,
  p_department  text DEFAULT NULL,
  p_employment_status text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  SELECT jsonb_build_object('role', role, 'department', department, 'employment_status', employment_status)
    INTO v_before
  FROM app_user WHERE id = p_target AND org_id = p_org_id FOR UPDATE;

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'User % not found in this organization', p_target USING ERRCODE = 'no_data_found';
  END IF;

  IF p_employment_status IS NOT NULL AND p_employment_status NOT IN ('ACTIVE', 'TERMINATED') THEN
    RAISE EXCEPTION 'Invalid employment_status %', p_employment_status USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app_user SET
    role = COALESCE(p_role, role),
    department = COALESCE(p_department, department),
    employment_status = COALESCE(p_employment_status, employment_status)
  WHERE id = p_target;

  SELECT jsonb_build_object('role', role, 'department', department, 'employment_status', employment_status)
    INTO v_after
  FROM app_user WHERE id = p_target;

  INSERT INTO audit_log (org_id, entity_type, entity_id, actor_id, action, before, after)
  VALUES (p_org_id, 'app_user', p_target, p_actor, 'user.updated', v_before, v_after);

  RETURN jsonb_build_object('ok', true, 'before', v_before, 'after', v_after);
END;
$$ LANGUAGE plpgsql;

-- Same re-grant pattern used in 003/005: new functions created in a later
-- migration need their own EXECUTE grant — "GRANT ... ALL FUNCTIONS" in an
-- earlier file only captured what existed at the time it ran.
DO $$
DECLARE
  v_role text := COALESCE(NULLIF(current_setting('itam.app_role', true), ''), 'itam_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', v_role);
  END IF;
END $$;
