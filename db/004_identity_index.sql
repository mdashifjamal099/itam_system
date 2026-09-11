-- ============================================================================
-- ITAM Platform — 004 Identity Index
--
-- app_user is RLS-protected on org_id, which creates a chicken-and-egg problem
-- for session resolution: you need org_id to query app_user, but org_id lives
-- ON app_user. Real multi-tenant systems solve this one of three ways:
--   (a) org_id comes from the request itself (subdomain, e.g. acme.itam.app)
--   (b) a small non-tenant-scoped identity/routing table maps user -> org
--   (c) a dedicated BYPASSRLS auth-service role, separately audited
--
-- This is (b). user_lookup holds ONLY a routing pointer — no name, email, or
-- role — so it carries nothing worth protecting with RLS. Once a request knows
-- its org_id from this table, every subsequent query goes through the normal
-- tenant-scoped path and full RLS applies as usual.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_lookup (
  id     uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organization(id)
);

-- Kept in sync automatically; nothing else should write to this table directly.
CREATE OR REPLACE FUNCTION fn_sync_user_lookup() RETURNS trigger AS $$
BEGIN
  INSERT INTO user_lookup (id, org_id) VALUES (NEW.id, NEW.org_id)
  ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_user_lookup ON app_user;
CREATE TRIGGER trg_sync_user_lookup
  AFTER INSERT OR UPDATE OF org_id ON app_user
  FOR EACH ROW EXECUTE FUNCTION fn_sync_user_lookup();

-- Not under RLS: it holds no business data, only an id -> org_id pointer.
GRANT SELECT ON user_lookup TO itam_app;
