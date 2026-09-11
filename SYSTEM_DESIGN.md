# IT Asset Management Platform — Production System Design

**Stack:** Next.js 15 (App Router) · Vercel · Neon Postgres (Serverless) · Upstash QStash · Upstash Redis
**Compliance target:** ITIL v4 Asset Management practice, 100% auditability, sub-second timeline reads

> **Implementation status (2026-09-11):** This is a target production design,
> not a statement that every component is live. The Postgres FSM, RLS, audit
> chain, outbox, cron routes, HRIS webhook, minimal UI, and Auth.js credentials
> login are implemented. Redis caching/rate limiting, live QStash schedules and
> DLQ workflow, real notification/MDM providers, manager department RLS,
> browser UI testing, and observability integrations remain planned work. See
> `IMPLEMENTATION_GAPS.md` and `IMPLEMENTATION_PLAN.md` for the current scope.

---

## 1. High-Level Architecture & Serverless Topology

### 1.1 System Topology

```
                                   ┌───────────────────────────────────────┐
                                   │              CLIENTS                   │
                                   │  Admin Console │ Employee Portal │ MDM  │
                                   └───────────────────┬─────────────────────┘
                                                        │ HTTPS
                                                        ▼
                              ┌──────────────────────────────────────────────┐
                              │        VERCEL EDGE NETWORK (CDN + WAF)        │
                              │   - Edge Middleware: auth/session/rate-limit  │
                              └───────────────────┬────────────────────────────┘
                                                   ▼
        ┌──────────────────────────────────────────────────────────────────────────┐
        │                    NEXT.JS 15 APP ROUTER (Vercel Functions)                │
        │                                                                            │
        │   COMMAND SIDE (writes)              QUERY SIDE (reads)                    │
        │   /api/assets/checkout   POST         /api/assets/:id/timeline  GET        │
        │   /api/custody/accept    POST         /api/assets/search        GET        │
        │   /api/maintenance/log   POST         /api/dashboard/kpis       GET        │
        │        │                                    │                              │
        │        │ validate → write → enqueue          │ read-through cache          │
        │        ▼                                    ▼                              │
        │   ┌─────────────┐                    ┌──────────────┐                      │
        │   │ Neon Postgres│◄──────────────────│ Upstash Redis│                      │
        │   │ (source of   │   cache invalidate │ (hot state,  │                      │
        │   │  truth, WAL) │   on write commit  │ sessions,    │                      │
        │   └──────┬───────┘                    │ rate-limits) │                      │
        │          │                             └──────────────┘                      │
        └──────────┼──────────────────────────────────────────────────────────────────┘
                   │ NOTIFY / outbox row insert
                   ▼
        ┌─────────────────────────────┐
        │      UPSTASH QSTASH          │      ┌───────────────────────────────┐
        │  (durable event broker +     │─────▶│  Async Worker Endpoints         │
        │   scheduler / cron)          │      │  /api/workers/notify            │
        │  - asset.assigned            │      │  /api/workers/audit-index       │
        │  - custody.accepted          │      │  /api/workers/hris-sync         │
        │  - maintenance.logged        │      │  /api/workers/mdm-sync          │
        │  - DLQ on exhausted retries  │      │  (verifySignatureAppRouter)     │
        └─────────────────────────────┘      └──────────────┬──────────────────┘
                                                              │
                                              ┌───────────────┴───────────────┐
                                              ▼                               ▼
                                     Neon Postgres (audit,           External Systems
                                     append-only tables)             (HRIS, MDM, Email/SMS)
```

### 1.2 Serverless Execution Constraints — Mitigation Strategy

| Constraint | Risk | Mitigation |
|---|---|---|
| **DB connection exhaustion** | Each Vercel Function invocation opens a new Postgres connection; under burst traffic this exhausts Postgres' native connection limit | Use **Neon's pooled connection string (PgBouncer, transaction mode)** for all API routes; use direct (unpooled) connection only in long-running migration/worker jobs. Never hold a connection open across an `await` on an external network call. |
| **Cold starts** | First request after idle incurs 300ms–1.5s init penalty, hurting checkout UX | Keep command-path functions on **Node.js runtime (not Edge)** for Postgres driver compatibility, but minimize bundle size (no heavy SDKs in hot path). Use Vercel's **Fluid Compute** to reuse warm instances across invocations. Pre-warm via a QStash cron pinging `/api/health` every 4 minutes. |
| **30–60s execution timeout** | Long-running bulk imports (e.g., 5,000 assets from CSV, or full MDM sync) exceed limits | Never do bulk work synchronously in an API route. Route accepts the job, writes a `job` row (`status=PENDING`), returns 202 immediately, and **QStash fans out** the work into small, independently-retryable chunks (e.g., 100 rows/message) processed by worker endpoints. |
| **Burst traffic (e.g., mass offboarding day)** | Thundering herd on checkout/return endpoints | Redis-backed **token bucket rate limiting** at Edge Middleware (per-org, per-user); QStash naturally smooths bursts into a queue rather than hitting Postgres directly. |
| **Idempotency under retries** | QStash *will* redeliver messages (at-least-once); duplicate processing could double-count state transitions | Every event carries an `eventId` (UUID); worker checks a `processed_events` table (unique constraint on `eventId`) inside the same transaction as the state mutation — classic **transactional outbox + idempotency key** pattern. |
| **API abuse / scraping** | Public-facing asset lookup could be hit hard | Upstash Redis `@upstash/ratelimit` sliding-window per IP + per API key, enforced in Middleware before function invocation (saves compute cost too). |

### 1.3 CQRS Design Rationale

| | Command Side | Query Side |
|---|---|---|
| **Purpose** | Mutate asset/custody state — must be strongly consistent | Serve timelines, dashboards, search — must be fast, can tolerate ~1-2s staleness |
| **Data store** | Neon Postgres (normalized, transactional, FSM-constrained) | Redis (denormalized hot cache) + Postgres read replica / materialized views for analytics |
| **Write pattern** | Single-row/transaction writes with row-level locking on `assets.id` to prevent race conditions on concurrent checkout | N/A — never written to directly by user requests |
| **Read pattern** | Only reads its own write for confirmation | Read-through cache: Redis miss → Postgres query → populate Redis with TTL |
| **Consistency model** | Strong (ACID within Neon transaction) | Eventual (Redis invalidated async via QStash event on every command-side commit) |
| **Why split** | ITAM writes are low-volume, high-stakes (must never lose a custody handshake) — optimize for correctness. Reads (dashboards, "show me all laptops in Mumbai office") are high-volume, low-stakes on staleness — optimize for latency. Coupling them forces every dashboard query through the transactional hot path, risking lock contention during high-traffic events like mass onboarding. |

---

## 2. Data Architecture, Schemas & Temporal Tracking

### 2.1 Core Entity Relationships

```
Organization ──< Users ──< CustodyHandshake >── Assets ──< MaintenanceLog
                   │                                │
                   │                                ├──< AssetStateEvent (append-only)
                   │                                └──< HoldingPeriod (derived/materialized)
                   └──< AuditLog (append-only, all entities)
```

| Entity | Key Fields | Notes |
|---|---|---|
| **Asset** | `id (uuid)`, `asset_tag`, `serial_number`, `category`, `model`, `procurement_date`, `warranty_expiry`, `current_state`, `current_holder_id (nullable FK)`, `location_id`, `metadata (jsonb)` | `current_state` and `current_holder_id` are a **denormalized cache** of the latest event — always derivable by replaying `AssetStateEvent`, never the source of truth alone |
| **User** | `id (uuid)`, `org_id`, `employee_id`, `email`, `department`, `role`, `employment_status`, `manager_id` | `employment_status` drives offboarding triggers from HRIS |
| **CustodyHandshake** | `id`, `asset_id`, `from_user_id`, `to_user_id`, `initiated_by`, `initiated_at`, `verification_method (otp/magic_link)`, `verified_at`, `status`, `condition_at_handover (jsonb)` | One row per handshake attempt; failed/expired handshakes are retained, not deleted |
| **HoldingPeriod** | `id`, `asset_id`, `user_id`, `start_ts`, `end_ts (nullable = ongoing)`, `duration_computed (generated column)` | Materialized from closed handshakes; answers "who held X on date Y" via range query |
| **MaintenanceLog** | `id`, `asset_id`, `reported_by`, `issue_type`, `severity`, `vendor_id`, `opened_at`, `closed_at`, `cost`, `resolution_notes` | Linked to state transitions into/out of `MAINTENANCE` / `UNDER_INSPECTION` |
| **AssetStateEvent** | `id`, `asset_id`, `from_state`, `to_state`, `actor_id`, `event_type`, `payload (jsonb)`, `occurred_at`, `event_id (uuid, unique)` | **Append-only, immutable.** This is the true source of truth for asset lifecycle. |
| **AuditLog** | `id`, `entity_type`, `entity_id`, `actor_id`, `action`, `before (jsonb)`, `after (jsonb)`, `ip_address`, `occurred_at` | Covers *all* mutating actions across the system, not just asset state — includes RBAC changes, config edits |

### 2.2 Temporal Tracking Strategy — "Who held Laptop X on March 15, 2025?"

Two complementary techniques, both required for ITIL-grade audit answers:

1. **Event Sourcing for the asset lifecycle** — `AssetStateEvent` is append-only. Current state = fold of all events. Point-in-time state = fold of events where `occurred_at <= T`. This guarantees you can reconstruct *exact* state and *who caused it* for any historical timestamp, including intermediate states like `PENDING_ACCEPTANCE`.
2. **Materialized `HoldingPeriod` intervals** (using Postgres `tstzrange`) for fast range queries — avoids replaying the full event log on every timeline query.

```sql
-- Point-in-time holder lookup (indexed via GiST on tstzrange)
SELECT user_id, condition_at_handover
FROM holding_period
WHERE asset_id = $1
  AND tstzrange(start_ts, COALESCE(end_ts, 'infinity')) @> $2::timestamptz;
```

- `HoldingPeriod` has an explicit two-phase lifecycle, enforced by trigger: **opened** on custody acceptance (`end_ts IS NULL`), **closed exactly once** on return (`end_ts` and `closed_by` set), then **frozen** — no further update or delete is accepted. A partial unique index guarantees at most one open period per asset.
- Condition-at-return is deliberately **not** stored on `HoldingPeriod`. It is discovered during inspection, *after* custody has already ended; writing it back would mean mutating a closed record. It lives on the inspection `AssetStateEvent` and `MaintenanceLog` instead.
- Corrections to history are made by inserting a *compensating* event, never by `UPDATE`/`DELETE`, preserving the audit chain.
- **Cumulative holding duration per user** is a rollup: `SUM(duration_computed) GROUP BY user_id, asset_category` — computed as a nightly materialized view refresh (via QStash cron) rather than on-read, since it's used for reporting, not real-time decisions.

### 2.3 Append-Only Audit Logging Strategy

| Guarantee | Mechanism |
|---|---|
| **Immutability** | Postgres `REVOKE UPDATE, DELETE ON audit_log, asset_state_event FROM application_role` — enforced at the DB grant level, not just app logic. Only a break-glass superuser role (separately audited) can bypass. |
| **Tamper evidence** | Each audit row includes `prev_hash` and `row_hash = sha256(prev_hash + canonical_json(row))`, forming a hash chain per `entity_id`. Any retroactive edit breaks the chain and is detectable by a periodic verification job. |
| **Completeness** | Every command-side mutation runs inside a single DB transaction that writes both the domain row *and* the audit/event row — never allow the domain write to succeed without the audit write (enforced via a Postgres trigger as a backstop, not just application code). |
| **Retention** | Audit and state-event tables are never purged; partitioned by month (Postgres native partitioning) for query performance and eventual cold-storage archival (e.g., to S3/Parquet) after N years, per compliance policy. |

### 2.4 Indexing & Caching Strategy

| Data | Store | TTL / Invalidation | Reason |
|---|---|---|---|
| Current asset state + holder (`asset:{id}:state`) | Redis hash | Invalidated immediately on command-side commit (via QStash event → cache-invalidation worker) | Sub-second lookups for checkout UI ("is this asset available?") without hitting Postgres |
| Full asset timeline (`asset:{id}:timeline`) | Redis sorted set (score = timestamp) or cached JSON blob | TTL 5 min, background-refreshed | Timeline views are read-heavy, tolerate slight staleness |
| Org-wide dashboard KPIs | Redis, TTL 60s | Recomputed by scheduled worker, not on-request | Avoids expensive aggregate queries on every dashboard load |
| Session / RBAC claims | Redis, TTL = session length | Set at login, checked in Middleware | Keeps auth checks out of Postgres entirely |
| Rate-limit counters | Redis (native `@upstash/ratelimit`) | Sliding window | Purpose-built, no Postgres involvement |
| **Postgres indexes** | `asset_state_event(asset_id, occurred_at)`, `holding_period` GiST index on `tstzrange(start_ts,end_ts)`, `assets(current_state)` partial index for `WHERE current_state='AVAILABLE'`, `audit_log(entity_type, entity_id, occurred_at)` | — | Supports both point-in-time and "current state" query patterns efficiently |

---

## 3. Finite State Machine (FSM) & Handshake Workflows

### 3.1 Asset State Transition Matrix

| From \ To | PROCURED | AVAILABLE | PENDING_ACCEPTANCE | ASSIGNED_ACTIVE | UNDER_INSPECTION | MAINTENANCE | RETIRED | LOST |
|---|---|---|---|---|---|---|---|---|
| **PROCURED** | — | ✅ (inventory intake) | ❌ | ❌ | ❌ | ❌ | ✅ (DOA unit) | ❌ |
| **AVAILABLE** | ❌ | — | ✅ (admin checkout) | ❌ | ❌ | ✅ (proactive svc) | ✅ | ❌ |
| **PENDING_ACCEPTANCE** | ❌ | ✅ (timeout/decline) | — | ✅ (OTP verified) | ❌ | ❌ | ❌ | ❌ |
| **ASSIGNED_ACTIVE** | ❌ | ❌ | ❌ | — | ✅ (return initiated) | ❌ | ❌ | ✅ (declared lost) |
| **UNDER_INSPECTION** | ❌ | ✅ (passed, no issue) | ❌ | ✅ (reassign direct) | — | ✅ (damage found) | ✅ (beyond repair) | ❌ |
| **MAINTENANCE** | ❌ | ✅ (repaired) | ❌ | ❌ | ❌ | — | ✅ (unrepairable) | ❌ |
| **RETIRED** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — (terminal) | ❌ |
| **LOST** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (write-off) | — (terminal, unless recovered → UNDER_INSPECTION) |

- All transitions are enforced **exclusively** at the DB layer via a `CHECK` constraint-backed transition table or Postgres function `fn_validate_transition(from, to)` invoked in a trigger — the API layer must not be trusted as the only guard, since internal tooling / scripts could bypass it.
- Every transition **requires** an `actor_id`, `event_type`, and writes one `AssetStateEvent` row. No direct `UPDATE assets SET current_state=...` is permitted outside this function.

### 3.2 Multi-Party Double-Handshake Workflow

```
Admin                    System (Command API)         QStash              Employee
  │                             │                        │                    │
  │ POST /checkout(asset,emp)  │                        │                    │
  ├────────────────────────────▶                        │                    │
  │                             │ TXN: state→PENDING_ACCEPTANCE              │
  │                             │      + CustodyHandshake(status=INITIATED)  │
  │                             │ enqueue "custody.otp_requested" ───────────▶│
  │                             │                        │  send OTP/magic   │
  │                             │                        │  link via email/SMS│
  │                             │                        ├───────────────────▶
  │                             │                        │                    │
  │                             │                        │   Employee clicks  │
  │                             │                        │   link / enters OTP│
  │                             │                        │◀───────────────────┤
  │                             │◀── POST /custody/accept(handshakeId, otp) ──┤
  │                             │ verify OTP (Redis, TTL 10min, one-time use) │
  │                             │ TXN: state→ASSIGNED_ACTIVE                  │
  │                             │      + CustodyHandshake(status=ACCEPTED,    │
  │                             │        verified_at=now)                    │
  │                             │      + HoldingPeriod(start_ts=now)          │
  │                             │ enqueue "custody.accepted" ──────────────▶  │ (notify admin, audit index)
  │                             │                        │                    │
  │        ... time passes, asset in active use ...                          │
  │                             │                        │                    │
  │ POST /return(asset)        │                        │                    │
  ├────────────────────────────▶ TXN: state→UNDER_INSPECTION                 │
  │                             │      + HoldingPeriod(end_ts=now)            │
  │  Admin/Tech inspects, logs condition                                     │
  │ POST /inspection/complete  │                        │                    │
  ├────────────────────────────▶ TXN: state→AVAILABLE | MAINTENANCE | RETIRED│
  │                             │      + MaintenanceLog (if applicable)       │
  │                             │ enqueue "asset.returned" ─────────────────▶ │
```

**Key handshake design points:**
- OTP/magic-link tokens are stored in **Redis with TTL**, never Postgres — they're ephemeral by nature and shouldn't pollute durable storage.
- `PENDING_ACCEPTANCE` has a **QStash-scheduled timeout message** (e.g., 24h delay) that auto-reverts to `AVAILABLE` and notifies the admin if the employee never confirms — prevents assets being stuck in limbo.
- The handshake is **non-repudiable**: `verified_at`, IP address, and verification method are all captured, satisfying ITIL evidence requirements for "who accepted responsibility and when."

### 3.3 Edge Cases & Recovery Procedures

| Scenario | Trigger | Procedure |
|---|---|---|
| **Unreturned asset at offboarding** | HRIS webhook fires `employee.terminated` | Worker checks all `ASSIGNED_ACTIVE` assets for that `user_id` → creates a mandatory `return` task, notifies manager + IT, and if unresolved by last working day, escalates to a `RECOVERY_PENDING` sub-status (flag, not a full FSM state) surfaced on compliance dashboards |
| **Damaged return** | Inspection form submitted with `condition != GOOD` | State → `MAINTENANCE` (repairable) or `RETIRED` (beyond economical repair, per configurable cost threshold); `MaintenanceLog` created; cost attribution optionally charged back to holder's department per policy |
| **Lost/stolen declaration** | Admin or employee files a loss report | State → `LOST` directly from `ASSIGNED_ACTIVE` (bypasses inspection, since asset isn't physically present); triggers mandatory audit event, insurance/security webhook, and MDM remote-wipe command if applicable |
| **Recovered "lost" asset** | Asset physically found | `LOST → UNDER_INSPECTION` only (never straight back to `AVAILABLE`) — forces a condition check before re-circulation |
| **Handshake timeout / employee unreachable** | QStash timeout event fires | `PENDING_ACCEPTANCE → AVAILABLE`, admin notified, handshake row marked `EXPIRED` (retained for audit) |
| **Concurrent checkout race** (two admins assign same asset) | Simultaneous requests | Postgres row-level lock (`SELECT ... FOR UPDATE` on `assets.id`) inside the transition function ensures only one wins; the other receives a `409 Conflict` with current state |

---

## 4. Event Ingestion, Queuing & Async Workers

### 4.1 QStash Event Pipeline — Payload Schemas

All events share an envelope:

```json
{
  "eventId": "uuid",
  "eventType": "asset.assigned",
  "occurredAt": "ISO-8601",
  "orgId": "uuid",
  "actorId": "uuid",
  "version": 1,
  "data": { }
}
```

| Event Type | `data` payload | Consumers |
|---|---|---|
| `asset.assigned` | `{assetId, fromUserId, toUserId, handshakeId}` | Notification worker (OTP send), audit-index worker |
| `custody.accepted` | `{assetId, handshakeId, userId, verifiedAt, ipAddress}` | Audit-index worker, cache-invalidation worker, HoldingPeriod writer |
| `custody.otp_requested` | `{handshakeId, contactMethod, expiresAt}` | Notification worker only |
| `asset.returned` | `{assetId, handshakeId, condition, holdingDurationDays}` | Audit-index, dashboard-refresh, maintenance-router |
| `maintenance.logged` | `{assetId, maintenanceLogId, severity, vendorId}` | Notification worker (vendor alert), audit-index |
| `asset.lost` | `{assetId, reportedBy, lastKnownUserId}` | Security/insurance webhook, MDM remote-wipe trigger, audit-index |
| `employee.offboarding` | `{userId, lastWorkingDay, source: "hris"}` | Asset-recovery worker |

### 4.2 Async Worker Execution & Retry Policy

| Concern | Design |
|---|---|
| **Delivery guarantee** | QStash guarantees at-least-once delivery — all workers **must be idempotent** via `processed_events(event_id UNIQUE)` check-and-insert inside the same transaction as the side effect |
| **Signature verification** | Every worker route validates `Upstash-Signature` header via `verifySignatureAppRouter` (wraps the handler) before processing any payload — rejects forged requests even if endpoint URL leaks |
| **Retry policy** | QStash default exponential backoff (configurable: e.g., retry at 1s, 5s, 30s, 2m, 10m up to `retries: 5`); after exhaustion, message routes to **DLQ** |
| **DLQ handling** | DLQ messages land in a dedicated QStash DLQ topic; a scheduled worker polls the DLQ, logs the failure to `AuditLog` with full payload + failure reason, and raises an alert (Slack/email) for manual triage — never silently dropped |
| **Timeout safety** | Worker functions set `maxDuration` conservatively (e.g., 10s) and do minimal work per invocation — heavy fan-out (bulk CSV import, full MDM sync) is chunked into N QStash messages rather than one long-running job |
| **Ordering** | QStash does not guarantee strict ordering across messages for the same asset under high concurrency; workers must be **commutative-safe** — e.g., always re-derive `current_state` from the latest `AssetStateEvent.occurred_at` rather than trusting event arrival order, and use the `assets.id` row lock for any transition-writing worker |

### 4.3 Scheduled Cron Jobs (QStash Schedules)

| Cron | Frequency | Action |
|---|---|---|
| Overdue return sweep | Every 6h | Query assets `ASSIGNED_ACTIVE` past policy holding limit → enqueue reminder notifications, escalate after 3 reminders |
| Warranty expiry check | Daily | Assets with `warranty_expiry` within 30/7/1 days → notify procurement team |
| Handshake timeout sweep | Every 15 min | Expire stale `PENDING_ACCEPTANCE` handshakes past TTL (backstop in case a per-handshake scheduled message failed) |
| Audit chain verification | Daily | Recompute hash chain over prior day's `audit_log`/`asset_state_event` rows, alert on mismatch |
| Dashboard/materialized view refresh | Every 5–15 min | Refresh `HoldingPeriod` rollups and Redis KPI cache |
| Health/keep-warm ping | Every 4 min | Hit `/api/health` to reduce cold-start probability on critical command-path functions |

---

## 5. Enterprise Integrations, Security & Observability

### 5.1 Integration Strategies

| Integration | Direction | Pattern |
|---|---|---|
| **HRIS (Workday, BambooHR)** | Inbound webhook → our system | HRIS pushes `employee.hired` / `employee.terminated` to a dedicated `/api/webhooks/hris` endpoint → verified (HMAC signature per vendor) → enqueued via QStash → triggers onboarding asset-provisioning workflow or offboarding recovery workflow. Also supports scheduled **pull-based reconciliation** (nightly) as a fallback if webhooks are missed. |
| **MDM (Jamf, Microsoft Intune)** | Bi-directional | Inbound: MDM webhooks push device telemetry (last check-in, OS version, compliance status, geolocation) → stored as `AssetTelemetry` snapshots, do **not** drive FSM transitions directly (telemetry informs, doesn't dictate lifecycle state) except for triggering `MAINTENANCE` flags on compliance failure. Outbound: `asset.lost` event triggers a remote-wipe/lock API call to MDM. |
| **Notifications (Email/SMS)** | Outbound only | Via provider (e.g., SendGrid/Twilio) invoked exclusively from worker endpoints, never from command-side API routes directly (keeps checkout latency independent of email provider latency) |
| **Vendor/repair systems** | Outbound (optional inbound status webhook) | `maintenance.logged` event can optionally create a ticket in an external ITSM (ServiceNow/Jira Service Management) via webhook; status updates flow back through a signed inbound webhook |

### 5.2 RBAC Matrix

| Action | Employee | Department Manager | Asset Admin | Super Admin |
|---|---|---|---|---|
| View own assigned assets | ✅ | ✅ (own + team) | ✅ (all) | ✅ |
| View any asset's current state | ❌ | ✅ (dept scope) | ✅ | ✅ |
| View full audit timeline | ❌ | ❌ | ✅ | ✅ |
| Initiate checkout | ❌ | ❌ | ✅ | ✅ |
| Accept custody (OTP) | ✅ (self only) | ❌ | ❌ | ❌ |
| Initiate return | ✅ (self) | ✅ (team, on behalf) | ✅ | ✅ |
| Log maintenance / inspection | ❌ | ❌ | ✅ | ✅ |
| Declare asset lost | ✅ (self, own asset) | ✅ | ✅ | ✅ |
| Bulk import / procurement | ❌ | ❌ | ✅ | ✅ |
| Configure state-transition rules / policies | ❌ | ❌ | ❌ | ✅ |
| Manage RBAC / roles | ❌ | ❌ | ❌ | ✅ |
| Access DLQ / worker failure logs | ❌ | ❌ | ✅ (read) | ✅ |

- Enforced at two layers: **Edge Middleware** (coarse — route-level role check from Redis-cached session claims) + **DB row-level policy** via Postgres RLS scoped by `org_id` and, for managers, `department_id` — defense in depth so a middleware bug can't leak cross-tenant data.

### 5.3 Observability & Monitoring

| Category | Metric / Signal | Tool |
|---|---|---|
| **Operational KPIs** | Avg. time in `PENDING_ACCEPTANCE`, overdue-return count, asset utilization rate (holding days / total days), MTTR for maintenance, % assets with active warranty | Materialized views → dashboard, refreshed via cron |
| **Event delivery health** | QStash delivery success rate, DLQ depth, average retry count per event type | QStash console + custom `/api/admin/queue-health` reading QStash REST API, alerting via Slack webhook when DLQ depth > threshold |
| **DB performance** | Query latency (p50/p95/p99) on hot paths (checkout txn, timeline lookup), connection pool saturation, slow query log | Neon's built-in metrics + Vercel Observability/OpenTelemetry traces tagged with route name |
| **Function performance** | Cold start rate, invocation duration, error rate per route | Vercel Observability (built-in), exported to a log drain (e.g., Datadog/Better Stack) for long-term retention beyond Vercel's window |
| **Cache health** | Redis hit/miss ratio per key pattern, eviction rate | Upstash console metrics |
| **Security/audit** | Failed OTP attempts, RLS policy denials, webhook signature failures | All logged to `AuditLog` with `action=SECURITY_EVENT`, alerted in real time via QStash → Slack for anomalous spikes |
| **Business/compliance reporting** | Audit chain integrity status, % of custody handshakes fully verified (non-repudiated) | Daily cron verification job (§4.3) feeding a compliance dashboard |

---

## Summary of Key Architectural Decisions

1. **Event-sourced FSM** for assets — the `AssetStateEvent` table is the single source of truth; everything else (current state, holding periods) is derived/materialized for performance.
2. **CQRS split** keeps transactional integrity on the write path isolated from high-volume dashboard/timeline reads, using Redis as the query-side cache.
3. **QStash as the backbone for anything asynchronous or bulk** — sidesteps serverless timeout limits entirely by never doing long work synchronously.
4. **Idempotency + signature verification everywhere** on the async boundary, since QStash's at-least-once delivery model requires it.
5. **Immutability enforced at the database grant level**, not just application code, for audit tables — this is what makes the "100% auditability" claim actually defensible in a compliance review.
