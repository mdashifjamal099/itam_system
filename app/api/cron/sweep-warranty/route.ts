import { NextResponse } from "next/server";
import { protectedCron } from "@/lib/cron";
import { sql } from "@/lib/db";
import { allOrgIds, withTenant } from "@/lib/tenant";

export const maxDuration = 60;

export const POST = protectedCron(async () => {
  const orgs = await allOrgIds();
  let expiring = 0;

  for (const orgId of orgs) {
    const rows = await withTenant<{ result: { expiring: number } }>(
      orgId,
      sql`SELECT fn_sweep_warranty(${orgId}::uuid) AS result`,
    );
    expiring += rows[0]?.result.expiring ?? 0;
  }

  return NextResponse.json({ orgs: orgs.length, expiring });
});
