"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AcceptCustodyForm({ handshakeId }: { handshakeId: string }) {
  const router = useRouter();
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/custody/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handshakeId, otp }),
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
        <label>Enter the 6-digit OTP to accept custody</label>
        <input
          value={otp}
          onChange={(e) => setOtp(e.target.value)}
          maxLength={6}
          inputMode="numeric"
          placeholder="000000"
          autoFocus
          style={{ fontSize: 18, letterSpacing: "0.15em", textAlign: "center" }}
        />
      </div>
      <button className="btn large primary block" disabled={busy || otp.length !== 6} onClick={submit}>
        {busy ? "Verifying…" : "Accept custody"}
      </button>
      {error && <p className="msg error">{error}</p>}
    </div>
  );
}
