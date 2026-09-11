import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

const CONDITIONS = ["GOOD", "MINOR_DAMAGE", "MAJOR_DAMAGE", "UNUSABLE"];

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: assetId } = await ctx.params;
  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");
    const { condition, notes } = await req.json();

    if (!CONDITIONS.includes(condition)) {
      return NextResponse.json(
        { error: `condition must be one of ${CONDITIONS.join(", ")}` },
        { status: 400 },
      );
    }

    const rows = await withTenant<{ result: Record<string, unknown> }>(
      actor.org_id,
      sql`SELECT fn_complete_inspection(
            ${assetId}::uuid, ${actor.id}::uuid, ${condition}::asset_condition, ${notes ?? null}
          ) AS result`,
    );

    return NextResponse.json(rows[0].result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
