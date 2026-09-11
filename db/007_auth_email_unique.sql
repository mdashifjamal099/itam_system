-- ============================================================================
-- ITAM Platform — 007 Global email uniqueness for credentials login
--
-- Bug fixed: app_user only enforced UNIQUE(org_id, email). Two different
-- orgs could legitimately have a user with the same email address. Real
-- login (auth.ts) resolves an account by email ALONE via
-- fn_auth_resolve_email(), before any org context exists — that's the
-- correct pattern for a pre-auth lookup (see db/004's user_lookup for the
-- same reasoning), but combined with `LIMIT 1` and no ORDER BY, a colliding
-- email resolved to an ARBITRARY one of the matching accounts. In production
-- this means a user could be authenticated into a different organization's
-- account than the one they intended, or silently fail against an account
-- with no password_hash while a valid one existed under the same email.
--
-- Fix: email is now globally unique across the whole platform, which is the
-- standard model for email+password auth (a person needs one email per
-- account; someone working with two customer orgs needs two email aliases,
-- same as any SaaS product without SSO/org-switching). This makes the
-- pre-auth email lookup unambiguous by construction, not just by convention.
--
-- fn_auth_resolve_email additionally gets a deterministic ORDER BY as
-- defense in depth, in case this constraint is ever dropped or an
-- environment is mid-migration.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT lower(email) FROM app_user GROUP BY lower(email) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot add global email uniqueness: duplicate emails exist across orgs. '
      'This is expected only in a dev database polluted by repeated db:seed '
      'runs (each creates a new scratch org reusing the same seed emails). '
      'Run db:reset (drops and recreates the schema) before re-migrating, or '
      'manually resolve the duplicates in a real environment before retrying.';
  END IF;
END $$;

-- Case-insensitive: auth.ts already lower()s the submitted email, and
-- fn_auth_resolve_email compares lower(email) = lower(input). Two emails
-- differing only in case are the same account for login purposes, so the
-- uniqueness constraint must agree with that or a duplicate could slip in
-- through a differently-cased signup and reintroduce the ambiguity.
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_user_email_ci ON app_user (lower(email));

CREATE OR REPLACE FUNCTION fn_auth_resolve_email(p_email text)
RETURNS TABLE (id uuid, org_id uuid) AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.org_id
  FROM app_user u
  WHERE lower(u.email) = lower(p_email)
  ORDER BY u.id
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
