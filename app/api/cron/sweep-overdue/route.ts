import { NextResponse } from "next/server";
import { protectedCron } from "@/lib/cron";
import { sql } from "@/lib/db";
import { allOrgIds, withTenant } from "@/lib/tenant";

export const maxDuration = 60;

export const POST = protectedCron(async () => {
  const orgs = await allOrgIds();
  let overdue = 0;
  let tasks = 0;

  for (const orgId of orgs) {
    const rows = await withTenant<{ result: { overdue: number; tasks: number } }>(
      orgId,
      sql`SELECT fn_sweep_overdue(${orgId}::uuid) AS result`,
    );
    overdue += rows[0]?.result.overdue ?? 0;
    tasks += rows[0]?.result.tasks ?? 0;
  }

  return NextResponse.json({ orgs: orgs.length, overdue, tasks });
});
