import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole, type Role } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

const ROLES: Role[] = ["EMPLOYEE", "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN"];
const ADMIN_TIER: Role[] = ["ASSET_ADMIN", "SUPER_ADMIN"];

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: targetId } = await ctx.params;
  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");
    const { role, department, employmentStatus } = (await req.json()) as {
      role?: string;
      department?: string;
      employmentStatus?: string;
    };

    if (role && !ROLES.includes(role as Role)) {
      return NextResponse.json({ error: `role must be one of ${ROLES.join(", ")}` }, { status: 400 });
    }
    if (employmentStatus && !["ACTIVE", "TERMINATED"].includes(employmentStatus)) {
      return NextResponse.json({ error: "employmentStatus must be ACTIVE or TERMINATED" }, { status: 400 });
    }
    // A self-service admin cannot lock themselves out or demote themselves —
    // that would leave the org with no way to undo the change through the UI.
    if (targetId === actor.id && (employmentStatus === "TERMINATED" || (role && role !== actor.role))) {
      return NextResponse.json({ error: "You cannot change your own role or deactivate yourself" }, {
        status: 400,
      });
    }

    // An ASSET_ADMIN may fully manage EMPLOYEE/MANAGER accounts, but cannot
    // touch an admin-tier account in either direction: not the target's
    // CURRENT role (an ASSET_ADMIN could otherwise deactivate or demote
    // another admin) and not the REQUESTED role (an ASSET_ADMIN could
    // otherwise promote someone straight to SUPER_ADMIN). Only SUPER_ADMIN
    // may modify admin-tier accounts at all.
    if (actor.role !== "SUPER_ADMIN") {
      const target = await withTenant<{ role: Role }>(
        actor.org_id,
        sql`SELECT role FROM app_user WHERE id = ${targetId}::uuid AND org_id = ${actor.org_id}::uuid`,
      );
      if (target.length === 0) {
        return NextResponse.json({ error: "User not found in this organization" }, { status: 404 });
      }
      const targetIsAdminTier = ADMIN_TIER.includes(target[0].role);
      const requestingAdminTier = role ? ADMIN_TIER.includes(role as Role) : false;
      if (targetIsAdminTier || requestingAdminTier) {
        return NextResponse.json(
          { error: "Only a SUPER_ADMIN can modify an admin-tier account" },
          { status: 403 },
        );
      }
    }

    const rows = await withTenant<{ result: Record<string, unknown> }>(
      actor.org_id,
      sql`SELECT fn_update_user(
            ${actor.org_id}::uuid, ${actor.id}::uuid, ${targetId}::uuid,
            ${role ?? null}::user_role, ${department ?? null}, ${employmentStatus ?? null}
          ) AS result`,
    );

    return NextResponse.json(rows[0].result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
