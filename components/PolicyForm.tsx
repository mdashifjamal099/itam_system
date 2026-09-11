"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Policy = { max_holding_days: number; warranty_alert_days: number; handshake_ttl_minutes: number };

export function PolicyForm({ initial }: { initial: Policy }) {
  const router = useRouter();
  const [maxHoldingDays, setMaxHoldingDays] = useState(String(initial.max_holding_days));
  const [warrantyAlertDays, setWarrantyAlertDays] = useState(String(initial.warranty_alert_days));
  const [handshakeTtlMinutes, setHandshakeTtlMinutes] = useState(String(initial.handshake_ttl_minutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/ops/policy", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        maxHoldingDays: Number(maxHoldingDays),
        warrantyAlertDays: Number(warrantyAlertDays),
        handshakeTtlMinutes: Number(handshakeTtlMinutes),
      }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div style={{ maxWidth: 420 }}>
      <div className="field">
        <label>Max holding days before an asset is flagged overdue</label>
        <input
          type="number"
          min={1}
          value={maxHoldingDays}
          onChange={(e) => setMaxHoldingDays(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Warranty alert window (days before expiry)</label>
        <input
          type="number"
          min={1}
          value={warrantyAlertDays}
          onChange={(e) => setWarrantyAlertDays(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Handshake OTP expiry (minutes)</label>
        <input
          type="number"
          min={1}
          value={handshakeTtlMinutes}
          onChange={(e) => setHandshakeTtlMinutes(e.target.value)}
        />
      </div>
      <button className="btn large primary" disabled={busy} onClick={submit}>
        {busy ? "Saving…" : "Save policy"}
      </button>
      {error && <p className="msg error">{error}</p>}
      {saved && <p className="msg ok">Saved. This applies to future sweeps and checkouts.</p>}
    </div>
  );
}
