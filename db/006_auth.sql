-- ============================================================================
-- ITAM Platform — 006 Authentication credentials
--
-- Adds the password_hash column to app_user so the application can store
-- bcrypt-hashed passwords. The column is nullable so that:
--   1. The migration is non-destructive against existing rows.
--   2. Future OAuth/SSO users do not require a local password.
--
-- The plaintext password is NEVER stored. The application always hashes
-- with bcrypt (cost factor 12) before writing, and reads the hash back
-- only to pass it to bcrypt.compare() — it never appears in logs or
-- API responses.
-- ============================================================================

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS password_hash text;

-- No additional grants needed: itam_app already has SELECT, INSERT, UPDATE
-- on app_user from 003_rls.sql. The column inherits those grants automatically.

-- ---------------------------------------------------------------------------
-- Authentication Routing
--
-- app_user is RLS-protected by org_id. To log in with only an email address,
-- we must find the org_id to set the tenant context, but we cannot query
-- app_user without first having the org_id.
--
-- This SECURITY DEFINER function runs as the table owner (bypassing RLS)
-- strictly to resolve an email to its id and org_id. It exposes no other PII
-- and allows the initial login routing step to work securely.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_auth_resolve_email(p_email text)
RETURNS TABLE (id uuid, org_id uuid) AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.org_id
  FROM app_user u
  WHERE lower(u.email) = lower(p_email);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
