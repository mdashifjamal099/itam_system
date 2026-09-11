# Work Queue — verified state and ordered plan

Independent verification run on 2026-09-11. This supersedes the status claims in
`IMPLEMENTATION_GAPS.md` / `IMPLEMENTATION_PLAN.md` where they disagree.

## Verified state (not claimed — actually run)

| Check | Docs claim | Actual |
|---|---|---|
| `npm test` | 83/83 pass | **82 pass / 2 FAIL (84 total)** |
| `npx tsc --noEmit` | pass | pass |
| `npm run db:verify` | — | 23/23 pass |
| UI render (dashboard, ops, asset detail) | "minimal but functional" | all render 200 |

Note: a transient HTTP 500 on `/assets/[id]` was traced to a corrupted `.next`
build cache (`Cannot find module './vendor-chunks/next.js'`), not application
code. `rm -rf .next` clears it. Likely caused by a normal dev server and the
test server's build running against overlapping output directories.

---

## P0-1 — Offboarded employee cannot return their own asset (BLOCKING, 2 failing tests)

**Symptom**
- `tests/api/offboarding.test.ts` — recovery task stays `OPEN`, expected `RESOLVED`.
- `tests/e2e/flows.test.ts` — `POST /api/assets/[id]/return` returns 403, expected 200.

**Root cause**
`lib/auth.ts` rejects any actor whose `employment_status !== 'ACTIVE'`:

```ts
if (!actor || actor.employment_status !== "ACTIVE") return null;
```

`fn_offboard_user` sets `employment_status = 'TERMINATED'` and simultaneously
creates an `OFFBOARDING` recovery task that expects the asset back. The session
revalidation then locks that user out, so the actor the test uses to perform the
return is denied.

**Decision: the security check is correct; the tests encode an unrealistic flow.**
A terminated employee must not retain system access. In reality IT receives the
device and records the return — and `/api/assets/[id]/return` already permits
`MANAGER`, `ASSET_ADMIN`, `SUPER_ADMIN` to return on another user's behalf. So
the fix is to correct the tests, **not** to weaken the employment-status check.

**Implementation plan**
1. `tests/api/offboarding.test.ts` — have the **admin** perform the return after
   offboarding (the real recovery path). Keep asserting the task auto-resolves.
2. `tests/e2e/flows.test.ts` — same change in the HRIS offboarding flow.
3. Add a **new regression test** asserting the security property explicitly:
   after offboarding, the terminated employee's own requests are rejected.
   Without this, a future change could silently re-open access and no test would
   notice — the two "fixed" tests would still pass.

**Test cases**
| # | Case | Expected |
|---|---|---|
| 1 | Admin returns asset after employee offboarded | 200; `recovery_task.status = RESOLVED` |
| 2 | Terminated employee calls `/return` on their old asset | 403 (locked out) |
| 3 | Terminated employee calls any authenticated route | 403 |
| 4 | HRIS webhook offboarding → admin return → task resolved | 200; resolved |
| 5 | Active employee can still return their own asset | 200 (no regression) |

---

## P1 — Unblocked work (no external vendor or account needed)

### P1-1 CI pipeline
Run `npm test`, `npx tsc --noEmit`, `npm run build`, and migration verification on
every push/PR. Nothing here depends on a third party.
*Tests:* workflow runs green on a clean checkout; a deliberately broken commit fails it.

### P1-2 Org policy admin UI
`org_policy` (max holding days, warranty alert days, handshake TTL) is settable
only via SQL today. Add an admin-only settings screen + route.
*Tests:* non-admin gets 403; update persists; invalid values rejected; sweep
behaviour changes after the limit is edited.

### P1-3 User management / provisioning UI
No way to add a user or change a role without direct DB access.
*Tests:* admin creates user → can sign in; role change is audited; non-admin 403;
duplicate email rejected; cross-tenant creation blocked by RLS.

### P1-4 CSV asset import/export
*Tests:* valid CSV imports all rows; malformed row rejected with row-level error
report; partial failure does not half-commit; duplicate `asset_tag` rejected;
import is audited.

### P1-6 Add Asset UI (procurement intake)
Not built — flagged live during a demo. No route or form exists to create a
brand-new asset from the app; the only way in is `scripts/seed.mjs` direct
SQL. Admin-only form: asset_tag, serial_number, category, model, vendor,
procurement_date, warranty_expiry, location → inserts the row and runs it
through `fn_transition_asset` intake (PROCURED -> AVAILABLE), same as seed.mjs.
*Tests:* non-admin 403; duplicate asset_tag/serial rejected with a clean 400/409;
created asset is audited (asset.intake event); cross-tenant creation blocked by
RLS; appears immediately in the dashboard grid.

### P1-5 Structured logging + error surface
Replace `console.log` with a structured logger carrying request id, org id, actor
id, route. *Tests:* error responses never leak SQL/internal details; each failed
request emits exactly one structured error line.

---

## P2 — Blocked on a decision from you

| Item | Decision needed |
|---|---|
| Manager department scoping (RLS) | Is `department` the free-text field it is today, or must departments become managed records with stable ids + hierarchy? RLS policy shape depends entirely on this. |
| Real email/SMS provider | Which provider — SendGrid, Resend, SES, Twilio? Needs an account + API key. |
| Real MDM integration | Jamf, Intune, or other? Needs tenant credentials. |
| Redis cache + rate limiting | Upstash account/credentials, or should rate limiting be Postgres-backed to avoid a new dependency? |
| Live QStash verification | Upstash QStash account + a publicly reachable deployment URL. |

I can implement adapters behind interfaces for these now (so no vendor lock-in and
tests can run against fakes), but the live wiring needs the accounts above.

---

## P3 — Quality

- Playwright browser tests for login, checkout→OTP→return→inspect, ops dashboard.
- Accessibility pass: form labels, keyboard nav, focus order, contrast.

---

## Execution order

1. **P0-1** — done. 87/87 passing (see below for how it grew further).
2. **P1-1 CI** — done (`.github/workflows/ci.yml`).
3. **P1-3 admin user provisioning** — done (below).
4. P1-2 / P1-4 / P1-5 remaining admin surfaces.
5. P2 once decisions land.
6. P3.

---

## Done: P1-1 — CI pipeline

`.github/workflows/ci.yml`. Real Postgres service container (not mocked),
mirrors the local setup exactly: `tsc --noEmit` → migration idempotency check
(fresh apply + clean re-apply) → `npm test` (spawns its own server against the
service container) → `npm run build`.

## Done: P1-3 — Admin user provisioning ("signup")

Decision made: **admin-invite model**, not public self-service signup — an
`ASSET_ADMIN`/`SUPER_ADMIN` creates accounts inside their own org. No public
signup button exists anywhere by design; matches standard B2B SaaS (you can't
join someone else's company by signing up).

**Built:**
- `db/008_user_management.sql` — `fn_create_user`, `fn_update_user`, both
  audited in the same transaction, same pattern as every other domain mutation.
- `POST/GET /api/ops/users`, `PATCH /api/ops/users/[id]`.
- `/dashboard/users` — invite form + member table with inline role edit and
  activate/deactivate, admin-only nav entry.
- Temp password shown once on creation (no email provider), same "don't
  auto-refresh and destroy the one-time value" pattern used for the checkout OTP.
- 11 new tests: creation + immediate login, RBAC (EMPLOYEE/MANAGER denied),
  duplicate email → clean 409, invalid role/email → 400, org_id cannot be
  smuggled, cross-tenant list isolation, role change audited with before/after,
  deactivation immediately revokes session, admin cannot self-demote/deactivate,
  cannot update a user in a different org.

**Bugs found and fixed along the way (not part of the plan, discovered live):**
- `scripts/db:verify` (the separate 23-check invariant script) broke on rerun
  after the email-uniqueness fix — same root cause as `seed.mjs` had: hardcoded
  literal emails colliding with its own never-cleaned-up scratch orgs. Fixed
  with a per-run unique suffix.
- Confirmed (not a bug): inspection is `ASSET_ADMIN`/`SUPER_ADMIN`-only, a
  `MANAGER` cannot complete inspections despite seeing the Ops Dashboard.
- A transient Next.js dev-server `clientReferenceManifest` error appeared
  while hot-adding new client component files with `next dev` still running —
  self-healed after Next recompiled; a full restart (`rm -rf .next`) avoids it.

**Verified:** 98/98 tests, `tsc` clean, `db:verify` 23/23 (and rerunnable).
