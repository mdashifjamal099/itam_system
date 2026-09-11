"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type DevActor = { id: string; name: string; department: string; role: string };

export function ActorPicker({ actors }: { actors: DevActor[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  async function login(id: string) {
    setPending(id);
    const res = await fetch("/api/dev/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: id }),
    });
    setPending(null);
    if (res.ok) {
      // This panel now lives on /login, so land the user on the dashboard
      // rather than re-rendering the sign-in page in place.
      router.push("/");
      router.refresh();
    }
  }

  if (actors.length === 0) {
    return (
      <div className="card">
        <p>No seeded actors found. Run:</p>
        <pre>npm run db:seed</pre>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: 4 }}>Sign in as</h3>
      <p className="hint-text" style={{ marginBottom: 16 }}>
        Development actor switcher — pick a seeded user to explore the app.
      </p>
      <div className="picker-list">
        {actors.map((a) => (
          <button key={a.id} className="btn large" disabled={pending === a.id} onClick={() => login(a.id)}>
            {pending === a.id ? "Signing in…" : a.name}
            <span className="role">
              {a.role.replace("_", " ")} · {a.department}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
