import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, hasRole } from "@/lib/auth";
import { PolicyForm } from "@/components/PolicyForm";

export default async function SettingsPage() {
  const actor = await getActor();
  if (!hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN")) {
    return (
      <div className="card">
        <div className="empty-state">Organization settings require an admin role.</div>
      </div>
    );
  }

  const rows = await withTenant<{
    max_holding_days: number;
    warranty_alert_days: number;
    handshake_ttl_minutes: number;
  }>(
    actor!.org_id,
    sql`SELECT (p).max_holding_days, (p).warranty_alert_days, (p).handshake_ttl_minutes
        FROM fn_org_policy(${actor!.org_id}::uuid) AS p`,
  );

  return (
    <div className="card">
      <div className="card-header">
        <h3>Organization policy</h3>
        <span className="hint">Controls the overdue and warranty sweeps</span>
      </div>
      <PolicyForm initial={rows[0]} />
    </div>
  );
}
