import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

export async function GET() {
  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");
    const rows = await withTenant<{
      max_holding_days: number;
      warranty_alert_days: number;
      handshake_ttl_minutes: number;
    }>(
      actor.org_id,
      sql`SELECT (p).max_holding_days, (p).warranty_alert_days, (p).handshake_ttl_minutes
          FROM fn_org_policy(${actor.org_id}::uuid) AS p`,
    );
    return NextResponse.json(rows[0]);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");
    const { maxHoldingDays, warrantyAlertDays, handshakeTtlMinutes } = (await req.json()) as {
      maxHoldingDays?: number;
      warrantyAlertDays?: number;
      handshakeTtlMinutes?: number;
    };

    for (const [name, value] of [
      ["maxHoldingDays", maxHoldingDays],
      ["warrantyAlertDays", warrantyAlertDays],
      ["handshakeTtlMinutes", handshakeTtlMinutes],
    ] as const) {
      if (!Number.isInteger(value) || (value as number) <= 0) {
        return NextResponse.json({ error: `${name} must be a positive integer` }, { status: 400 });
      }
    }

    const rows = await withTenant<{ result: Record<string, unknown> }>(
      actor.org_id,
      sql`SELECT fn_update_org_policy(
            ${actor.org_id}::uuid, ${actor.id}::uuid,
            ${maxHoldingDays}, ${warrantyAlertDays}, ${handshakeTtlMinutes}
          ) AS result`,
    );

    return NextResponse.json(rows[0].result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
