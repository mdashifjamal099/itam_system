import { NextResponse } from "next/server";
import { ForbiddenError } from "./auth";

export function toErrorResponse(err: unknown) {
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  const msg = err instanceof Error ? err.message : String(err);

  // Errors raised by the FSM functions map onto HTTP semantics.
  if (msg.includes("Illegal transition")) {
    return NextResponse.json({ error: msg }, { status: 409 });
  }
  if (msg.includes("not found")) {
    return NextResponse.json({ error: msg }, { status: 404 });
  }
  if (msg.includes("append-only")) {
    return NextResponse.json({ error: msg }, { status: 403 });
  }

  console.error(err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
