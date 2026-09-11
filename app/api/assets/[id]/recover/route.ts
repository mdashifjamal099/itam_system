import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: assetId } = await ctx.params;
  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");
    const { notes } = await req.json().catch(() => ({ notes: null }));

    const rows = await withTenant<{ result: Record<string, unknown> }>(
      actor.org_id,
      sql`SELECT fn_recover_lost(${assetId}::uuid, ${actor.id}::uuid, ${notes ?? null}) AS result`,
    );

    return NextResponse.json(rows[0].result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
