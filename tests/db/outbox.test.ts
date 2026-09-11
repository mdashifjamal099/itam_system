import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { ownerClient, setOrg, seedScenario } from "../helpers/db";
import type { Client } from "pg";

describe("Transactional outbox, processed_event, integration_attempt", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  it("writes exactly one outbox row per transition, unpublished, in the same transaction as the event/audit rows", async () => {
    const { orgId, adminId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    const before = await owner.query(
      `SELECT
         (SELECT count(*) FROM asset_state_event WHERE asset_id=$1) ev,
         (SELECT count(*) FROM audit_log WHERE entity_id=$1) au,
         (SELECT count(*) FROM event_outbox WHERE aggregate_id=$1) ob
       `,
      [assetId],
    );

    await owner.query(`SELECT fn_transition_asset($1,'MAINTENANCE',$2,'test.outbox')`, [
      assetId,
      adminId,
    ]);

    const after = await owner.query(
      `SELECT
         (SELECT count(*) FROM asset_state_event WHERE asset_id=$1) ev,
         (SELECT count(*) FROM audit_log WHERE entity_id=$1) au,
         (SELECT count(*) FROM event_outbox WHERE aggregate_id=$1) ob
       `,
      [assetId],
    );

    for (const key of ["ev", "au", "ob"] as const) {
      expect(Number(after.rows[0][key])).toBe(Number(before.rows[0][key]) + 1);
    }

    const outboxRow = await owner.query(
      `SELECT published_at, event_type FROM event_outbox
       WHERE aggregate_id=$1 ORDER BY id DESC LIMIT 1`,
      [assetId],
    );
    expect(outboxRow.rows[0].published_at).toBeNull();
    expect(outboxRow.rows[0].event_type).toBe("test.outbox");
  });

  it("rolling back the transition (illegal transition) leaves no outbox row behind", async () => {
    const { orgId, adminId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    const before = await owner.query(
      `SELECT count(*) n FROM event_outbox WHERE aggregate_id=$1`,
      [assetId],
    );

    await expect(
      owner.query(`SELECT fn_transition_asset($1,'ASSIGNED_ACTIVE',$2,'bogus')`, [
        assetId,
        adminId,
      ]),
    ).rejects.toThrow();

    const after = await owner.query(
      `SELECT count(*) n FROM event_outbox WHERE aggregate_id=$1`,
      [assetId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("processed_event: a redelivery to the SAME consumer is a no-op", async () => {
    const eventId = randomUUID();
    const first = await owner.query(
      `INSERT INTO processed_event (event_id, consumer) VALUES ($1,'notify')
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [eventId],
    );
    expect(first.rows).toHaveLength(1);

    const redelivery = await owner.query(
      `INSERT INTO processed_event (event_id, consumer) VALUES ($1,'notify')
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [eventId],
    );
    expect(redelivery.rows).toHaveLength(0);
  });

  it("processed_event: a DIFFERENT consumer can still claim the same event (composite PK)", async () => {
    const eventId = randomUUID();
    await owner.query(`INSERT INTO processed_event (event_id, consumer) VALUES ($1,'notify')`, [
      eventId,
    ]);

    const otherConsumer = await owner.query(
      `INSERT INTO processed_event (event_id, consumer) VALUES ($1,'dispatch')
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [eventId],
    );
    expect(otherConsumer.rows).toHaveLength(1);
  });

  it("integration_attempt: (event_id, integration) is unique and tracks status independently of processed_event", async () => {
    const eventId = randomUUID();
    const { orgId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    await owner.query(
      `INSERT INTO integration_attempt (org_id, event_id, integration, idempotency_key, status, attempts)
       VALUES ($1,$2,'email',$3,'PENDING',1)`,
      [orgId, eventId, `${eventId}:email`],
    );

    // Simulates a worker crashing after the email was sent but before it could
    // mark SUCCEEDED, then a redelivery retrying: attempts increments, status
    // stays queryable so the caller can decide whether to skip re-sending.
    const retry = await owner.query(
      `INSERT INTO integration_attempt (org_id, event_id, integration, idempotency_key, status, attempts)
       VALUES ($1,$2,'email',$3,'PENDING',1)
       ON CONFLICT (event_id, integration) DO UPDATE
         SET attempts = integration_attempt.attempts + 1
       RETURNING attempts, status`,
      [orgId, eventId, `${eventId}:email`],
    );
    expect(Number(retry.rows[0].attempts)).toBe(2);

    await owner.query(
      `UPDATE integration_attempt SET status='SUCCEEDED' WHERE event_id=$1 AND integration='email'`,
      [eventId],
    );

    // A second integration (mdm) for the SAME event_id is a separate row.
    const mdm = await owner.query(
      `INSERT INTO integration_attempt (org_id, event_id, integration, idempotency_key, status, attempts)
       VALUES ($1,$2,'mdm',$3,'PENDING',1) RETURNING id`,
      [orgId, eventId, `${eventId}:mdm`],
    );
    expect(mdm.rows).toHaveLength(1);

    const rows = await owner.query(
      `SELECT integration, status FROM integration_attempt WHERE event_id=$1 ORDER BY integration`,
      [eventId],
    );
    expect(rows.rows).toEqual([
      { integration: "email", status: "SUCCEEDED" },
      { integration: "mdm", status: "PENDING" },
    ]);
  });
});
