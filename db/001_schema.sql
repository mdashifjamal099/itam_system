-- ============================================================================
-- ITAM Platform — 001 Core Schema
--
-- Invariants this file establishes:
--   1. Every tenant-owned row carries org_id (RLS depends on it — 003_rls.sql).
--   2. asset_state_event and audit_log are append-only.
--   3. asset.current_state / current_holder_id / version are a projection
--      maintained ONLY by fn_transition_asset (guard trigger in 002_fsm.sql).
--   4. holding_period opens once, closes once, then freezes.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE asset_state AS ENUM (
    'PROCURED', 'AVAILABLE', 'PENDING_ACCEPTANCE', 'ASSIGNED_ACTIVE',
    'UNDER_INSPECTION', 'MAINTENANCE', 'RETIRED', 'LOST'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE handshake_status AS ENUM ('INITIATED', 'ACCEPTED', 'DECLINED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('EMPLOYEE', 'MANAGER', 'ASSET_ADMIN', 'SUPER_ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE asset_condition AS ENUM ('GOOD', 'MINOR_DAMAGE', 'MAJOR_DAMAGE', 'UNUSABLE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Tenant context helper.
--
-- Neon pooled connections (PgBouncer transaction mode) hand the same backend to
-- different tenants across statements, so tenant context MUST be transaction
-- local. set_config(..., is_local => true) is the function form of SET LOCAL.
-- Reading it with missing_ok => true yields '' rather than erroring when unset.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_current_org() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Tenancy & identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organization (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_user (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id),
  employee_id       text NOT NULL,
  full_name         text NOT NULL,
  email             text NOT NULL,
  department        text,
  role              user_role NOT NULL DEFAULT 'EMPLOYEE',
  employment_status text NOT NULL DEFAULT 'ACTIVE',
  manager_id        uuid REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, employee_id),
  UNIQUE (org_id, email)
);

CREATE INDEX IF NOT EXISTS idx_user_org ON app_user (org_id);

-- ---------------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organization(id),
  asset_tag         text NOT NULL,
  serial_number     text NOT NULL,
  category          text NOT NULL,
  model             text NOT NULL,
  procurement_date  date,
  warranty_expiry   date,
  location          text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Projection of asset_state_event. Writable only via fn_transition_asset.
  current_state     asset_state NOT NULL DEFAULT 'PROCURED',
  current_holder_id uuid REFERENCES app_user(id),
  version           bigint NOT NULL DEFAULT 0,
  state_updated_at  timestamptz NOT NULL DEFAULT now(),

  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, asset_tag),
  UNIQUE (org_id, serial_number)
);

CREATE INDEX IF NOT EXISTS idx_asset_available
  ON asset (org_id) WHERE current_state = 'AVAILABLE';
CREATE INDEX IF NOT EXISTS idx_asset_holder
  ON asset (current_holder_id) WHERE current_holder_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Append-only event log (source of truth for the lifecycle)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset_state_event (
  id              bigserial PRIMARY KEY,
  event_id        uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(id),
  asset_id        uuid NOT NULL REFERENCES asset(id),
  asset_version   bigint NOT NULL,          -- aggregate version after this event
  from_state      asset_state,
  to_state        asset_state NOT NULL,
  event_type      text NOT NULL,
  actor_id        uuid REFERENCES app_user(id),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, asset_version)          -- no two events claim the same version
);

CREATE INDEX IF NOT EXISTS idx_ase_asset_time
  ON asset_state_event (asset_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ase_org ON asset_state_event (org_id);

-- ---------------------------------------------------------------------------
-- Custody handshakes (admin initiates -> employee verifies)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custody_handshake (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organization(id),
  asset_id             uuid NOT NULL REFERENCES asset(id),
  from_user_id         uuid REFERENCES app_user(id),
  to_user_id           uuid NOT NULL REFERENCES app_user(id),
  initiated_by         uuid NOT NULL REFERENCES app_user(id),
  initiated_at         timestamptz NOT NULL DEFAULT now(),
  status               handshake_status NOT NULL DEFAULT 'INITIATED',

  verification_method  text NOT NULL DEFAULT 'otp',
  otp_hash             text,
  otp_expires_at       timestamptz,
  otp_attempts         int NOT NULL DEFAULT 0,

  verified_at          timestamptz,
  verified_ip          text,
  notes                text
);

CREATE INDEX IF NOT EXISTS idx_handshake_pending
  ON custody_handshake (status, otp_expires_at) WHERE status = 'INITIATED';
CREATE INDEX IF NOT EXISTS idx_handshake_asset
  ON custody_handshake (asset_id, initiated_at DESC);

-- At most one live handshake per asset.
CREATE UNIQUE INDEX IF NOT EXISTS uq_handshake_live
  ON custody_handshake (asset_id) WHERE status = 'INITIATED';

-- ---------------------------------------------------------------------------
-- Holding periods — explicit lifecycle: OPEN -> CLOSED -> frozen.
--
-- Condition-at-return is deliberately NOT stored here. It is discovered during
-- inspection, after custody has already ended, and writing it back would mean
-- mutating a closed record. It lives on the inspection event and maintenance_log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holding_period (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id),
  asset_id      uuid NOT NULL REFERENCES asset(id),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  handshake_id  uuid REFERENCES custody_handshake(id),
  start_ts      timestamptz NOT NULL,
  end_ts        timestamptz,
  closed_by     uuid REFERENCES app_user(id),
  CONSTRAINT chk_holding_order CHECK (end_ts IS NULL OR end_ts >= start_ts)
);

CREATE INDEX IF NOT EXISTS idx_holding_range
  ON holding_period USING gist (
    asset_id,
    tstzrange(start_ts, COALESCE(end_ts, 'infinity'::timestamptz))
  );
CREATE INDEX IF NOT EXISTS idx_holding_user ON holding_period (user_id, start_ts DESC);

-- One open custody period per asset, always.
CREATE UNIQUE INDEX IF NOT EXISTS uq_holding_open
  ON holding_period (asset_id) WHERE end_ts IS NULL;

-- A holding period may be closed exactly once; nothing else may ever change.
CREATE OR REPLACE FUNCTION fn_holding_period_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'holding_period rows cannot be deleted; use a compensating record'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.end_ts IS NOT NULL THEN
    RAISE EXCEPTION 'holding_period % is closed and frozen', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.handshake_id IS DISTINCT FROM OLD.handshake_id
     OR NEW.start_ts IS DISTINCT FROM OLD.start_ts THEN
    RAISE EXCEPTION 'only end_ts/closed_by may be set when closing a holding_period'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.end_ts IS NULL THEN
    RAISE EXCEPTION 'closing a holding_period requires end_ts'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_holding_guard ON holding_period;
CREATE TRIGGER trg_holding_guard
  BEFORE UPDATE OR DELETE ON holding_period
  FOR EACH ROW EXECUTE FUNCTION fn_holding_period_guard();

-- ---------------------------------------------------------------------------
-- Maintenance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organization(id),
  asset_id         uuid NOT NULL REFERENCES asset(id),
  reported_by      uuid REFERENCES app_user(id),
  issue_type       text NOT NULL,
  severity         text NOT NULL DEFAULT 'MEDIUM',
  condition_found  asset_condition,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  cost_cents       bigint,
  resolution_notes text
);

CREATE INDEX IF NOT EXISTS idx_maint_asset ON maintenance_log (asset_id, opened_at DESC);

-- ---------------------------------------------------------------------------
-- Transactional outbox.
--
-- Written inside the same transaction as the domain mutation. A separate
-- drainer publishes to the broker. The API never depends on the broker being
-- reachable: if publishing fails, published_at stays NULL and the drainer
-- retries. Nothing is lost on broker outage.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_outbox (
  id             bigserial PRIMARY KEY,
  event_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id),
  aggregate_type text NOT NULL DEFAULT 'asset',
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  actor_id       uuid,
  data           jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  publish_attempts int NOT NULL DEFAULT 0,
  last_error     text
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
  ON event_outbox (occurred_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Idempotency ledger for at-least-once delivery.
-- Keyed per consumer: two different workers must both be able to claim the
-- same event exactly once each.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_event (
  event_id     uuid NOT NULL,
  consumer     text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);

-- ---------------------------------------------------------------------------
-- External side effects (email, MDM wipe, HRIS push).
--
-- processed_event alone is NOT sufficient for these: a worker can crash after
-- calling the third party but before recording completion. Each attempt is
-- tracked separately so a retry can tell "already sent" from "never sent".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_attempt (
  id              bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organization(id),
  event_id        uuid NOT NULL,
  integration     text NOT NULL,               -- 'email' | 'mdm' | 'hris'
  idempotency_key text NOT NULL,               -- key sent to the external API
  status          text NOT NULL DEFAULT 'PENDING', -- PENDING|SUCCEEDED|FAILED
  attempts        int NOT NULL DEFAULT 0,
  external_ref    text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, integration)
);

-- ---------------------------------------------------------------------------
-- Audit log — append-only, hash-chained per entity.
-- Written in the same transaction as the domain mutation it describes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organization(id),
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  actor_id     uuid,
  action       text NOT NULL,
  before       jsonb,
  after        jsonb,
  ip_address   text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  prev_hash    text,
  row_hash     text
);

CREATE INDEX IF NOT EXISTS idx_audit_entity
  ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log (org_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION fn_audit_hash_chain() RETURNS trigger AS $$
DECLARE
  v_prev text;
BEGIN
  SELECT row_hash INTO v_prev
  FROM audit_log
  WHERE entity_type = NEW.entity_type AND entity_id = NEW.entity_id
  ORDER BY id DESC LIMIT 1;

  NEW.prev_hash := v_prev;
  NEW.row_hash := encode(digest(
    coalesce(v_prev, '') || NEW.entity_type || NEW.entity_id::text ||
    coalesce(NEW.actor_id::text, '') || NEW.action ||
    coalesce(NEW.before::text, '') || coalesce(NEW.after::text, '') ||
    NEW.occurred_at::text,
    'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_hash_chain ON audit_log;
CREATE TRIGGER trg_audit_hash_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION fn_audit_hash_chain();

-- ---------------------------------------------------------------------------
-- Append-only backstop triggers.
--
-- NOTE: these are a second line of defence only. The real guarantee is the
-- REVOKE in 003_rls.sql, because the table owner can disable triggers but the
-- application role is not the owner and cannot.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only; % is not permitted',
    TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ase_immutable ON asset_state_event;
CREATE TRIGGER trg_ase_immutable
  BEFORE UPDATE OR DELETE ON asset_state_event
  FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_log;
CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
