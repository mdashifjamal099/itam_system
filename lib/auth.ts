/**
 * lib/auth.ts — actor resolution and RBAC helpers.
 *
 * getActor() resolves the currently authenticated user. It supports two modes:
 *
 *  1. Auth.js JWT session (production + new real-login flow):
 *     auth() verifies the signed JWT and extracts the user id. The full actor
 *     row is always re-fetched from Postgres under the correct RLS tenant
 *     context, so role/status changes take effect immediately without waiting
 *     for token expiry.
 *
 *  2. Legacy actor_id cookie (dev/test only):
 *     The unsigned cookie set by /api/dev/login is still accepted when
 *     NODE_ENV !== 'production'. This lets the existing test suite run
 *     unchanged while the email+password flow is wired in. Once all tests
 *     migrate to the real credentials flow, this branch can be deleted.
 *
 * Security properties:
 *   - In production, ONLY the signed Auth.js JWT is accepted.
 *   - A tampered JWT fails HS256 signature verification before Postgres is hit.
 *   - An expired token is rejected by Auth.js.
 *   - The actor row is always fetched fresh from Postgres under RLS. A
 *     terminated user's in-flight session is rejected immediately, without
 *     waiting for JWT expiry.
 *   - The session cookie is httpOnly, sameSite=lax (set by Auth.js).
 *
 * Downstream code (all API routes, layout.tsx) is unchanged — only this
 * function changed between the old stub and the real implementation.
 */

import { auth } from "@/auth";
import { cookies } from "next/headers";
import { withTenant } from "./tenant";
import { sql } from "./db";

export type Role = "EMPLOYEE" | "MANAGER" | "ASSET_ADMIN" | "SUPER_ADMIN";

export type Actor = {
  id: string;
  org_id: string;
  full_name: string;
  email: string;
  role: Role;
};

type ActorRow = Actor & { employment_status: string };

export async function getActor(): Promise<Actor | null> {
  // --- Path 1: Auth.js JWT session (real auth) ---
  try {
    const session = await auth();
    if (session?.user?.id) {
      return await resolveActorById(session.user.id);
    }
  } catch {
    // auth() throws in environments where NEXTAUTH_SECRET is not set.
    // Fall through to the legacy cookie path in dev/test.
  }

  // --- Path 2: Legacy unsigned cookie (dev/test only, never in production) ---
  if (process.env.NODE_ENV !== "production") {
    const jar = await cookies();
    const id = jar.get("actor_id")?.value;
    if (id) {
      return await resolveActorById(id);
    }
  }

  return null;
}

async function resolveActorById(id: string): Promise<Actor | null> {
  // Step 1: resolve org_id from the non-RLS routing table (same pattern as before).
  const routing = (await sql`
    SELECT org_id FROM user_lookup WHERE id = ${id}::uuid
  `) as { org_id: string }[];
  const orgId = routing[0]?.org_id;
  if (!orgId) return null;

  // Step 2: fetch the full actor row under the correct tenant RLS context.
  const rows = await withTenant<ActorRow>(
    orgId,
    sql`SELECT id, org_id, full_name, email, role, employment_status
        FROM app_user
        WHERE id = ${id}::uuid`,
  );
  const actor = rows[0];
  if (!actor || actor.employment_status !== "ACTIVE") return null;

  const { employment_status: _employmentStatus, ...safeActor } = actor;
  return safeActor;
}

export function hasRole(actor: Actor | null, ...allowed: Role[]): boolean {
  return !!actor && allowed.includes(actor.role);
}

export class ForbiddenError extends Error {}

export function requireRole(actor: Actor | null, ...allowed: Role[]): Actor {
  if (!actor) throw new ForbiddenError("Not authenticated");
  if (!allowed.includes(actor.role)) {
    throw new ForbiddenError(`Role ${actor.role} may not perform this action`);
  }
  return actor;
}
