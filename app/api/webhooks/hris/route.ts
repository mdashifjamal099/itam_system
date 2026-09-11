import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { toErrorResponse } from "@/lib/http";

export const maxDuration = 30;

/**
 * Inbound HRIS webhook (Workday / BambooHR shape).
 *
 * Verified by HMAC over the raw body — the raw bytes matter, so the body is
 * read as text and only parsed after the signature checks out. Payloads
 * identify the employee by employee_id (the HRIS's key), never by our uuid,
 * which is also how the tenant is resolved.
 */
function verifySignature(raw: string, header: string | null): boolean {
  const secret = process.env.HRIS_WEBHOOK_SECRET;
  if (!secret || !header) return false;

  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header.replace(/^sha256=/, ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (!process.env.HRIS_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "HRIS_WEBHOOK_SECRET not configured" }, { status: 503 });
  }
  if (!verifySignature(raw, req.headers.get("x-hris-signature"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const payload = JSON.parse(raw) as {
      event: string;
      orgId: string;
      employeeId: string;
      lastWorkingDay?: string;
    };

    if (payload.event !== "employee.terminated") {
      return NextResponse.json({ status: "ignored", event: payload.event });
    }

    const users = await withTenant<{ id: string }>(
      payload.orgId,
      sql`SELECT id FROM app_user WHERE employee_id = ${payload.employeeId}`,
    );
    if (users.length === 0) {
      return NextResponse.json({ error: "Unknown employee" }, { status: 404 });
    }

    // Offboarding creates recovery obligations; it deliberately does NOT force
    // asset state. HR saying someone left does not put the laptop on a desk.
    const rows = await withTenant<{ result: Record<string, unknown> }>(
      payload.orgId,
      sql`SELECT fn_offboard_user(
            ${users[0].id}::uuid, NULL, ${payload.lastWorkingDay ?? null}::date
          ) AS result`,
    );

    return NextResponse.json(rows[0].result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
