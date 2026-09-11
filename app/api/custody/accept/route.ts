import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor } from "@/lib/auth";
import { hashOtp } from "@/lib/otp";
import { toErrorResponse } from "@/lib/http";

export async function POST(req: NextRequest) {
  try {
    const actor = await getActor();
    if (!actor) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const { handshakeId, otp } = await req.json();
    if (!handshakeId || !otp) {
      return NextResponse.json({ error: "handshakeId and otp are required" }, { status: 400 });
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    const rows = await withTenant<{ result: { ok: boolean; reason?: string } }>(
      actor.org_id,
      sql`SELECT fn_accept_custody(
            ${handshakeId}::uuid, ${actor.id}::uuid, ${hashOtp(otp)}, ${ip}
          ) AS result`,
    );

    const result = rows[0].result;
    if (!result.ok) {
      const status = result.reason === "NOT_RECIPIENT" ? 403 : 400;
      return NextResponse.json({ error: result.reason }, { status });
    }

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
