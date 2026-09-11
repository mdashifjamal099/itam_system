import { NextResponse, type NextRequest } from "next/server";

/**
 * Central page gate.
 *
 * Scope is deliberately limited to PAGE routes. API routes are intentionally
 * NOT matched here:
 *   - they already enforce auth+RBAC per-route via getActor()/requireRole(),
 *     which returns correct 401/403 JSON rather than an HTML redirect;
 *   - redirecting an API call to /login would turn a clean 403 into a 200 HTML
 *     response and break every API client (and the test suite).
 *
 * This middleware only answers "is there any session at all" — it deliberately
 * does NOT check roles. Role checks need the database (the JWT carries a role,
 * but roles can change mid-session, and the DB is the source of truth), and
 * middleware runs before that. Per-route requireRole() remains the authority.
 */

const PUBLIC_PAGES = ["/login"];

// Cookie names Auth.js uses for the session JWT (the __Secure- prefix appears
// when the cookie is issued over HTTPS).
const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

function hasSession(req: NextRequest): boolean {
  if (SESSION_COOKIES.some((name) => req.cookies.get(name))) return true;

  // Dev/test-only actor switcher cookie. Never accepted in production — this
  // mirrors the same guard in lib/auth.ts so the two cannot drift apart.
  if (process.env.NODE_ENV !== "production" && req.cookies.get("actor_id")) return true;

  return false;
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (PUBLIC_PAGES.includes(pathname)) return NextResponse.next();
  if (hasSession(req)) return NextResponse.next();

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("callbackUrl", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except API routes, Next internals, and static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
