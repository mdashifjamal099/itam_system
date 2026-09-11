import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

export async function GET() {
  try {
    const actor = requireRole(await getActor(), "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN");
    const rows = await withTenant<{ result: Record<string, unknown> }>(
      actor.org_id,
      sql`SELECT fn_org_kpis(${actor.org_id}::uuid) AS result`,
    );
    return NextResponse.json(rows[0].result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
