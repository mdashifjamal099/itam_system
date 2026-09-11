# Implementation Gaps

This document records what is still missing or incomplete in the ITAM platform before planning the next implementation phase.

Last checked: 2026-09-11

## Current Phase

The project is in the testing and hardening phase.

Most of the core product exists: database schema, asset lifecycle FSM, audit log, transactional outbox, API routes, minimal UI, cron routes, HRIS webhook, and automated tests.

It is not production-ready yet because several production integrations and operational controls are still placeholders.

## Verification Snapshot

Command run:

```bash
npm test
```

Current result:

```text
83 tests passed
0 tests failed
83 total tests
```

The Phase 1 audit-log and overdue-sweep issues are resolved and covered by the suite.

## Missing Or Incomplete Production Features

### Authentication

Status: partially implemented.

What exists:

- Auth.js / NextAuth credentials login exists.
- Password hashes are supported with `password_hash`.
- Signed JWT session flow exists.
- Dev/test-only `actor_id` cookie path still exists outside production.

What is lacking:

- OAuth/SAML/SSO is not implemented.
- Password reset, account lifecycle management, and admin user provisioning are not implemented.
- Session hardening needs review for production behavior.
- Documentation now reflects the implemented credentials and signed-session flow.

Updated 2026-09-11: active sessions are revalidated against employment status on every request, so terminating a user revokes an existing session immediately.

### Email And SMS Notifications

Status: stub only.

What exists:

- Notification events flow through the outbox and worker path.
- `integration_attempt` records durability and idempotency.

What is lacking:

- No real SendGrid, Twilio, SMTP, or email/SMS provider integration.
- `sendNotification()` only logs to the console.
- No templates, retry visibility, delivery status sync, or provider error handling beyond the local stub.

### MDM Integration

Status: outbound stub only.

What exists:

- Lost asset events can call `mdmRemoteWipe()`.
- The call is wrapped in the same integration-attempt mechanism as notifications.

What is lacking:

- No real Jamf, Intune, or other MDM provider connection.
- `mdmRemoteWipe()` only logs to the console.
- No inbound MDM telemetry webhook.
- No storage or UI for device compliance, last check-in, lock/wipe status, or geolocation.

### Redis Caching And Rate Limiting

Status: designed but not wired.

What exists:

- Upstash Redis is listed as a dependency.
- The system design describes Redis for cache, session/RBAC claims, and rate limiting.

What is lacking:

- No real Redis cache implementation is used in the app code.
- Dashboard and timeline reads are currently Postgres-backed.
- No rate limiting middleware is implemented.
- No Redis cache invalidation worker exists.

### QStash Production Deployment

Status: local fallback exists, live production path not verified.

What exists:

- Outbox drainer exists.
- Worker dispatch route exists.
- Cron routes exist.
- Local mode can dispatch events in-process when `QSTASH_TOKEN` is not configured.

What is lacking:

- No proof this has been tested against live QStash.
- No QStash schedules are configured in the repo.
- No dead-letter queue handling UI or operational workflow exists.
- No production alerting for failed async jobs exists.

### Department-Scoped Manager Access

Status: route-level role checks exist, full policy enforcement is incomplete.

What exists:

- Manager role exists.
- API routes check broad role permissions.
- Tenant isolation exists at the database level.

What is lacking:

- Managers are not fully restricted to their own department/team at the RLS policy level.
- Department/team data model may need strengthening before implementing this safely.
- Tests should verify manager scoping once implemented.

### Browser-Level UI Testing

Status: not implemented.

What exists:

- HTTP-level end-to-end tests exist.
- API and database tests cover many workflows.

What is lacking:

- No Playwright or browser-driven UI tests.
- No automated validation of login page, asset detail actions, dashboard forms, or visual regressions.
- No accessibility checks for forms, keyboard navigation, or screen reader labels.

### CI/CD

Status: not implemented.

What is lacking:

- No GitHub Actions or other CI pipeline.
- No automated `npm test`, `npx tsc --noEmit`, migration verification, or build check on pull requests.
- No deployment workflow for Vercel/Neon/Upstash.

### Production Secrets And Environment Management

Status: local env files only.

What exists:

- `.env.example`, `.env.local`, and `.env.test` patterns exist.

What is lacking:

- No production secret-management process is implemented.
- No documented Vercel environment variable setup checklist.
- No rotation process for `NEXTAUTH_SECRET`, `CRON_SECRET`, HRIS webhook secrets, QStash keys, or database credentials.

### Observability And Operations

Status: mostly design only.

What exists:

- Audit-chain verification route exists.
- KPI endpoint and dashboard exist.

What is lacking:

- No structured logging strategy.
- No metrics dashboard for API latency, worker failures, outbox backlog, auth failures, or cron health.
- No alerting for audit-chain breakage, QStash failures, webhook failures, or DLQ depth.
- No admin UI for integration attempts or event retries.

### Production Data Administration

Status: minimal seed/dev flow only.

What exists:

- Seed script creates demo organization, users, and assets.
- UI supports basic asset lifecycle operations.

What is lacking:

- No production organization provisioning workflow.
- No user management UI.
- No asset import/export workflow.
- No bulk upload or CSV import.
- No admin settings UI for org policy values such as max holding days or warranty alert days.

## Documentation Status

Phase 2 updated `README.md`, `context.md`, and `SYSTEM_DESIGN.md` on 2026-09-11.
They now describe the 83-test verification result, Auth.js credentials login,
the dev/test-only actor helper, and the difference between implemented features
and planned production architecture.

## Suggested Next Planning Buckets

Use these buckets when creating the implementation plan:

1. Fix failing tests and make the suite green.
2. Update stale documentation to match the current code.
3. Harden authentication for production.
4. Replace notification and MDM stubs with real providers or clearly configurable adapters.
5. Implement Redis caching and rate limiting.
6. Verify QStash in a real environment and add operational failure handling.
7. Add manager department scoping at the database policy level.
8. Add CI/CD and production deployment documentation.
9. Add browser UI tests and accessibility checks.
10. Add admin workflows for production data management.
