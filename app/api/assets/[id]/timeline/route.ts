import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, hasRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: assetId } = await ctx.params;
  const at = req.nextUrl.searchParams.get("at");

  try {
    const actor = await getActor();
    if (!hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN", "MANAGER")) {
      return NextResponse.json({ error: "Audit timeline requires manager or admin" }, { status: 403 });
    }

    // "Who held this asset on 2025-03-15, and what state was it in?"
    if (at) {
      const holder = await withTenant(
        actor!.org_id,
        sql`SELECT * FROM fn_holder_at(${assetId}::uuid, ${at}::timestamptz)`,
      );
      const state = await withTenant(
        actor!.org_id,
        sql`SELECT to_state, event_type, occurred_at
            FROM asset_state_event
            WHERE asset_id = ${assetId}::uuid AND occurred_at <= ${at}::timestamptz
            ORDER BY occurred_at DESC LIMIT 1`,
      );
      return NextResponse.json({
        at,
        stateAtTime: state[0]?.to_state ?? null,
        holder: holder[0] ?? null,
      });
    }

    const events = await withTenant(
      actor!.org_id,
      sql`SELECT e.event_id, e.asset_version, e.from_state, e.to_state, e.event_type,
                 e.payload, e.occurred_at, u.full_name AS actor_name
          FROM asset_state_event e
          LEFT JOIN app_user u ON u.id = e.actor_id
          WHERE e.asset_id = ${assetId}::uuid
          ORDER BY e.asset_version DESC`,
    );

    const holdings = await withTenant(
      actor!.org_id,
      sql`SELECT hp.start_ts, hp.end_ts, u.full_name,
                 ROUND(EXTRACT(epoch FROM (COALESCE(hp.end_ts, now()) - hp.start_ts)) / 86400.0, 2) AS days
          FROM holding_period hp
          JOIN app_user u ON u.id = hp.user_id
          WHERE hp.asset_id = ${assetId}::uuid
          ORDER BY hp.start_ts DESC`,
    );

    return NextResponse.json({ events, holdings });
  } catch (err) {
    return toErrorResponse(err);
  }
}
