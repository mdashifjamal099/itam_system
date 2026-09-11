# Implementation Plan

This plan turns the gaps recorded in `IMPLEMENTATION_GAPS.md` into small, ordered phases. Complete and verify each phase before starting the next one.

Last updated: 2026-09-11

## Guiding Order

1. Make existing behaviour correct.
2. Make documentation match the code.
3. Secure and operate the existing product safely.
4. Add external integrations.
5. Add convenience and scale features.

This order avoids building new features on top of failing tests or unclear behaviour.

## Phase 1: Stabilise the Existing Core — Complete (2026-09-11)

Goal: make the current automated test suite fully pass and protect the two affected business rules.

Work:

- Fix the overdue-sweep task counter so the first sweep reports newly created recovery tasks and a repeated sweep remains idempotent.
- Fix the audit-log trigger so both `UPDATE` and `DELETE` are rejected, including when the database owner connects directly.
- Add or adjust focused tests only when they clarify the required behaviour.
- Run the full test suite, TypeScript check, and production build.

Acceptance criteria:

- `npm test` passes with no failures.
- The overdue sweep creates one task on its first run and no duplicate task on a second run.
- Direct updates and deletes against `audit_log` are rejected.
- `npx tsc --noEmit` and `npm run build` succeed.

Completed verification:

- The overdue-sweep function now counts only newly inserted recovery tasks; repeated runs update reminders without reporting another task.
- The audit-log immutable trigger rejects both updates and deletes.
- Auth.js JWT typing and local database query typings were corrected so TypeScript validates the application.
- Test server output is isolated in `.next-test`, avoiding collisions with a normal local Next.js server or production build.
- `npm test -- --reporter=dot`: 11 test files and 83 tests passed.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed.

## Phase 2: Bring Documentation Up to Date — Complete (2026-09-11)

Goal: ensure a new developer can trust the project documentation.

Work:

- Update `README.md` with the real test command and current testing status.
- Update `README.md` and `context.md` to describe the implemented Auth.js credentials login accurately.
- Correct stale test counts and overdue-sweep notes in `context.md`.
- Compare `SYSTEM_DESIGN.md` with the implemented system and label planned features clearly as planned.
- Add a short local-development and verification checklist.

Acceptance criteria:

- Documentation distinguishes implemented features from stubs and future work.
- Setup, database verification, tests, type checking, and build commands are accurate.
- No document describes the authentication flow as only a cookie stub.

Completed verification:

- `README.md` now includes test, type-check, and build commands plus a clear list of remaining production work.
- `context.md` now records the Auth.js flow, 83/83 passing tests, the resolved sweep issue, and the isolated `.next-test` test output.
- `SYSTEM_DESIGN.md` now identifies itself as a target production design and lists the major features that remain planned.

## Phase 3: Production Authentication and Authorisation — In Progress

Goal: safely identify users and enforce exactly what each role may access.

Work:

- Review Auth.js session settings, cookie security, expiry, error handling, and environment requirements.
- Design and implement a user lifecycle: invite/provision, deactivate, reset password, and role changes.
- Add department/team relationships needed to scope managers.
- Enforce manager department restrictions in database row-level security, not only route code.
- Add tests for cross-department denial and allowed manager access.

Acceptance criteria:

- Production users cannot rely on the dev/test `actor_id` path.
- A manager cannot read or change assets outside their department.
- User account changes are audited and covered by tests.

Progress on 2026-09-11:

- Existing signed sessions are now revalidated against `app_user.employment_status` on every request.
- Terminating a user immediately invalidates any existing session; the new real-login regression test passes.
- `npx tsc --noEmit` passes, and the focused Auth.js suite passes with 12 tests.

Blocked decisions before department enforcement and full account lifecycle work:

- Confirm whether managers should be limited by the current free-text `department` field, or whether departments must become managed records with a stable ID and hierarchy.
- Confirm the required production identity model: credentials only, Microsoft/Google OAuth, or company SSO/SAML.

## Phase 4: Operational Safety and Deployment Foundation

Goal: make releases and failures visible and repeatable.

Work:

- Add CI to run tests, type checking, migration verification, and production builds.
- Write a deployment checklist for Vercel, PostgreSQL/Neon, QStash, and Redis.
- Document every required production environment variable and a secret-rotation process.
- Add structured logs for API errors, webhook failures, cron runs, and worker failures.
- Define alerts for audit-chain failures, outbox backlog, failed jobs, and webhook failures.

Acceptance criteria:

- Every code change is automatically verified before release.
- Deployment and rollback steps are documented.
- Operators can find failed asynchronous work and know how to respond.

## Phase 5: Real Asynchronous Integrations

Goal: replace console-log placeholders with configurable, reliable integrations.

Work:

- Define provider adapter interfaces so the application is not tied to one vendor.
- Implement one notification provider (email first; SMS optional after email works).
- Add notification templates, provider response recording, retries, and a UI or report for failed delivery.
- Implement one MDM provider after choosing the organisation's platform (for example, Intune or Jamf).
- Add MDM event storage and secure inbound webhook validation where supported.
- Verify QStash dispatch, scheduled jobs, retry rules, and dead-letter handling in a non-local environment.

Acceptance criteria:

- A real test notification is delivered and its outcome is recorded.
- Failed integrations can be retried safely without duplicate actions.
- MDM destructive actions require explicit audit records and safe provider confirmation.
- Scheduled and queued jobs are observable in the chosen production environment.

## Phase 6: Performance and Abuse Protection

Goal: protect the service and improve common read performance without weakening correctness.

Work:

- Add Redis-backed rate limiting to login, public webhook, and high-cost API endpoints.
- Cache only suitable read data, starting with dashboard/KPI summaries if measurements show a need.
- Define cache keys, expiry times, and invalidation events.
- Add tests for rate-limit responses and cache invalidation.

Acceptance criteria:

- Sensitive endpoints have documented limits and return clear rate-limit responses.
- Cached data is tenant-safe and is invalidated after relevant changes.
- Performance improvements are measured before being kept.

## Phase 7: Production Administration and UI Quality

Goal: let administrators operate the product without direct database access.

Work:

- Add organisation provisioning and settings screens.
- Add user management and department/team administration.
- Add CSV asset import/export with validation and error reporting.
- Add integration-attempt and retry administration views.
- Add Playwright browser tests for login, core asset actions, and admin workflows.
- Add automated accessibility checks for forms and keyboard navigation.

Acceptance criteria:

- An administrator can provision users, manage policy settings, and import assets through the UI.
- Core user journeys pass in a real browser.
- Key forms meet baseline accessibility checks.

## Decisions Needed Before Phases 3 and 5

- Which identity model is required: local credentials only, Google/Microsoft OAuth, or company SSO/SAML?
- Which notification provider should be used for email and, if needed, SMS?
- Which MDM platform does the organisation use: Intune, Jamf, or another provider?
- What is the official department/team structure that should control manager access?
- Which hosting accounts will be used for Vercel, database, Redis, and QStash?

## Immediate Next Action

Start Phase 1. It has no external-provider dependency and removes the two known correctness failures before new work begins.
