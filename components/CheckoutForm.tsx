"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PhotoCapture } from "@/components/PhotoCapture";

type Recipient = { id: string; full_name: string };

export function CheckoutForm({ assetId, recipients }: { assetId: string; recipients: Recipient[] }) {
  const router = useRouter();
  const [toUserId, setToUserId] = useState(recipients[0]?.id ?? "");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error?: string; devOtp?: string } | null>(null);

  async function submit() {
    setBusy(true);
    setResult(null);
    const res = await fetch(`/api/assets/${assetId}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toUserId, photoUrl }),
    });
    const body = await res.json();
    setBusy(false);
    setResult(res.ok ? { devOtp: body.devOtp } : { error: body.error });

    // Deliberately NOT calling router.refresh() here on success. The asset's
    // state flips AVAILABLE -> PENDING_ACCEPTANCE the moment checkout
    // succeeds, and this form only renders while current_state === AVAILABLE
    // (see app/assets/[id]/page.tsx) — refreshing immediately unmounts this
    // component mid-render, which destroys `result.devOtp` before anyone can
    // read it. The dev OTP callout below has its own explicit "Continue"
    // button that triggers the refresh once the admin has actually seen it.
  }

  if (recipients.length === 0) {
    return <p className="msg hint-text">No employees available to check this asset out to.</p>;
  }

  if (result?.devOtp) {
    return (
      <div className="otp-callout" style={{ maxWidth: 360 }}>
        No email provider is wired up yet, so the OTP normally sent to the recipient is shown
        here instead: <code>{result.devOtp}</code>
        <br />
        Switch to that user and enter it on this page to accept custody.
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => router.refresh()}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 360 }}>
      <div className="field">
        <label>Assign to</label>
        <select value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
          {recipients.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name}
            </option>
          ))}
        </select>
      </div>
      <PhotoCapture label="Condition photo at handoff" onChange={setPhotoUrl} />
      <button className="btn large primary block" disabled={busy} onClick={submit}>
        {busy ? "Checking out…" : "Checkout asset"}
      </button>

      {result?.error && <p className="msg error">{result.error}</p>}
    </div>
  );
}
