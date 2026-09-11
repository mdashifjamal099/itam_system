const CYCLE = ["AVAILABLE", "PENDING_ACCEPTANCE", "ASSIGNED_ACTIVE", "UNDER_INSPECTION"] as const;

const LABELS: Record<string, string> = {
  AVAILABLE: "Available",
  PENDING_ACCEPTANCE: "Awaiting acceptance",
  ASSIGNED_ACTIVE: "In use",
  UNDER_INSPECTION: "Inspection",
};

/** Visual progress through the main custody cycle. Side-branch states (LOST,
 *  MAINTENANCE, RETIRED, PROCURED) fall outside this cycle and render nothing
 *  here — the state badge already communicates those clearly on its own. */
export function AssetStepper({ state }: { state: string }) {
  const idx = CYCLE.indexOf(state as (typeof CYCLE)[number]);
  if (idx === -1) return null;

  return (
    <div className="stepper">
      {CYCLE.map((step, i) => (
        <div key={step} style={{ display: "flex", alignItems: "center" }}>
          <div className={`step ${i < idx ? "done" : i === idx ? "current" : ""}`}>
            <span className="node" />
            <span className="label">{LABELS[step]}</span>
          </div>
          {i < CYCLE.length - 1 && <div className={`step-connector ${i < idx ? "done" : ""}`} />}
        </div>
      ))}
    </div>
  );
}
