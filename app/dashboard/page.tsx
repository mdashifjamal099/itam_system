import Link from "next/link";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, hasRole } from "@/lib/auth";
import { SweepButton } from "@/components/SweepButton";
import { OffboardForm } from "@/components/OffboardForm";
import { KpiCard } from "@/components/KpiCard";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDate(d: unknown) {
  if (!d) return "—";
  const dt = new Date(d as string);
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

export default async function OpsDashboard() {
  const actorOrNull = await getActor();
  if (!hasRole(actorOrNull, "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN")) {
    return (
      <div className="card">
        <div className="empty-state">This dashboard requires a manager or admin role.</div>
      </div>
    );
  }
  const actor = actorOrNull!;

  const kpiRows = await withTenant<{ result: Record<string, unknown> }>(
    actor.org_id,
    sql`SELECT fn_org_kpis(${actor.org_id}::uuid) AS result`,
  );
  const kpis = kpiRows[0].result;
  const byState = (kpis.byState ?? {}) as Record<string, number>;

  const tasks = await withTenant(
    actor.org_id,
    sql`SELECT rt.id, rt.reason, rt.due_date, rt.reminders,
               a.asset_tag, a.id AS asset_id, u.full_name AS holder_name
        FROM recovery_task rt
        JOIN asset a ON a.id = rt.asset_id
        JOIN app_user u ON u.id = rt.user_id
        WHERE rt.status <> 'RESOLVED'
        ORDER BY rt.due_date NULLS LAST, rt.created_at`,
  );
  const overdueTasks = tasks.filter((t) => t.reason === "OVERDUE");
  const offboardingTasks = tasks.filter((t) => t.reason === "OFFBOARDING");

  const lostAssets = await withTenant(
    actor.org_id,
    sql`SELECT a.id, a.asset_tag, a.model, u.full_name AS last_holder, a.state_updated_at
        FROM asset a
        LEFT JOIN app_user u ON u.id = a.current_holder_id
        WHERE a.org_id = ${actor.org_id}::uuid AND a.current_state = 'LOST'
        ORDER BY a.state_updated_at DESC`,
  );

  const maintenanceAssets = await withTenant(
    actor.org_id,
    sql`SELECT a.id, a.asset_tag, a.model, m.issue_type, m.severity, m.opened_at
        FROM asset a
        JOIN maintenance_log m ON m.asset_id = a.id AND m.closed_at IS NULL
        WHERE a.org_id = ${actor.org_id}::uuid AND a.current_state = 'MAINTENANCE'
        ORDER BY m.opened_at DESC`,
  );

  const canOffboard = actor.role === "ASSET_ADMIN" || actor.role === "SUPER_ADMIN";
  const employees = canOffboard
    ? await withTenant(
        actor.org_id,
        sql`SELECT id, full_name FROM app_user
            WHERE employment_status = 'ACTIVE' ORDER BY full_name`,
      )
    : [];

  const openTasks = overdueTasks.length + offboardingTasks.length;

  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Operations Dashboard</h2>
          <div className="sub">Fleet health, recovery tasks &amp; manual controls</div>
        </div>
        {openTasks > 0 && (
          <span className="badge PENDING_ACCEPTANCE">
            {openTasks} open task{openTasks !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Fleet KPIs */}
      <div className="section-title">Fleet overview</div>
      <div className="kpi-grid">
        <KpiCard label="Total assets" value={kpis.total as number} accent="blue" />
        <KpiCard label="Available" value={byState.AVAILABLE ?? 0} accent="ok" />
        <KpiCard label="Assigned" value={byState.ASSIGNED_ACTIVE ?? 0} accent="blue" />
        <KpiCard label="Maintenance" value={byState.MAINTENANCE ?? 0} accent="danger" />
        <KpiCard label="Pending acceptance" value={byState.PENDING_ACCEPTANCE ?? 0} accent="warn" />
        <KpiCard label="Lost" value={byState.LOST ?? 0} accent="danger" />
      </div>

      {/* Operations KPIs */}
      <div className="section-title">Operations</div>
      <div className="kpi-grid">
        <KpiCard label="Avg holding days" value={(kpis.avgHoldingDays as number) ?? 0} />
        <KpiCard label="Open recovery tasks" value={kpis.openRecoveryTasks as number} accent="warn" />
        <KpiCard label="Warranty expiring soon" value={kpis.warrantyExpiringSoon as number} accent="warn" />
        <KpiCard label="Unpublished events" value={kpis.unpublishedEvents as number} />
      </div>

      {/* Recovery tasks */}
      <div className="section-title">Recovery tasks</div>

      <div className="card">
        <div className="card-header">
          <h3>Overdue returns</h3>
          <span className="hint">{overdueTasks.length} open</span>
        </div>
        {overdueTasks.length === 0 ? (
          <div className="empty-state">
            <div className="icon">✅</div>
            No overdue assets right now.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Held by</th>
                <th>Due</th>
                <th>Reminders</th>
              </tr>
            </thead>
            <tbody>
              {overdueTasks.map((t) => (
                <tr key={t.id as string}>
                  <td>
                    <Link href={`/assets/${t.asset_id}`} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>
                      {t.asset_tag as string}
                    </Link>
                  </td>
                  <td>{t.holder_name as string}</td>
                  <td>{fmtDate(t.due_date)}</td>
                  <td>
                    <span className="badge plain">{String(t.reminders)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Offboarding recovery</h3>
          <span className="hint">{offboardingTasks.length} open</span>
        </div>
        {offboardingTasks.length === 0 ? (
          <div className="empty-state">
            <div className="icon">✅</div>
            No outstanding offboarding recoveries.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Former holder</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {offboardingTasks.map((t) => (
                <tr key={t.id as string}>
                  <td>
                    <Link href={`/assets/${t.asset_id}`} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>
                      {t.asset_tag as string}
                    </Link>
                  </td>
                  <td>{t.holder_name as string}</td>
                  <td>{fmtDate(t.due_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Attention lists */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 16,
        }}
      >
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-header">
            <h3>Lost assets</h3>
            <span className="hint">{lostAssets.length}</span>
          </div>
          {lostAssets.length === 0 ? (
            <div className="empty-state">
              <div className="icon">🔍</div>
              No lost assets.
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Last holder</th>
                  <th>Reported</th>
                </tr>
              </thead>
              <tbody>
                {lostAssets.map((a) => (
                  <tr key={a.id as string}>
                    <td>
                      <Link href={`/assets/${a.id}`} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>
                        {a.asset_tag as string}
                      </Link>
                      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{a.model as string}</div>
                    </td>
                    <td>{(a.last_holder as string) ?? "—"}</td>
                    <td>{fmtDate(a.state_updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-header">
            <h3>In maintenance</h3>
            <span className="hint">{maintenanceAssets.length}</span>
          </div>
          {maintenanceAssets.length === 0 ? (
            <div className="empty-state">
              <div className="icon">🔧</div>
              Nothing currently in maintenance.
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Issue</th>
                  <th>Severity</th>
                  <th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {maintenanceAssets.map((a) => (
                  <tr key={a.id as string}>
                    <td>
                      <Link href={`/assets/${a.id}`} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>
                        {a.asset_tag as string}
                      </Link>
                      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{a.model as string}</div>
                    </td>
                    <td>{(a.issue_type as string)?.replace(/_/g, " ") ?? "—"}</td>
                    <td>
                      <span className={`badge ${a.severity === "HIGH" ? "MAINTENANCE" : "PENDING_ACCEPTANCE"}`}>
                        {a.severity as string}
                      </span>
                    </td>
                    <td>{fmtDate(a.opened_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Manual controls */}
      {canOffboard && (
        <>
          <div className="section-title">Manual controls</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: 16,
            }}
          >
            <div className="card" style={{ marginBottom: 0 }}>
              <div className="card-header">
                <h3>Run sweeps</h3>
              </div>
              <p className="hint-text" style={{ marginBottom: 14 }}>
                Scheduled automatically via QStash in production; triggerable here for this org on demand.
              </p>
              <div className="action-row">
                <SweepButton kind="overdue" label="Sweep overdue returns" />
                <SweepButton kind="warranty" label="Sweep warranty expirations" />
              </div>
            </div>

            <div className="card" style={{ marginBottom: 0 }}>
              <div className="card-header">
                <h3>Offboard an employee</h3>
              </div>
              <p className="hint-text" style={{ marginBottom: 14 }}>
                Same operation the HRIS webhook (<code>/api/webhooks/hris</code>) triggers automatically.
                Flags their assigned assets for recovery — does not force a return.
              </p>
              <OffboardForm employees={employees as { id: string; full_name: string }[]} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
