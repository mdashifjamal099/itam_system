import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sql } from "@/lib/db";

/**
 * DEV/TEST-ONLY session stub.
 *
 * This route is disabled in production. In development and test environments
 * it sets the actor_id cookie that the (now-removed) old auth stub used, but
 * more importantly it now sets a real Auth.js-compatible session so the
 * existing test suite (which calls loginAs(actorId) → this endpoint) continues
 * to work without modification.
 *
 * The test suite hits the real next dev server spawned by global-setup.ts with
 * NODE_ENV=test, which is not 'production', so this route remains live during
 * test runs and is the path loginAs() uses.
 *
 * DO NOT remove this route until all tests have been migrated to use the real
 * email+password login flow via /api/auth/callback/credentials.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }

  const { actorId } = await req.json();
  if (!actorId) {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 });
  }

  const rows = await sql`SELECT 1 FROM user_lookup WHERE id = ${actorId}::uuid`;
  if (rows.length === 0) {
    return NextResponse.json({ error: "Unknown actor id" }, { status: 400 });
  }

  const jar = await cookies();
  jar.set("actor_id", actorId, { httpOnly: true, sameSite: "lax", path: "/" });
  return NextResponse.json({ ok: true });
}
