import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { generateOtp, hashOtp } from "@/lib/otp";
import { toErrorResponse } from "@/lib/http";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: assetId } = await ctx.params;

  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");
    const { toUserId, photoUrl } = await req.json();
    if (!toUserId) {
      return NextResponse.json({ error: "toUserId is required" }, { status: 400 });
    }
    if (photoUrl && (typeof photoUrl !== "string" || photoUrl.length > 2_000_000)) {
      return NextResponse.json({ error: "Photo is too large" }, { status: 400 });
    }

    const otp = generateOtp();

    // One transaction: tenant context + the whole domain operation. The stored
    // function writes the projection, the state event, the audit row and the
    // outbox row together, then commits.
    const rows = await withTenant<{ result: Record<string, unknown> }>(
      actor.org_id,
      sql`SELECT fn_checkout_asset(
            ${assetId}::uuid, ${toUserId}::uuid, ${actor.id}::uuid, ${hashOtp(otp)}, 1440,
            ${photoUrl ?? null}
          ) AS result`,
    );

    // Delivered by the notification worker once a broker is wired up. Returned
    // here only because v1 has no email provider.
    return NextResponse.json({ ...rows[0].result, devOtp: otp });
  } catch (err) {
    return toErrorResponse(err);
  }
}
