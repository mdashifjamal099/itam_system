import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Suspense } from "react";
import { LoginForm } from "@/components/LoginForm";
import { ActorPicker } from "@/components/ActorPicker";

/**
 * /login — the single entry point for unauthenticated users.
 *
 * Two panels:
 *   1. Real email + password sign-in (Auth.js credentials → signed JWT).
 *   2. A dev-only quick sign-in switcher, rendered ONLY when NODE_ENV is not
 *      production. It posts to /api/dev/login, which is itself disabled in
 *      production, so this panel cannot appear or function in a real deploy.
 */

async function loadDevActors() {
  if (process.env.NODE_ENV === "production") return [];
  try {
    const text = await readFile(join(process.cwd(), ".dev-actors.json"), "utf8");
    return JSON.parse(text);
  } catch {
    return [];
  }
}

export default async function LoginPage() {
  const devActors = await loadDevActors();

  return (
    <div style={{ width: "100%", maxWidth: 400 }}>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: "var(--accent)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            margin: "0 auto 12px",
          }}
        >
          IT
        </div>
        <h2 style={{ marginBottom: 4 }}>ITAM Platform</h2>
        <p className="hint-text">Sign in to manage your asset fleet</p>
      </div>

      <div className="card">
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>

      {devActors.length > 0 && (
        <>
          <p
            className="hint-text"
            style={{ textAlign: "center", margin: "18px 0 10px", fontSize: 11, letterSpacing: "0.04em" }}
          >
            — DEVELOPMENT QUICK SIGN-IN —
          </p>
          <ActorPicker actors={devActors} />
        </>
      )}
    </div>
  );
}
