"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const CONDITIONS = ["GOOD", "MINOR_DAMAGE", "MAJOR_DAMAGE", "UNUSABLE"] as const;

export function InspectForm({ assetId }: { assetId: string }) {
  const router = useRouter();
  const [condition, setCondition] = useState<(typeof CONDITIONS)[number]>("GOOD");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/assets/${assetId}/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ condition, notes }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error);
      return;
    }
    router.refresh();
  }

  return (
    <div style={{ maxWidth: 360 }}>
      <div className="field">
        <label>Condition found</label>
        <select value={condition} onChange={(e) => setCondition(e.target.value as typeof condition)}>
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c.replace("_", " ")}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Notes</label>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
      </div>
      <button className="btn large primary block" disabled={busy} onClick={submit}>
        {busy ? "Submitting…" : "Complete inspection"}
      </button>
      {error && <p className="msg error">{error}</p>}
    </div>
  );
}
