# ITAM Platform — Handoff Context

Handoff document for continuing this project in another session/tool (e.g. Gemini). Read this first, then [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) (full architecture) and [README.md](README.md) (setup + operational reference) for depth.

**Stack:** Next.js 15 (App Router) · Neon Postgres (serverless, via `@neondatabase/serverless`) · Upstash QStash (event queue/cron) · Upstash Redis (deferred, not yet wired) · Docker Postgres for local dev.

**Core design principle:** Postgres is the enforcement layer, not just storage. The FSM, audit immutability, tenant isolation, and idempotency are all enforced by the database (triggers, RLS, grants) — application code cannot bypass them even with a raw connection. This is deliberate and should not be "simplified" by moving logic into TypeScript.

---

## 1. What is fully built and verified

### Database layer (`db/001_schema.sql` → `db/005_operations.sql`, applied in order)

- **Event-sourced asset lifecycle.** `asset_state_event` is append-only and is the source of truth; `asset.current_state`/`current_holder_id`/`version` are a projection, writable ONLY through `fn_transition_asset()` — enforced by a guard trigger (`fn_asset_projection_guard`), not just convention.
- **FSM.** `transition_rules` table enumerates every legal `(from_state, to_state)` pair. States: `PROCURED, AVAILABLE, PENDING_ACCEPTANCE, ASSIGNED_ACTIVE, UNDER_INSPECTION, MAINTENANCE, RETIRED, LOST`. Illegal transitions raise `Illegal transition X -> Y` (mapped to HTTP 409).
- **Optimistic concurrency.** `asset.version` bigint, bumped on every transition. `fn_transition_asset` accepts an optional `p_expected_version` and raises `Stale asset version` on mismatch. Row-level `SELECT ... FOR UPDATE` also serializes concurrent writers (proven with a real two-connection race test).
- **Audit log.** `audit_log` is append-only (trigger-blocked for everyone, INCLUDING the table owner — this is a deliberate backstop) and additionally has `UPDATE, DELETE` **revoked at the grant level** from the application role (`itam_app`) — this is the real guarantee, since triggers can be disabled by an owner but grants can't be bypassed without superuser. Hash-chained per entity (`prev_hash`/`row_hash`, SHA-256) — `fn_verify_audit_chain(org_id)` recomputes and reports any break.
- **Transactional outbox.** `event_outbox` row is written in the SAME transaction as every domain mutation (inside `fn_transition_asset` and the other domain functions). The API never depends on a broker being reachable. A separate drainer (`lib/qstash.ts` → `/api/cron/drain-outbox`) publishes committed rows; failures leave `published_at` NULL for retry, they never lose data.
- **Idempotency.** `processed_event (event_id, consumer)` composite PK — lets multiple consumers each claim the same event exactly once. `integration_attempt (event_id, integration)` tracks EXTERNAL side effects (email, MDM) separately, because a worker can crash after sending an email but before recording that it did — `processed_event` alone can't distinguish "never sent" from "sent, crashed before recording."
- **HoldingPeriod lifecycle.** Open once (on custody acceptance) → close exactly once (on return/loss) → frozen forever after (trigger-enforced: `UPDATE`/`DELETE` on a closed row, or any edit to immutable fields, is rejected). Condition-at-return is deliberately NOT stored here (it's discovered after custody ends, during inspection) — it lives on the inspection event / `maintenance_log` instead. `fn_holder_at(asset_id, timestamp)` answers "who held this asset at time T" via a GiST range index.
- **Multi-tenancy / RLS.** Every tenant table has `org_id` + RLS `FORCE`d, keyed on transaction-local `app.org_id` (`set_config(..., true)` — critical for PgBouncer transaction-mode pooling on real Neon, where a session-level `SET` would leak across tenants). Verified: cross-tenant reads return 0 rows, no-context queries fail closed (0 rows, not an error), cross-tenant writes match 0 rows.
- **`user_lookup` table** (`db/004_identity_index.sql`) — deliberately OUTSIDE RLS, holds only `(id, org_id)`, no PII. Solves the chicken-and-egg problem of session resolution: `app_user` is RLS-protected on `org_id`, but you need `org_id` to query it. This is a standard pattern, not a security hole (nothing sensitive is in the table).
- **Loss/recovery, offboarding, sweeps, KPIs** (`db/005_operations.sql`): `fn_declare_lost`, `fn_recover_lost`, `fn_offboard_user` (creates `recovery_task` rows, does NOT force a return), `fn_sweep_overdue`, `fn_sweep_warranty`, `fn_org_kpis`, `org_policy` table for per-tenant configurable limits (default: 365-day max holding, 30-day warranty alert).

### Application layer

- **`lib/db.ts`** — exports `sql`. Uses real `@neondatabase/serverless` `neon()` against a real `DATABASE_URL`. **Local-only shim:** when `DATABASE_URL` contains `localhost`, swaps in a hand-rolled `pg`-based tagged-template + `.transaction()` implementation, because the Neon serverless driver only speaks Neon's HTTP/WebSocket protocol and cannot reach plain TCP Postgres (Docker). This shim is bypassed entirely against a real Neon URL.
- **`lib/tenant.ts`** — `withTenant(orgId, query)`, `asSystem(query)` (lists orgs only, for cron), `asDrainer(query)` (cross-tenant outbox access), `allOrgIds()`. All set transaction-local context via `set_config(..., true)` inside `sql.transaction([...])`.
- **`auth.ts` + `lib/auth.ts`** — Auth.js credentials login verifies bcrypt password hashes and issues signed JWT sessions. `getActor()` resolves the session user through `user_lookup`, then re-queries `app_user` under tenant RLS on every request. The unsigned `actor_id` cookie is retained only for dev/test environments; it is never accepted in production.
- **`lib/otp.ts`** — 6-digit OTP generation + SHA-256 hashing (with pepper). OTPs are never stored in plaintext.
- **`lib/qstash.ts`** — `drainOutbox()`. Publishes to real QStash if `QSTASH_TOKEN` is set; otherwise calls `/api/workers/dispatch` in-process via `fetch`, so the whole pipeline still runs locally with zero external dependencies.
- **`lib/integrations.ts`** — `runIntegration()` wraps external calls (email/MDM stubs) with the `integration_attempt` idempotency table. `sendNotification`/`mdmRemoteWipe` are **stubs that only log** — no real email/SMS/MDM provider is wired up.
- **`lib/cron.ts`** — `protectedCron()` wrapper: QStash signature verification if configured, else `CRON_SECRET` bearer token, else refuses (503) — never defaults to open.
- **`lib/http.ts`** — maps thrown errors to HTTP status (`ForbiddenError` → 403, `Illegal transition` → 409, `not found` → 404, `append-only` → 403).

### API routes — all implemented and tested

| Route | Purpose |
|---|---|
| `POST /api/assets/[id]/checkout` | Admin initiates custody handshake, generates OTP |
| `POST /api/custody/accept` | Recipient verifies OTP, custody becomes active |
| `POST /api/assets/[id]/return` | Closes holding period, sends to inspection |
| `POST /api/assets/[id]/inspect` | Routes by condition: GOOD→AVAILABLE, damage→MAINTENANCE, UNUSABLE→RETIRED |
| `POST /api/assets/[id]/lost` | Declares loss, closes custody immediately |
| `POST /api/assets/[id]/recover` | Recovered asset → forced inspection before re-circulation |
| `GET /api/assets/[id]/timeline` | Full audit history + point-in-time lookup (`?at=<ISO>`) |
| `GET/POST /api/ops/*` | `kpis`, `recovery-tasks`, `sweep` (org-scoped, admin-triggerable), `offboard` |
| `POST /api/webhooks/hris` | HMAC-SHA256-verified offboarding webhook |
| `POST /api/workers/dispatch` | QStash-signed (or local) event worker — sends notifications, MDM wipes |
| `POST /api/cron/*` | `drain-outbox`, `expire-handshakes`, `sweep-overdue`, `sweep-warranty`, `verify-audit` — all iterate every tenant explicitly, protected by `protectedCron` |
| `POST /api/dev/login`, `/api/dev/logout` | Dev/test-only actor helper; production uses Auth.js |

### UI — minimal but functional

- `/` — asset dashboard grid (state badges, current holder)
- `/assets/[id]` — detail page: role/state-conditional actions (checkout, accept-OTP, return, inspect, lost, recover), audit timeline
- `/dashboard` — ops view: KPIs, open recovery tasks, manual sweep triggers, offboarding form
- Dev actor-switcher (`components/ActorPicker.tsx`) reads `.dev-actors.json` (written by `scripts/seed.mjs`) instead of an authenticated endpoint

### Test suite (Vitest, 83 tests, no Playwright yet)

- **Isolated test DB**: separate Postgres database (`itam_test`) AND a **separate app role** (`itam_app_test`) from dev's `itam_app` — see "Bugs found" below for why the separate role matters.
- **Priority 1** (`tests/db/*.test.ts`): FSM transitions, illegal transitions, optimistic concurrency, real two-connection race, transactional rollback, audit creation/immutability/hash-chain, outbox atomicity, processed_event/integration_attempt idempotency, holding-period lifecycle, RLS/tenant isolation, `user_lookup` security.
- **Priority 2** (`tests/api/*.test.ts`): full checkout/accept/return/inspect/lost/recover flow, RBAC 401/403 matrix, 409 on illegal transitions, HRIS webhook (valid/invalid HMAC), cron auth, sweep endpoints, ops dashboard endpoints.
- **Priority 3** (`tests/async/outbox-dispatch.test.ts`): real drain → real worker → real `integration_attempt` row (not mocked), re-drain doesn't double-publish, duplicate delivery is a no-op, worker failure releases the `processed_event` claim for retry.
- **Priority 4** (`tests/e2e/flows.test.ts`): three full narrative flows — admin checkout→OTP→return→inspect (with full timeline reconstruction), lost→recover→inspect, HRIS offboarding→recovery task→return→resolved.
- Global setup (`tests/global-setup.ts`) spawns a REAL `next dev` server on port 3100 against the isolated DB; tests hit it over real HTTP with real cookies. It writes to `.next-test`, keeping it separate from a developer's `.next` directory.

**Current result (2026-09-11): 83/83 passing.** `npx tsc --noEmit` and `npm run build` pass. `db:verify` remains a separate 23-assertion invariant script.

---

## 2. What is explicitly NOT built yet

- **Authentication hardening.** Credentials login and signed JWT sessions are implemented, but OAuth/SAML/SSO, password reset, account provisioning, and lifecycle-management UI are not.
- **Redis caching / rate limiting.** Designed in SYSTEM_DESIGN.md §2.4 but not implemented — no `@upstash/redis` usage in the codebase despite being a dependency.
- **Inbound MDM telemetry.** Only the OUTBOUND remote-wipe stub exists (`lib/integrations.ts::mdmRemoteWipe`, logs only). No Jamf/Intune webhook receiver for device check-in/compliance status.
- **Real email/SMS provider.** `sendNotification` in `lib/integrations.ts` only logs to console. No SendGrid/Twilio integration.
- **Department-scoped RLS for MANAGER role.** Currently role-checked in route handlers (`hasRole(actor, "MANAGER", ...)`) but RLS policies don't scope managers to their department — a manager can query any asset in their org, not just their team's.
- **Real QStash/production deployment.** Everything works with `QSTASH_TOKEN` unset (in-process dispatch fallback). Never tested against a live QStash instance or deployed to Vercel.
- **Playwright/browser E2E.** Explicitly decided against for now — the current "E2E" tests are HTTP-level (real server, real requests) rather than browser-driven, since the UI has no meaningful client-side logic beyond wrapping `fetch` calls. If real browser-rendered UI testing is wanted later, that's additive, not a replacement.
- **CI/CD pipeline.** No GitHub Actions or similar wired up to run `npm test`/`db:verify`/`tsc` automatically.
- **Production secrets management.** `.env.local`/`.env.test` are local files; no secrets manager integration documented for actual Neon/Vercel deployment beyond what's in `.env.example`.

---

## 3. Environment / infrastructure notes for continuation

- **Local Postgres**: `docker-compose.yml` runs `postgres:16-alpine` on **host port 55432** (not 5432 — a native Postgres install already occupied 5432 on this machine). `docker compose up -d` to start it.
- **Three env files**: `.env.local` (dev, port 3000, role `itam_app`), `.env.test` (tests, port 3100, role `itam_app_test` — deliberately different role, see bug history below), `.env.example` (template for real Neon).
- **IMPORTANT gotcha for whoever continues this**: `CREATE ROLE`/`ALTER ROLE` in Postgres are **cluster-wide**, not per-database. Migrating a role with the same name against two different databases on the same Postgres instance will silently overwrite that role's password everywhere. This bit us once during test-suite development (broke the running dev server) and was fixed by giving the test database's app role a distinct name (`itam_app_test` vs `itam_app`), parameterized via `APP_DB_ROLE` env var and `itam.app_role` Postgres session setting in `db/003_rls.sql`. If you add more environments, follow the same pattern — never reuse a role name across databases on one instance unless the password is guaranteed identical everywhere.
- **`scripts/migrate.mjs`** uses the **unpooled/direct** connection (DDL, `CREATE ROLE`, `GRANT` need this) and uses `pg` (not `@neondatabase/serverless`) because these are Node scripts, not edge-constrained.
- **`scripts/seed.mjs`** creates one org + 4 users (Priya/ASSET_ADMIN, Rahul/EMPLOYEE, Sara/MANAGER, Dev/EMPLOYEE) + 4 assets, and writes `.dev-actors.json` for the UI's dev login picker. **Not idempotent** — re-running creates a NEW org every time (harmless for local dev, just accumulates scratch orgs).
- **Running everything**:
  ```bash
  docker compose up -d
  npm install
  npm run db:migrate   # dev DB
  npm run db:seed
  npm run db:verify    # 23 hand-rolled invariants
  npm test             # 83 Vitest tests (isolated DB + server output in .next-test)
  npx tsc --noEmit
  npm run build
  npm run dev           # http://localhost:3000
  ```

## 4. Key files to read first if picking this up cold

1. [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) — full architecture rationale (why CQRS-ish split, why event sourcing, why RLS over app-level checks, etc.)
2. [db/002_fsm.sql](db/002_fsm.sql) — the FSM and all domain transaction functions; this is the heart of the system
3. [db/003_rls.sql](db/003_rls.sql) — tenant isolation + append-only enforcement (the two hardest guarantees to get right)
4. [README.md](README.md) — operational reference, API table, "deliberate compromises" section
5. [lib/tenant.ts](lib/tenant.ts) + [lib/db.ts](lib/db.ts) — understand the local-dev shim before touching DB access code
