"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type SweepResult = { overdue?: number; tasks?: number; expiring?: number };

export function SweepButton({ kind, label }: { kind: "overdue" | "warranty"; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function run() {
    setBusy(true);
    setResult(null);
    setIsError(false);
    const res = await fetch("/api/ops/sweep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    const body = (await res.json()) as SweepResult & { error?: string };
    setBusy(false);

    if (!res.ok) {
      setIsError(true);
      setResult(body.error ?? "Sweep failed");
    } else if (kind === "overdue") {
      setResult(`${body.overdue ?? 0} overdue asset(s) found, ${body.tasks ?? 0} new task(s) opened`);
    } else {
      setResult(`${body.expiring ?? 0} asset(s) with warranty expiring soon`);
    }
    router.refresh();
  }

  return (
    <div>
      <button className="btn" disabled={busy} onClick={run}>
        {busy ? "Running…" : label}
      </button>
      {result && <p className={`msg ${isError ? "error" : "ok"}`}>{result}</p>}
    </div>
  );
}
