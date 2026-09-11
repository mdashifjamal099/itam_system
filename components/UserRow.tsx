"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const ROLES = ["EMPLOYEE", "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN"] as const;
const ADMIN_TIER = new Set(["ASSET_ADMIN", "SUPER_ADMIN"]);

type User = {
  id: string;
  employee_id: string;
  full_name: string;
  email: string;
  department: string | null;
  role: (typeof ROLES)[number];
  employment_status: "ACTIVE" | "TERMINATED";
};

export function UserRow({
  user,
  isSelf,
  viewerRole,
}: {
  user: User;
  isSelf: boolean;
  viewerRole: (typeof ROLES)[number];
}) {
  const router = useRouter();
  const [role, setRole] = useState(user.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, string>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/ops/users/${user.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error);
      setRole(user.role); // revert the optimistic select change
      return;
    }
    router.refresh();
  }

  const terminated = user.employment_status === "TERMINATED";
  const viewerIsSuperAdmin = viewerRole === "SUPER_ADMIN";
  // An ASSET_ADMIN cannot touch an admin-tier account in either direction —
  // matches the server-side check in /api/ops/users/[id]. Disabled here too
  // so the control never invites a click that the API will just reject.
  const targetIsAdminTier = ADMIN_TIER.has(user.role);
  const roleLocked = !viewerIsSuperAdmin && targetIsAdminTier;
  const selectableRoles = viewerIsSuperAdmin ? ROLES : ROLES.filter((r) => !ADMIN_TIER.has(r));

  return (
    <tr style={terminated ? { opacity: 0.55 } : undefined}>
      <td>
        {user.full_name}
        {isSelf && <span className="hint-text"> (you)</span>}
      </td>
      <td>{user.email}</td>
      <td>{user.department ?? "—"}</td>
      <td>
        <select
          value={role}
          disabled={busy || isSelf || terminated || roleLocked}
          title={roleLocked ? "Only a SUPER_ADMIN can change an admin-tier account" : undefined}
          onChange={(e) => {
            const next = e.target.value as typeof role;
            setRole(next);
            patch({ role: next });
          }}
        >
          {/* Keep the account's current role selectable even if it's outside
              what this viewer could newly assign, so the control shows the
              truth instead of silently substituting the first option. */}
          {(selectableRoles.includes(role) ? selectableRoles : [role, ...selectableRoles]).map((r) => (
            <option key={r} value={r}>
              {r.replace("_", " ")}
            </option>
          ))}
        </select>
      </td>
      <td>
        <span className={`badge ${terminated ? "LOST" : "AVAILABLE"}`}>
          {terminated ? "TERMINATED" : "ACTIVE"}
        </span>
      </td>
      <td>
        {!isSelf && (
          <button
            className={`btn ${terminated ? "" : "danger"}`}
            disabled={busy || roleLocked}
            title={roleLocked ? "Only a SUPER_ADMIN can change an admin-tier account" : undefined}
            onClick={() => patch({ employmentStatus: terminated ? "ACTIVE" : "TERMINATED" })}
          >
            {terminated ? "Reactivate" : "Deactivate"}
          </button>
        )}
        {error && <div className="msg error">{error}</div>}
      </td>
    </tr>
  );
}
