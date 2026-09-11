import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

export async function GET() {
  try {
    const actor = requireRole(await getActor(), "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN");
    const rows = await withTenant(
      actor.org_id,
      sql`SELECT rt.id, rt.reason, rt.status, rt.due_date, rt.reminders,
                 a.asset_tag, a.model, u.full_name AS holder_name
          FROM recovery_task rt
          JOIN asset a ON a.id = rt.asset_id
          JOIN app_user u ON u.id = rt.user_id
          WHERE rt.status <> 'RESOLVED'
          ORDER BY rt.due_date NULLS LAST, rt.created_at`,
    );
    return NextResponse.json({ tasks: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}
