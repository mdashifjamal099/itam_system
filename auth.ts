/**
 * Auth.js v5 (NextAuth) configuration.
 *
 * Authentication flow:
 *   1. User submits email + password on /login.
 *   2. CredentialsProvider.authorize() looks up the user via the existing
 *      two-step tenant resolution in lib/auth.ts (user_lookup → app_user
 *      under RLS). This is the same path getActor() already walks, so
 *      the same tenant isolation and RBAC apply from the very first query.
 *   3. bcrypt.compare() checks the submitted password against the stored
 *      password_hash. On mismatch, authorize() returns null (Auth.js
 *      converts this to a CredentialsSignin error — never 500).
 *   4. On success, authorize() returns a minimal user object. Auth.js
 *      signs this into a JWT stored in an httpOnly, sameSite=lax cookie.
 *      The JWT contains only: id, org_id, role. Full name / email are
 *      re-fetched from Postgres on each request in getActor() — this
 *      keeps the session lean and ensures terminated-user revocation works
 *      without waiting for token expiry.
 *   5. getActor() in lib/auth.ts calls auth() (this file's exported
 *      function) instead of reading the bare actor_id cookie.
 *
 * Security properties:
 *   - Passwords are NEVER stored in plaintext; only bcrypt hashes (cost 12).
 *   - The JWT is signed with NEXTAUTH_SECRET (HS256 by default in Auth.js v5).
 *   - Session expiry is enforced: maxAge is 8 hours; the JWT exp claim is
 *     validated on every request before Postgres is hit.
 *   - The session object exposed to the client contains only { id, role } —
 *     no org_id, no email, no full_name, no hash.
 *   - An attacker who tampers with the cookie value gets a JWT verification
 *     failure (401/redirect), not a different user's session.
 */

import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import type { Role } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Module augmentation so TypeScript knows about our extra fields on session/JWT
// ---------------------------------------------------------------------------
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
    } & DefaultSession["user"];
  }
  interface User {
    id: string;
    role: Role;
    org_id: string;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
    role: Role;
    org_id: string;
  }
}

// ---------------------------------------------------------------------------
// Auth.js configuration
// ---------------------------------------------------------------------------
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },

      // Every rejection path returns a bare null: Auth.js turns that into a
      // generic CredentialsSignin error, so the client cannot distinguish
      // "no such email" from "wrong password" from "terminated user" and
      // cannot use this endpoint to enumerate accounts. Nothing is logged
      // here either — failed-login details include the submitted email and
      // belong in structured audit logging, not application stdout.
      async authorize(credentials) {
        const email = (credentials?.email as string | undefined)?.trim().toLowerCase();
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        // Step 1: find the org_id bypassing RLS using the securely defined function.
        const lookup = (await sql`
          SELECT id, org_id
          FROM fn_auth_resolve_email(${email})
          LIMIT 1
        `) as { id: string; org_id: string }[];
        if (lookup.length === 0) return null;

        const { id, org_id } = lookup[0];

        // Step 2: fetch password_hash under the correct tenant RLS context.
        const rows = await withTenant<{
          id: string;
          role: Role;
          password_hash: string | null;
          employment_status: string;
        }>(
          org_id,
          sql`SELECT id, role, password_hash, employment_status
              FROM app_user
              WHERE id = ${id}::uuid`,
        );

        const user = rows[0];
        if (!user) return null;

        if (user.employment_status !== "ACTIVE") return null;

        if (!user.password_hash) return null;

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return null;

        return { id: user.id, role: user.role, org_id };
      },
    }),
  ],

  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60, // 8 hours
  },

  callbacks: {
    // Persist id, role, org_id into the JWT on first sign-in.
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.org_id = user.org_id;
      }
      return token;
    },

    // Expose only id and role to session.user — org_id stays server-side.
    async session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      return session;
    },
  },

  pages: {
    signIn: "/login",
  },

  // Silence the Auth.js URL warning in test environments where NEXTAUTH_URL
  // may not be set to a reachable public URL.
  ...(process.env.NODE_ENV === "test" && { trustHost: true }),
});
