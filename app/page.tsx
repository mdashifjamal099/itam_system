import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, hasRole } from "@/lib/auth";
import { AssetGrid, type AssetRow } from "@/components/AssetGrid";
import { KpiCard } from "@/components/KpiCard";
import { AddAssetForm } from "@/components/AddAssetForm";
import { BulkImportForm } from "@/components/BulkImportForm";

export default async function DashboardPage() {
  const actor = await getActor();

  // Sign-in lives at /login (real credentials + the dev switcher). Middleware
  // catches the no-cookie case; this also covers a cookie that exists but no
  // longer resolves — expired JWT, deleted user, or a terminated employee.
  if (!actor) redirect("/login");

  const isAdmin = hasRole(actor, "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN");

  // ── Admin / Manager view: full fleet overview ──────────────────────────────
  if (isAdmin) {
    const kpiRows = await withTenant<{ result: Record<string, unknown> }>(
      actor.org_id,
      sql`SELECT fn_org_kpis(${actor.org_id}::uuid) AS result`,
    );
    const kpis = kpiRows[0].result;
    const byState = (kpis.byState ?? {}) as Record<string, number>;

    const assets = await withTenant<AssetRow>(
      actor.org_id,
      sql`SELECT a.id, a.asset_tag, a.model, a.category, a.current_state, u.full_name AS holder_name
          FROM asset a
          LEFT JOIN app_user u ON u.id = a.current_holder_id
          ORDER BY a.asset_tag`,
    );

    return (
      <>
        <div className="page-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2>Asset Fleet</h2>
            <div className="sub">{assets.length} asset{assets.length !== 1 ? "s" : ""} in your organization</div>
          </div>
          {hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN") && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <AddAssetForm />
              <BulkImportForm />
            </div>
          )}
        </div>

        <div className="kpi-grid">
          <KpiCard label="Total assets" value={kpis.total as number} accent="blue" />
          <KpiCard label="Available" value={byState.AVAILABLE ?? 0} accent="ok" />
          <KpiCard label="Assigned" value={byState.ASSIGNED_ACTIVE ?? 0} accent="blue" />
          <KpiCard label="Pending acceptance" value={byState.PENDING_ACCEPTANCE ?? 0} accent="warn" />
          <KpiCard label="Maintenance" value={byState.MAINTENANCE ?? 0} accent="danger" />
          <KpiCard label="Lost" value={byState.LOST ?? 0} accent="danger" />
        </div>

        <AssetGrid assets={assets} />
      </>
    );
  }

  // ── Employee view: only their own assets ───────────────────────────────────
  const myAssets = await withTenant<AssetRow>(
    actor.org_id,
    sql`SELECT a.id, a.asset_tag, a.model, a.category, a.current_state, u.full_name AS holder_name
        FROM asset a
        LEFT JOIN app_user u ON u.id = a.current_holder_id
        WHERE a.current_holder_id = ${actor.id}::uuid
           OR EXISTS (
             SELECT 1 FROM custody_handshake ch
             WHERE ch.asset_id = a.id
               AND ch.to_user_id = ${actor.id}::uuid
               AND ch.status = 'INITIATED'
           )
        ORDER BY a.asset_tag`,
  );

  const pendingCount = myAssets.filter((a) => a.current_state === "PENDING_ACCEPTANCE").length;
  const activeCount  = myAssets.filter((a) => a.current_state === "ASSIGNED_ACTIVE").length;

  return (
    <>
      <div className="page-heading">
        <div>
          <h2>My Assets</h2>
          <div className="sub">
            {myAssets.length === 0
              ? "No assets currently assigned to you"
              : `${myAssets.length} asset${myAssets.length !== 1 ? "s" : ""} assigned to you`}
          </div>
        </div>
      </div>

      {myAssets.length > 0 && (
        <div className="kpi-grid" style={{ marginBottom: 20 }}>
          <KpiCard label="Active" value={activeCount} accent="blue" />
          <KpiCard label="Pending your acceptance" value={pendingCount} accent="warn" />
        </div>
      )}

      {pendingCount > 0 && (
        <div
          style={{
            background: "var(--warn-soft)",
            border: "1px solid #f0d090",
            borderRadius: "var(--radius-sm)",
            padding: "10px 14px",
            fontSize: 13,
            marginBottom: 16,
            color: "var(--warn)",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>⚠</span>
          <span>
            You have {pendingCount} asset{pendingCount !== 1 ? "s" : ""} waiting for your acceptance.
            Open the asset to verify your OTP.
          </span>
        </div>
      )}

      {myAssets.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="icon">📦</div>
            No assets are currently assigned to you.
            <br />
            <span style={{ fontSize: 12 }}>Your IT admin will check out assets to you when needed.</span>
          </div>
        </div>
      ) : (
        <AssetGrid assets={myAssets} />
      )}
    </>
  );
}
