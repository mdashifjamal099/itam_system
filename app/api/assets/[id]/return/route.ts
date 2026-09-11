import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: assetId } = await ctx.params;
  try {
    const actor = requireRole(await getActor(), "EMPLOYEE", "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN");

    // Return has no required fields, so an empty body (older ActionButton
    // callers, curl with no -d) must not fail the JSON parse.
    const body = await req.json().catch(() => ({}));
    const photoUrl = (body as { photoUrl?: string }).photoUrl;
    if (photoUrl && (typeof photoUrl !== "string" || photoUrl.length > 2_000_000)) {
      return NextResponse.json({ error: "Photo is too large" }, { status: 400 });
    }

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
      sql`SELECT fn_return_asset(${assetId}::uuid, ${actor.id}::uuid, ${photoUrl ?? null}) AS result`,
    );

    return NextResponse.json(rows[0].result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
