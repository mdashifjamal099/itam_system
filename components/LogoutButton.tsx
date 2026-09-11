"use client";

import { signOut } from "next-auth/react";

/**
 * Signs the user out of BOTH session mechanisms.
 *
 * A dev session (actor_id cookie) and a real Auth.js session can exist at the
 * same time — getActor() prefers the Auth.js session, so clearing only one
 * would silently leave the user signed in via the other. Clearing the dev
 * cookie first, then calling signOut(), guarantees the redirect to /login
 * actually lands on a signed-out state.
 */
export function LogoutButton() {
  return (
    <button
      className="btn block"
      onClick={async () => {
        // Never fails the sign-out: the route 404s in production by design.
        await fetch("/api/dev/logout", { method: "POST" }).catch(() => {});
        await signOut({ callbackUrl: "/login" });
      }}
    >
      Sign out
    </button>
  );
}
