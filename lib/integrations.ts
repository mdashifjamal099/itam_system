import { sql } from "./db";
import { withTenant } from "./tenant";

export type IntegrationName = "email" | "mdm" | "hris";

type Outcome = { externalRef?: string };

/**
 * Runs an external side effect exactly once across redeliveries.
 *
 * processed_event alone is not enough here. A worker can call the third party
 * and then crash before recording completion; on redelivery processed_event
 * would say "never processed" and the email goes out twice. So each external
 * call gets its own durable row, transitioned PENDING -> SUCCEEDED/FAILED, and
 * carries an idempotency key the remote side can also dedupe on.
 */
export async function runIntegration(
  orgId: string,
  eventId: string,
  integration: IntegrationName,
  fn: (idempotencyKey: string) => Promise<Outcome>,
): Promise<"succeeded" | "skipped" | "failed"> {
  const idempotencyKey = `${eventId}:${integration}`;

  const claimed = await withTenant<{ status: string }>(
    orgId,
    sql`INSERT INTO integration_attempt (org_id, event_id, integration, idempotency_key, status, attempts)
        VALUES (${orgId}::uuid, ${eventId}::uuid, ${integration}, ${idempotencyKey}, 'PENDING', 1)
        ON CONFLICT (event_id, integration) DO UPDATE
          SET attempts = integration_attempt.attempts + 1, updated_at = now()
        RETURNING status`,
  );

  // A previous delivery already completed this side effect.
  if (claimed[0]?.status === "SUCCEEDED") return "skipped";

  try {
    const { externalRef } = await fn(idempotencyKey);
    await withTenant(
      orgId,
      sql`UPDATE integration_attempt
          SET status = 'SUCCEEDED', external_ref = ${externalRef ?? null},
              last_error = NULL, updated_at = now()
          WHERE event_id = ${eventId}::uuid AND integration = ${integration}`,
    );
    return "succeeded";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenant(
      orgId,
      sql`UPDATE integration_attempt
          SET status = 'FAILED', last_error = ${message}, updated_at = now()
          WHERE event_id = ${eventId}::uuid AND integration = ${integration}`,
    );
    throw err;
  }
}

/**
 * Stand-in for a real provider (SendGrid/Twilio). Logs instead of sending.
 * The surrounding durability machinery is real; only the transport is stubbed.
 */
export async function sendNotification(input: {
  to: string;
  subject: string;
  body: string;
  idempotencyKey: string;
}): Promise<Outcome> {
  console.log(
    `[email] to=${input.to} key=${input.idempotencyKey}\n        ${input.subject}\n        ${input.body}`,
  );
  return { externalRef: `stub-${input.idempotencyKey}` };
}

/** Stand-in for Jamf/Intune remote lock-or-wipe. */
export async function mdmRemoteWipe(input: {
  serialNumber: string;
  idempotencyKey: string;
}): Promise<Outcome> {
  console.log(`[mdm] remote wipe requested serial=${input.serialNumber} key=${input.idempotencyKey}`);
  return { externalRef: `stub-wipe-${input.idempotencyKey}` };
}
