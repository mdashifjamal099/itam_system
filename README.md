# ITAM Platform

Postgres schema → RLS → FSM → transactional audit → transactional outbox →
idempotency → worker dispatch → scheduled sweeps → HRIS webhook → ops
dashboard.

Full architecture: [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md).

## Setup — local (Docker)

`.env.local` is already pointed at the bundled Postgres container. Host port is
**55432**, not 5432, to avoid colliding with a native Postgres install.

```bash
docker compose up -d
npm install
npm run db:migrate    # schema, itam_app role, RLS policies, grants
npm run db:seed       # one org, four users, four assets
npm run db:verify     # 23 invariant assertions
npm test              # 83 automated database/API/HTTP workflow tests
npx tsc --noEmit      # TypeScript validation
npm run dev           # http://localhost:3000
```

Then open the app and pick an actor from the dev sign-in list.

**Demo path:** sign in as Priya (ASSET_ADMIN) → open an AVAILABLE asset →
Checkout to Rahul → the OTP is shown on screen (no email provider wired up) →
*Switch user* → Rahul → enter the OTP → Return → switch back to Priya →
complete the inspection. Visit `/dashboard` for fleet KPIs, recovery tasks, and
manual sweep/offboard triggers.

## Setup — real Neon

1. Create a Neon project; copy both connection strings.
2. Set in `.env.local`:
   - `DATABASE_URL_UNPOOLED` — direct endpoint, used by migrations (DDL, roles, grants)
   - `DATABASE_URL` — pooled endpoint, used by the request path
   - `APP_DB_PASSWORD` — password for the `itam_app` role
   - `CRON_SECRET`, `HRIS_WEBHOOK_SECRET` — see below
3. Run the same commands as above.
4. After the first migration, point `DATABASE_URL` at the `itam_app` role
   (not the Neon owner) so the grant-level guarantees actually apply.
5. Optionally set `QSTASH_TOKEN` / `QSTASH_CURRENT_SIGNING_KEY` /
   `QSTASH_NEXT_SIGNING_KEY` and point QStash schedules at the `/api/cron/*`
   routes below. Without them the app still runs correctly — the outbox drainer
   dispatches events by calling the worker in-process, and cron routes accept a
   `CRON_SECRET` bearer token instead of a QStash signature.

> **Why two DB roles.** The append-only guarantee is a `REVOKE`, and grants do
> not apply to a table's owner. Connecting the app as the Neon owner role
> silently voids it — the triggers still fire, but the owner can disable them.

## What the database enforces

| Guarantee | Mechanism |
|---|---|
| Only legal state transitions | `transition_rules` table + `fn_transition_asset` |
| No bypassing the FSM | Guard trigger on `asset`: projection columns reject writes unless `fn_transition_asset` set a transaction-local flag |
| State + event + audit + outbox are atomic | All four writes live inside one stored function = one transaction |
| Broker outage cannot lose events | Outbox row commits with the state change; a separate drainer publishes, retrying from `published_at IS NULL` |
| Audit is append-only | `REVOKE UPDATE, DELETE` from `itam_app` (+ trigger backstop) |
| Tamper evidence | Per-entity SHA-256 hash chain on `audit_log`, recomputed by `/api/cron/verify-audit` |
| No double checkout | `SELECT … FOR UPDATE` on the asset row; optimistic `version` check available |
| Custody period integrity | Open once, close once, then frozen — enforced by trigger + partial unique index |
| Tenant isolation | RLS `FORCE` on every tenant table, keyed on transaction-local `app.org_id` |
| At-least-once delivery safety | `processed_event (event_id, consumer)` |
| External side effects | `integration_attempt` tracked separately — `processed_event` alone cannot tell "already sent" from "never sent" |
| Recovery obligations don't duplicate | Partial unique index on `(asset_id, reason)` for open `recovery_task` rows |

## Asset lifecycle

```
PROCURED ──▶ AVAILABLE ──checkout──▶ PENDING_ACCEPTANCE ──OTP verify──▶ ASSIGNED_ACTIVE
                  ▲                        │                                │  │
                  │                   expire sweep                     return  declare lost
                  │                        ▼                                │  │
                  └──inspect(GOOD)── UNDER_INSPECTION ◀── recover ──── LOST ◀┘
                                          │
                          MAINTENANCE ◀───┼───▶ RETIRED
```

## API

| Route | Method | Role |
|---|---|---|
| `/api/assets/[id]/checkout` | POST | `ASSET_ADMIN`, `SUPER_ADMIN` |
| `/api/custody/accept` | POST | recipient only |
| `/api/assets/[id]/return` | POST | holder, manager, admin |
| `/api/assets/[id]/inspect` | POST | `ASSET_ADMIN`, `SUPER_ADMIN` |
| `/api/assets/[id]/lost` | POST | holder, manager, admin |
| `/api/assets/[id]/recover` | POST | `ASSET_ADMIN`, `SUPER_ADMIN` |
| `/api/assets/[id]/timeline` | GET | `MANAGER`, `ASSET_ADMIN`, `SUPER_ADMIN` |
| `/api/ops/kpis` | GET | `MANAGER`, `ASSET_ADMIN`, `SUPER_ADMIN` |
| `/api/ops/recovery-tasks` | GET | `MANAGER`, `ASSET_ADMIN`, `SUPER_ADMIN` |
| `/api/ops/sweep` | POST `{kind:"overdue"\|"warranty"}` | `ASSET_ADMIN`, `SUPER_ADMIN`, scoped to caller's org |
| `/api/ops/offboard` | POST `{userId, lastWorkingDay?}` | `ASSET_ADMIN`, `SUPER_ADMIN`, scoped to caller's org |
| `/api/webhooks/hris` | POST | HMAC-SHA256 signed (`x-hris-signature`), cross-tenant |
| `/api/workers/dispatch` | POST | QStash-signed, or in-process only when unconfigured |
| `/api/cron/drain-outbox` | POST | QStash-signed or `CRON_SECRET`, cross-tenant |
| `/api/cron/expire-handshakes` | POST | QStash-signed or `CRON_SECRET`, iterates all tenants |
| `/api/cron/sweep-overdue` | POST | QStash-signed or `CRON_SECRET`, iterates all tenants |
| `/api/cron/sweep-warranty` | POST | QStash-signed or `CRON_SECRET`, iterates all tenants |
| `/api/cron/verify-audit` | POST | QStash-signed or `CRON_SECRET`, iterates all tenants, 500 if any chain is broken |

`?at=<ISO timestamp>` on the timeline route answers "who held this asset at that
moment, and what state was it in".

Authentication uses **Auth.js credentials login**: a user signs in with email
and a bcrypt password hash, and Auth.js stores a signed JWT session. Each
request re-fetches the actor under tenant RLS, so disabled users and role changes
take effect immediately. The `/api/dev/login` `actor_id` cookie remains only for
development and test environments; production accepts only the signed session.

## Event pipeline

Every state transition writes an `event_outbox` row in the same transaction. A
drainer (`drainOutbox` in `lib/qstash.ts`, called by `/api/cron/drain-outbox`)
publishes committed rows to QStash — or, with no `QSTASH_TOKEN` configured,
delivers them by calling `/api/workers/dispatch` directly so the whole pipeline
still runs locally. The worker claims each event via `processed_event` before
acting (so a QStash redelivery is a no-op), then routes side effects (email,
MDM wipe) through `runIntegration`, which tracks each external call separately
in `integration_attempt` — because a crash between "the email was sent" and
"we recorded that it was sent" is exactly the case `processed_event` alone
cannot distinguish.

## Scheduled operations

Cron routes iterate every tenant explicitly (`allOrgIds()` under a narrow
`app.system` context that grants *only* the ability to list organizations),
then run each tenant's work under normal per-tenant RLS. Point QStash Schedules
at all five `/api/cron/*` routes; the org-scoped equivalents under `/api/ops/*`
let an admin trigger the same sweeps for their own tenant on demand from the
dashboard.

## Two deliberate compromises

**`user_lookup`** (`db/004_identity_index.sql`) sits outside RLS. `app_user` is
RLS-protected on `org_id`, but you need `org_id` to query it — a chicken-and-egg
problem every multi-tenant system hits at session resolution. This table holds
only an `id → org_id` pointer, no name/email/role, so there is nothing in it
worth protecting. Once `org_id` is known, everything else goes through the
normal tenant-scoped path.

**The local driver shim** (`lib/db.ts`) uses `pg` when `DATABASE_URL` points at
localhost, because `@neondatabase/serverless` speaks only Neon's HTTP/WebSocket
protocol and cannot reach a plain TCP Postgres. Against a real Neon URL the
actual `neon()` driver is used and the shim is bypassed entirely.

## Not built yet

- OAuth/SAML/SSO, password reset, account provisioning, and user lifecycle UI
- Redis caching / rate limiting
- MDM telemetry ingestion (only the outbound remote-wipe stub exists)
- Department-scoped RLS for `MANAGER` (role-checked in routes, not in policy)
- Real email/SMS and MDM providers (current adapters only log locally)
- Browser-driven UI/accessibility tests (the existing 83 tests include database,
  API, async-worker, and HTTP-level end-to-end coverage)
- CI/CD and production deployment/secrets management

## Verification checklist

Run these before handing off a change:

```bash
npm test              # isolated itam_test database + test server on port 3100
npx tsc --noEmit
npm run build
```

The test server writes to `.next-test`, so it can run alongside a normal local
Next.js development server that uses `.next`.
