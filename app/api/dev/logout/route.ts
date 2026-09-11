import { NextResponse } from "next/server";
import { cookies } from "next/headers";

/**
 * DEV/TEST-ONLY logout stub.
 * Disabled in production. Clears the legacy actor_id cookie used by tests.
 */
export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }
  const jar = await cookies();
  jar.delete("actor_id");
  return NextResponse.json({ ok: true });
}
