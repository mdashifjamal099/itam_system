import { NextResponse } from "next/server";
import { protectedCron } from "@/lib/cron";
import { sql } from "@/lib/db";
import { allOrgIds, withTenant } from "@/lib/tenant";

export const maxDuration = 60;

/**
 * Recomputes the audit hash chain and reports any row whose stored hash no
 * longer matches. A non-empty result means the append-only guarantee was
 * circumvented at the database level and is a compliance incident, not a bug
 * to shrug at — the response is deliberately loud.
 */
export const POST = protectedCron(async () => {
  const orgs = await allOrgIds();
  const broken: { orgId: string; entityType: string; entityId: string; brokenAt: string }[] = [];

  for (const orgId of orgs) {
    const rows = await withTenant<{
      entity_type: string;
      entity_id: string;
      broken_at: string;
    }>(orgId, sql`SELECT * FROM fn_verify_audit_chain(${orgId}::uuid)`);

    for (const r of rows) {
      broken.push({
        orgId,
        entityType: r.entity_type,
        entityId: r.entity_id,
        brokenAt: r.broken_at,
      });
    }
  }

  if (broken.length > 0) {
    console.error("[audit] HASH CHAIN BROKEN", JSON.stringify(broken));
  }

  return NextResponse.json(
    { orgs: orgs.length, intact: broken.length === 0, broken },
    { status: broken.length === 0 ? 200 : 500 },
  );
});
