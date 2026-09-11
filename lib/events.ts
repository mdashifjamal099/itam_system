import { sql } from "./db";
import { asDrainer } from "./tenant";

export type OutboxRow = {
  event_id: string;
  org_id: string;
  aggregate_id: string;
  event_type: string;
  actor_id: string | null;
  data: Record<string, unknown>;
  occurred_at: string;
};

/**
 * Reads unpublished outbox rows. Command handlers never call this — they commit
 * the outbox row and return. Publishing is a separate concern so that a broker
 * outage can never fail or roll back a committed state transition.
 *
 * v1 has no broker wired up: this exists so the drain path is real and testable
 * before QStash is introduced.
 */
export async function pendingEvents(limit = 100): Promise<OutboxRow[]> {
  return asDrainer<OutboxRow>(sql`
    SELECT event_id, org_id, aggregate_id, event_type, actor_id, data, occurred_at
    FROM event_outbox
    WHERE published_at IS NULL
    ORDER BY occurred_at
    LIMIT ${limit}`);
}

export async function markPublished(eventId: string) {
  await asDrainer(sql`
    UPDATE event_outbox
    SET published_at = now(), publish_attempts = publish_attempts + 1
    WHERE event_id = ${eventId}::uuid`);
}

export async function markPublishFailed(eventId: string, error: string) {
  await asDrainer(sql`
    UPDATE event_outbox
    SET publish_attempts = publish_attempts + 1, last_error = ${error}
    WHERE event_id = ${eventId}::uuid`);
}

export function toEnvelope(row: OutboxRow) {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    orgId: row.org_id,
    aggregateId: row.aggregate_id,
    actorId: row.actor_id,
    version: 1,
    data: row.data,
  };
}
