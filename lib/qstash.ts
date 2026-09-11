import { Client } from "@upstash/qstash";
import { sql } from "./db";
import { asDrainer } from "./tenant";

const token = process.env.QSTASH_TOKEN;
const client = token ? new Client({ token }) : null;

export const brokerConfigured = client !== null;

export type OutboxRow = {
  event_id: string;
  org_id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  actor_id: string | null;
  data: Record<string, unknown>;
  occurred_at: string;
  publish_attempts: number;
};

export type Envelope = ReturnType<typeof toEnvelope>;

export function toEnvelope(row: OutboxRow) {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    orgId: row.org_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    actorId: row.actor_id,
    version: 1,
    data: row.data,
  };
}

function baseUrl() {
  return process.env.APP_URL ?? "http://localhost:3000";
}

/**
 * Drains committed outbox rows to the broker.
 *
 * Commands never call this — they commit the outbox row and return. Publishing
 * is a separate step precisely so a broker outage cannot fail or roll back a
 * state transition. Anything that fails here keeps published_at NULL and is
 * retried on the next drain.
 */
export async function drainOutbox(limit = 100) {
  const rows = await asDrainer<OutboxRow>(sql`
    SELECT event_id, org_id, aggregate_id, aggregate_type, event_type,
           actor_id, data, occurred_at, publish_attempts
    FROM event_outbox
    WHERE published_at IS NULL
    ORDER BY occurred_at
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED`);

  let published = 0;
  let failed = 0;

  for (const row of rows) {
    const envelope = toEnvelope(row);
    try {
      if (client) {
        await client.publishJSON({
          url: `${baseUrl()}/api/workers/dispatch`,
          body: envelope,
          retries: 5,
          // QStash-side dedupe; processed_event is the authoritative guard.
          deduplicationId: row.event_id,
        });
      } else {
        // No broker configured: deliver in-process so the pipeline is still
        // exercised end to end during development.
        const res = await fetch(`${baseUrl()}/api/workers/dispatch`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-local-dispatch": "1" },
          body: JSON.stringify(envelope),
        });
        if (!res.ok) throw new Error(`local dispatch ${res.status}: ${await res.text()}`);
      }

      await asDrainer(sql`
        UPDATE event_outbox
        SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL
        WHERE event_id = ${row.event_id}::uuid`);
      published++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await asDrainer(sql`
        UPDATE event_outbox
        SET publish_attempts = publish_attempts + 1, last_error = ${message}
        WHERE event_id = ${row.event_id}::uuid`);
      failed++;
    }
  }

  return { scanned: rows.length, published, failed };
}
