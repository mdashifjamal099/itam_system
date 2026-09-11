import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { ownerClient, seedScenario, setOrg } from "../helpers/db";
import { api, loginAs } from "../helpers/api";
import type { Client } from "pg";

const CRON_HEADERS = { authorization: `Bearer ${process.env.CRON_SECRET}` };

describe("Async pipeline: outbox drain -> worker dispatch", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();

    // drainOutbox is called with a fixed batch limit (100), oldest-first. By
    // the time this file runs, earlier test files (checkout-flow, cron,
    // offboarding — none of which drain their own events) have left a large
    // FIFO backlog of unpublished rows. Without clearing it first, a single
    // drain call in a test below could reach only the OLD backlog and never
    // touch the row that test just created, which would look like drainOutbox
    // silently dropping events when it is really just still working through
    // a multi-thousand-row queue. Draining to empty here first (a cron would
    // do the same on its next tick) gives each test a clean, single-call
    // guarantee for its own event.
    for (let i = 0; i < 50; i++) {
      const res = await api<{ scanned: number }>("/api/cron/drain-outbox", {
        method: "POST",
        headers: CRON_HEADERS,
      });
      if (res.body.scanned === 0) break;
    }
  });
  afterAll(async () => {
    await owner.end();
  });

  it("a real checkout's outbox row is published by the drain and the worker records a real integration_attempt", async () => {
    const { orgId, adminId, employeeId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);
    const adminCookie = await loginAs(adminId);

    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId },
    });
    expect(checkout.status).toBe(200);
    const eventId = checkout.body.outboxEventId as string;

    const before = await owner.query(
      `SELECT published_at FROM event_outbox WHERE event_id=$1`,
      [eventId],
    );
    expect(before.rows[0].published_at).toBeNull();

    const drain = await api(`/api/cron/drain-outbox`, { method: "POST", headers: CRON_HEADERS });
    expect(drain.status).toBe(200);
    expect(drain.body.failed).toBe(0);

    const after = await owner.query(
      `SELECT published_at FROM event_outbox WHERE event_id=$1`,
      [eventId],
    );
    expect(after.rows[0].published_at).not.toBeNull();

    // The worker actually ran for THIS event: processed_event claimed it, and
    // an integration_attempt row exists for it (the email stub "sent" and was
    // durably recorded) — real dispatch, not a mock.
    const claimed = await owner.query(
      `SELECT 1 FROM processed_event WHERE event_id=$1 AND consumer='dispatch'`,
      [eventId],
    );
    expect(claimed.rows).toHaveLength(1);

    const integration = await owner.query(
      `SELECT status, integration FROM integration_attempt WHERE event_id=$1`,
      [eventId],
    );
    expect(integration.rows).toHaveLength(1);
    expect(integration.rows[0]).toMatchObject({ status: "SUCCEEDED", integration: "email" });
  });

  it("re-draining does not re-publish an already-published event", async () => {
    const { orgId, adminId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    await owner.query(`SELECT fn_transition_asset($1,'MAINTENANCE',$2,'test.drain')`, [
      assetId,
      adminId,
    ]);
    const outboxRow = await owner.query(
      `SELECT event_id FROM event_outbox WHERE aggregate_id=$1 AND event_type='test.drain'`,
      [assetId],
    );
    const eventId = outboxRow.rows[0].event_id;

    await api(`/api/cron/drain-outbox`, { method: "POST", headers: CRON_HEADERS });
    const firstPublishedAt = (
      await owner.query(`SELECT published_at FROM event_outbox WHERE event_id=$1`, [eventId])
    ).rows[0].published_at;
    expect(firstPublishedAt).not.toBeNull();

    const secondDrain = await api(`/api/cron/drain-outbox`, {
      method: "POST",
      headers: CRON_HEADERS,
    });
    expect(secondDrain.status).toBe(200);

    const secondPublishedAt = (
      await owner.query(`SELECT published_at FROM event_outbox WHERE event_id=$1`, [eventId])
    ).rows[0].published_at;
    // Untouched: the drain's WHERE published_at IS NULL means this row was
    // never selected the second time, so it cannot have been re-sent.
    expect(secondPublishedAt).toEqual(firstPublishedAt);

    const dispatchClaims = await owner.query(
      `SELECT count(*) n FROM processed_event WHERE event_id=$1`,
      [eventId],
    );
    expect(Number(dispatchClaims.rows[0].n)).toBe(1);
  });

  it("worker dispatch: an identical redelivery (same eventId) is a no-op, not reprocessed", async () => {
    const { orgId, assetId } = await seedScenario(owner);
    const envelope = {
      eventId: randomUUID(),
      eventType: "asset.returned", // a real, harmless no-op branch in the worker
      occurredAt: new Date().toISOString(),
      orgId,
      aggregateType: "asset",
      aggregateId: assetId,
      actorId: null,
      version: 1,
      data: { assetId },
    };

    const first = await api(`/api/workers/dispatch`, { body: envelope });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("processed");

    const redelivery = await api(`/api/workers/dispatch`, { body: envelope });
    expect(redelivery.status).toBe(200);
    expect(redelivery.body.status).toBe("duplicate_ignored");

    const claims = await owner.query(
      `SELECT count(*) n FROM processed_event WHERE event_id=$1`,
      [envelope.eventId],
    );
    expect(Number(claims.rows[0].n)).toBe(1);
  });

  it("worker failure: an event that errors mid-handling releases its processed_event claim for retry", async () => {
    const { adminId, employeeId } = await seedScenario(owner);
    const envelope = {
      eventId: randomUUID(),
      eventType: "asset.assigned",
      occurredAt: new Date().toISOString(),
      // Deliberately invalid: fn_current_org()'s ::uuid cast inside withTenant
      // throws when this reaches a real query, which is exactly the mid-handler
      // failure this test needs to force without touching application code.
      orgId: "not-a-real-uuid",
      aggregateType: "asset",
      aggregateId: "00000000-0000-0000-0000-000000000000",
      actorId: adminId,
      version: 1,
      data: { toUserId: employeeId, handshakeId: "x", expiresAt: "2099-01-01" },
    };

    const res = await api(`/api/workers/dispatch`, { body: envelope });
    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe("string");

    // The claim must be released, not left stuck, or QStash's retry would be
    // permanently swallowed as a false "duplicate".
    const claims = await owner.query(
      `SELECT count(*) n FROM processed_event WHERE event_id=$1`,
      [envelope.eventId],
    );
    expect(Number(claims.rows[0].n)).toBe(0);

    // And retrying the exact same envelope is genuinely retried, not skipped —
    // it fails again the same way rather than silently no-op'ing.
    const retry = await api(`/api/workers/dispatch`, { body: envelope });
    expect(retry.status).toBe(500);
  });

  it("worker dispatch requires a JSON body and fails loudly on garbage input", async () => {
    const res = await fetch(`${process.env.APP_URL}/api/workers/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(500);
  });
});
