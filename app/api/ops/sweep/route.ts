import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

const SWEEPS = {
  overdue: (org: string) => sql`SELECT fn_sweep_overdue(${org}::uuid) AS result`,
  warranty: (org: string) => sql`SELECT fn_sweep_warranty(${org}::uuid) AS result`,
} as const;

/** Manual, org-scoped trigger for the same sweeps the cron routes run for every tenant. */
export async function POST(req: NextRequest) {
  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");
    const { kind } = (await req.json()) as { kind?: string };

    if (kind !== "overdue" && kind !== "warranty") {
      return NextResponse.json({ error: "kind must be 'overdue' or 'warranty'" }, { status: 400 });
    }

    const rows = await withTenant<{ result: Record<string, unknown> }>(
      actor.org_id,
      SWEEPS[kind](actor.org_id),
    );
    return NextResponse.json(rows[0].result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
