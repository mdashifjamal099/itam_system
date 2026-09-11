"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PhotoCapture } from "@/components/PhotoCapture";

export function ReturnForm({ assetId }: { assetId: string }) {
  const router = useRouter();
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/assets/${assetId}/return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ photoUrl }),
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
      <PhotoCapture label="Condition photo at return" onChange={setPhotoUrl} />
      <button className="btn large primary" disabled={busy} onClick={submit}>
        {busy ? "Returning…" : "Return asset"}
      </button>
      {error && <p className="msg error">{error}</p>}
    </div>
  );
}
