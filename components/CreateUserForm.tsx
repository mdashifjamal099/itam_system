"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const ROLES = ["EMPLOYEE", "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN"] as const;
const ADMIN_TIER = new Set(["ASSET_ADMIN", "SUPER_ADMIN"]);

export function CreateUserForm({ viewerRole }: { viewerRole: (typeof ROLES)[number] }) {
  const router = useRouter();
  const selectableRoles = viewerRole === "SUPER_ADMIN" ? ROLES : ROLES.filter((r) => !ADMIN_TIER.has(r));
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [department, setDepartment] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("EMPLOYEE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ tempPassword: string; email: string } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/ops/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName, email, department, role }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error);
      return;
    }
    setCreated({ tempPassword: body.tempPassword, email: email.toLowerCase() });
    // No router.refresh() here — same lesson as CheckoutForm's OTP: refreshing
    // now would re-fetch the user list and could unmount this success state
    // before the admin has copied the temp password down. The explicit
    // "Continue" button below refreshes once they're done reading it.
  }

  if (created) {
    return (
      <div className="otp-callout">
        No email provider is wired up yet, so the temporary password is shown here instead of being
        emailed to <strong>{created.email}</strong>:
        <br />
        <code>{created.tempPassword}</code>
        <br />
        They should sign in and this should be treated as a one-time credential to hand off securely.
        <div style={{ marginTop: 12 }}>
          <button
            className="btn"
            onClick={() => {
              setCreated(null);
              setFullName("");
              setEmail("");
              setDepartment("");
              setRole("EMPLOYEE");
              router.refresh();
            }}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400 }}>
      <div className="field">
        <label>Full name</label>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Doe" />
      </div>
      <div className="field">
        <label>Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="jane@company.test"
        />
      </div>
      <div className="field">
        <label>Department</label>
        <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Engineering" />
      </div>
      <div className="field">
        <label>Role</label>
        <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
          {selectableRoles.map((r) => (
            <option key={r} value={r}>
              {r.replace("_", " ")}
            </option>
          ))}
        </select>
        {viewerRole !== "SUPER_ADMIN" && (
          <p className="hint-text" style={{ marginTop: 4 }}>
            Only a SUPER_ADMIN can invite another admin-tier account.
          </p>
        )}
      </div>
      <button
        className="btn large primary"
        disabled={busy || !fullName || !email}
        onClick={submit}
      >
        {busy ? "Creating…" : "Create user"}
      </button>
      {error && <p className="msg error">{error}</p>}
    </div>
  );
}
