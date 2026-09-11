"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LostForm({ assetId }: { assetId: string }) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/assets/${assetId}/lost`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error);
      return;
    }
    router.refresh();
  }

  if (!open) {
    return (
      <button className="btn large danger" onClick={() => setOpen(true)}>
        Report lost / stolen
      </button>
    );
  }

  return (
    <div style={{ width: "100%", maxWidth: 360, marginTop: 4 }}>
      <div className="field">
        <label>What happened?</label>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" autoFocus />
      </div>
      <div className="action-row">
        <button className="btn large danger" disabled={busy} onClick={submit}>
          {busy ? "Reporting…" : "Confirm: report as lost"}
        </button>
        <button className="btn large" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <p className="msg error">{error}</p>}
    </div>
  );
}
