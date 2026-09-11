type Accent = "ok" | "warn" | "danger" | "blue" | undefined;

export function KpiCard({ label, value, accent }: { label: string; value: number; accent?: Accent }) {
  return (
    <div className={`kpi-card${accent ? ` accent-${accent}` : ""}`}>
      <div className="value">{value ?? 0}</div>
      <div className="label">{label}</div>
    </div>
  );
}
