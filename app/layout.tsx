import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getActor, hasRole } from "@/lib/auth";
import { NavLinks } from "@/components/NavLinks";
import { LogoutButton } from "@/components/LogoutButton";

export const metadata: Metadata = {
  title: "ITAM Platform",
  description: "IT asset lifecycle tracking",
};

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();

  if (!actor) {
    return (
      <html lang="en" suppressHydrationWarning>
        <body>
          <div className="centered-shell">{children}</div>
        </body>
      </html>
    );
  }

  const isOps = hasRole(actor, "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN");
  const isAdmin = hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN");

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <div className="app-shell">
          <aside className="sidebar">
            <div className="sidebar-brand">
              <div className="mark">IT</div>
              <div>
                <div className="name">ITAM Platform</div>
                <div className="sub">Asset lifecycle</div>
              </div>
            </div>

            <NavLinks isOps={isOps} isAdmin={isAdmin} />

            <div className="sidebar-footer">
              <div className="user-chip" style={{ marginBottom: 10 }}>
                <div className="user-avatar">{initials(actor.full_name)}</div>
                <div className="user-meta">
                  <span className="name">{actor.full_name}</span>
                  <span className="role">{actor.role.replace(/_/g, " ")}</span>
                </div>
              </div>
              <LogoutButton />
            </div>
          </aside>

          <div className="main">
            <header className="header">
              <div>
                <h1>IT Asset Management</h1>
                <div className="page-subtitle">Lifecycle tracking &amp; custody handshakes</div>
              </div>
            </header>
            <div className="content">{children}</div>
          </div>
        </div>
      </body>
    </html>
  );
}
