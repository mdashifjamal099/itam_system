import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole, type Role } from "@/lib/auth";
import { generateTempPassword, hashPassword } from "@/lib/password";
import { toErrorResponse } from "@/lib/http";

const ROLES: Role[] = ["EMPLOYEE", "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN"];
const ADMIN_TIER: Role[] = ["ASSET_ADMIN", "SUPER_ADMIN"];

export async function GET() {
  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");
    const users = await withTenant(
      actor.org_id,
      sql`SELECT id, employee_id, full_name, email, department, role, employment_status
          FROM app_user
          WHERE org_id = ${actor.org_id}::uuid
          ORDER BY full_name`,
    );
    return NextResponse.json({ users });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");
    const { fullName, email, department, role } = (await req.json()) as {
      fullName?: string;
      email?: string;
      department?: string;
      role?: string;
    };

    if (!fullName || !email || !role) {
      return NextResponse.json({ error: "fullName, email, and role are required" }, { status: 400 });
    }
    if (!ROLES.includes(role as Role)) {
      return NextResponse.json({ error: `role must be one of ${ROLES.join(", ")}` }, { status: 400 });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
    }
    // Only SUPER_ADMIN may create another admin-tier account. Without this, any
    // ASSET_ADMIN could mint themselves (or an accomplice) a SUPER_ADMIN
    // account — the two tiers would be permission-equal in practice, which
    // defeats the point of having a higher tier at all.
    if (ADMIN_TIER.includes(role as Role) && actor.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { error: "Only a SUPER_ADMIN can create an ASSET_ADMIN or SUPER_ADMIN account" },
        { status: 403 },
      );
    }

    const employeeId = `E-${randomBytes(4).toString("hex")}`;
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    const rows = await withTenant<{ result: { ok: boolean; id: string } }>(
      actor.org_id,
      sql`SELECT fn_create_user(
            ${actor.org_id}::uuid, ${actor.id}::uuid, ${employeeId}, ${fullName},
            ${email}, ${department ?? null}, ${role}::user_role, ${passwordHash}
          ) AS result`,
    );

    return NextResponse.json({ ...rows[0].result, employeeId, tempPassword });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("duplicate key") || message.includes("uq_app_user_email_ci")) {
      return NextResponse.json({ error: "A user with this email already exists" }, { status: 409 });
    }
    return toErrorResponse(err);
  }
}
