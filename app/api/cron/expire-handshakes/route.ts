import { NextResponse } from "next/server";
import { protectedCron } from "@/lib/cron";
import { sql } from "@/lib/db";
import { allOrgIds, withTenant } from "@/lib/tenant";

export const maxDuration = 60;

/**
 * Reverts assets stranded in PENDING_ACCEPTANCE past their OTP window.
 *
 * Iterates tenants explicitly rather than running one cross-tenant query: RLS
 * stays fully in force for the actual work, and only the organization list is
 * read under system context.
 */
export const POST = protectedCron(async () => {
  const orgs = await allOrgIds();
  let expired = 0;

  for (const orgId of orgs) {
    const rows = await withTenant<{ expired: number }>(
      orgId,
      sql`SELECT fn_expire_handshakes() AS expired`,
    );
    expired += Number(rows[0]?.expired ?? 0);
  }

  return NextResponse.json({ orgs: orgs.length, expired });
});
