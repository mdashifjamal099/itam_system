import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: assetId } = await ctx.params;
  try {
    const actor = requireRole(await getActor(), "EMPLOYEE", "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN");
    const { notes } = await req.json().catch(() => ({ notes: null }));

    // An employee may only declare loss of something they actually hold.
    if (actor.role === "EMPLOYEE") {
      const owned = await withTenant(
        actor.org_id,
        sql`SELECT 1 FROM asset
            WHERE id = ${assetId}::uuid AND current_holder_id = ${actor.id}::uuid`,
      );
      if (owned.length === 0) {
        return NextResponse.json({ error: "You do not hold this asset" }, { status: 403 });
      }
    }

    const rows = await withTenant<{ result: Record<string, unknown> }>(
      actor.org_id,
      sql`SELECT fn_declare_lost(${assetId}::uuid, ${actor.id}::uuid, ${notes ?? null}) AS result`,
    );

    return NextResponse.json(rows[0].result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
