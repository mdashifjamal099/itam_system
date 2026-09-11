"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Employee = { id: string; full_name: string };

export function OffboardForm({ employees }: { employees: Employee[] }) {
  const router = useRouter();
  const [userId, setUserId] = useState(employees[0]?.id ?? "");
  const [lastDay, setLastDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error?: string; recoveryTasks?: number } | null>(null);

  async function submit() {
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/ops/offboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, lastWorkingDay: lastDay || null }),
    });
    const body = await res.json();
    setBusy(false);
    setResult(res.ok ? body : { error: body.error });
    if (res.ok) router.refresh();
  }

  if (employees.length === 0) return <p className="msg hint-text">No active employees to offboard.</p>;

  return (
    <div style={{ maxWidth: 360 }}>
      <div className="field">
        <label>Employee</label>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.full_name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Last working day</label>
        <input type="date" value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
      </div>
      <button className="btn large" disabled={busy} onClick={submit}>
        {busy ? "Processing…" : "Offboard employee"}
      </button>
      {result?.error && <p className="msg error">{result.error}</p>}
      {typeof result?.recoveryTasks === "number" && (
        <p className="msg ok">
          Done. {result.recoveryTasks} asset(s) flagged for recovery.
        </p>
      )}
    </div>
  );
}
