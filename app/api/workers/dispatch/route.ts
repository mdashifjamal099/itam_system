import { NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { runIntegration, sendNotification, mdmRemoteWipe } from "@/lib/integrations";
import type { Envelope } from "@/lib/qstash";

export const maxDuration = 30;

const CONSUMER = "dispatch";

async function recipientFor(orgId: string, userId: string) {
  const rows = await withTenant<{ full_name: string; email: string }>(
    orgId,
    sql`SELECT full_name, email FROM app_user WHERE id = ${userId}::uuid`,
  );
  return rows[0];
}

async function assetFor(orgId: string, assetId: string) {
  const rows = await withTenant<{ asset_tag: string; model: string; serial_number: string }>(
    orgId,
    sql`SELECT asset_tag, model, serial_number FROM asset WHERE id = ${assetId}::uuid`,
  );
  return rows[0];
}

async function handle(evt: Envelope) {
  const { orgId, eventId, data } = evt;
  const assetId = data.assetId as string | undefined;

  switch (evt.eventType) {
    case "asset.assigned": {
      const user = await recipientFor(orgId, data.toUserId as string);
      const asset = assetId ? await assetFor(orgId, assetId) : undefined;
      if (!user) break;
      await runIntegration(orgId, eventId, "email", (key) =>
        sendNotification({
          to: user.email,
          subject: `Action required: accept custody of ${asset?.asset_tag ?? "an asset"}`,
          body: `${asset?.model ?? "An asset"} has been assigned to you. Enter the OTP you received to accept custody. This request expires at ${data.expiresAt}.`,
          idempotencyKey: key,
        }),
      );
      break;
    }

    case "custody.accepted": {
      const user = await recipientFor(orgId, data.userId as string);
      const asset = assetId ? await assetFor(orgId, assetId) : undefined;
      if (!user) break;
      await runIntegration(orgId, eventId, "email", (key) =>
        sendNotification({
          to: user.email,
          subject: `Custody confirmed: ${asset?.asset_tag ?? "asset"}`,
          body: `You accepted custody of ${asset?.model ?? "an asset"}. You are responsible for it until it is returned.`,
          idempotencyKey: key,
        }),
      );
      break;
    }

    case "asset.overdue": {
      const user = await recipientFor(orgId, data.userId as string);
      const asset = assetId ? await assetFor(orgId, assetId) : undefined;
      if (!user) break;
      await runIntegration(orgId, eventId, "email", (key) =>
        sendNotification({
          to: user.email,
          subject: `Overdue: please return ${asset?.asset_tag ?? "your asset"}`,
          body: `You have held this asset since ${data.heldSince} which exceeds the ${data.limitDays}-day policy limit.`,
          idempotencyKey: key,
        }),
      );
      break;
    }

    case "asset.lost": {
      const asset = assetId ? await assetFor(orgId, assetId) : undefined;
      // Telemetry/security action, not a state change — the FSM already moved
      // the asset to LOST before this event was ever published.
      if (asset) {
        await runIntegration(orgId, eventId, "mdm", (key) =>
          mdmRemoteWipe({ serialNumber: asset.serial_number, idempotencyKey: key }),
        );
      }
      break;
    }

    case "asset.warranty_expiring": {
      await runIntegration(orgId, eventId, "email", (key) =>
        sendNotification({
          to: "procurement@example.test",
          subject: `Warranty expiring: ${data.assetTag}`,
          body: `Warranty lapses on ${data.warrantyExpiry}.`,
          idempotencyKey: key,
        }),
      );
      break;
    }

    case "employee.offboarding": {
      const user = await recipientFor(orgId, data.userId as string);
      const assets = (data.assetsToRecover as string[]) ?? [];
      if (!user) break;
      await runIntegration(orgId, eventId, "email", (key) =>
        sendNotification({
          to: user.email,
          subject: `Return ${assets.length} asset(s) before your last day`,
          body: `Last working day: ${data.lastWorkingDay}. Outstanding assets: ${assets.length}.`,
          idempotencyKey: key,
        }),
      );
      break;
    }

    // Recorded for the audit trail; no external side effect.
    case "asset.returned":
    case "asset.inspected":
    case "maintenance.logged":
    case "asset.recovered":
    case "custody.handshake_expired":
    case "asset.intake":
      break;

    default:
      console.log(`[dispatch] no handler for ${evt.eventType}`);
  }
}

async function handler(req: Request) {
  const evt = (await req.json()) as Envelope;

  // QStash delivers at least once. Claim the event for this consumer first;
  // a redelivery that loses the race is a no-op.
  const claim = await sql`
    INSERT INTO processed_event (event_id, consumer)
    VALUES (${evt.eventId}::uuid, ${CONSUMER})
    ON CONFLICT (event_id, consumer) DO NOTHING
    RETURNING event_id`;

  if (claim.length === 0) {
    return NextResponse.json({ status: "duplicate_ignored", eventId: evt.eventId });
  }

  try {
    await handle(evt);
  } catch (err) {
    // Release the claim so QStash's retry can genuinely reprocess. Side effects
    // already completed stay deduped by integration_attempt, not by this row.
    await sql`DELETE FROM processed_event
              WHERE event_id = ${evt.eventId}::uuid AND consumer = ${CONSUMER}`;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dispatch] ${evt.eventType} failed:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ status: "processed", eventId: evt.eventId });
}

// Signature verification is mandatory once QStash is configured. Without a
// signing key (local development) only same-process dispatch is accepted.
export const POST = process.env.QSTASH_CURRENT_SIGNING_KEY
  ? verifySignatureAppRouter(handler)
  : handler;
