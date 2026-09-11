"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ActionButton({
  label,
  endpoint,
  method = "POST",
  variant = "primary",
}: {
  label: string;
  endpoint: string;
  method?: string;
  variant?: "primary" | "default";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch(endpoint, { method });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error);
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <button
        className={`btn large ${variant === "primary" ? "primary" : ""}`}
        disabled={busy}
        onClick={submit}
      >
        {busy ? "Working…" : label}
      </button>
      {error && <p className="msg error">{error}</p>}
    </div>
  );
}
