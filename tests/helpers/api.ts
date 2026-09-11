/** Thin fetch wrapper against the spawned test server — real HTTP, real cookies. */

export function apiBase() {
  return process.env.APP_URL ?? `http://localhost:${process.env.TEST_PORT ?? "3100"}`;
}

export type ApiResult<T = Record<string, unknown>> = {
  status: number;
  body: T;
  raw: Response;
};

export async function api<T = Record<string, unknown>>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    /** Pre-serialized body sent verbatim — required for HMAC-signed requests,
     *  where the signature is computed over exact raw bytes and JSON.stringify
     *  would silently re-encode (and invalidate) a string passed as `body`. */
    rawBody?: string;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResult<T>> {
  const hasBody = opts.body !== undefined || opts.rawBody !== undefined;
  const res = await fetch(`${apiBase()}${path}`, {
    method: opts.method ?? (hasBody ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { status: res.status, body: body as T, raw: res };
}

/**
 * LEGACY dev-only login helper. Posts to /api/dev/login (the unsigned cookie
 * stub, still alive in dev/test but disabled in production). All existing
 * tests use this — it continues to work so no test rewrites are needed for
 * the existing suite.
 *
 * New tests should prefer loginAsEmail() which exercises the real Auth.js
 * credentials flow.
 */
export async function loginAs(actorId: string): Promise<string> {
  const res = await fetch(`${apiBase()}/api/dev/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId }),
  });
  if (!res.ok) {
    throw new Error(`login failed for ${actorId}: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not set a cookie");
  return setCookie.split(";")[0];
}

/**
 * Real email+password login via the Auth.js credentials endpoint.
 * Returns the session cookie string to pass as `cookie:` on subsequent calls.
 *
 * This is the correct login helper for tests that verify auth behaviour
 * (wrong password, impersonation, session expiry, etc.).
 */
export async function loginAsEmail(
  email: string,
  password: string,
): Promise<{ cookie: string; ok: boolean; status: number }> {
  // Auth.js v5 credentials flow:
  //   1. GET /api/auth/csrf  →  { csrfToken }
  //   2. POST /api/auth/callback/credentials  →  redirect on success
  const csrfRes = await fetch(`${apiBase()}/api/auth/csrf`);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const csrfCookies = csrfRes.headers.get("set-cookie") ?? "";

  const body = new URLSearchParams({
    csrfToken,
    email,
    password,
    redirect: "false",
    json: "true",
  });

  const loginRes = await fetch(`${apiBase()}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: csrfCookies,
    },
    body: body.toString(),
    redirect: "manual",
  });

  // Collect all Set-Cookie headers into one cookie string.
  const setCookieHeaders = loginRes.headers.getSetCookie?.() ?? [];
  const sessionCookies = setCookieHeaders
    .map((h) => h.split(";")[0])
    .filter((c) => c.includes("="))
    .join("; ");

  const allCookies = [csrfCookies.split(";")[0], sessionCookies].filter(Boolean).join("; ");

  // 200 or 302→/ means success; 302→/login or 401 means failure.
  const ok =
    loginRes.status === 200 ||
    (loginRes.status === 302 && !loginRes.headers.get("location")?.includes("/login"));

  if (!ok) {
    console.log("loginAsEmail failed:", loginRes.status, loginRes.headers.get("location"));
    const text = await loginRes.text();
    console.log("Response body:", text);
  }

  return { cookie: allCookies, ok, status: loginRes.status };
}
