import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, hasRole } from "@/lib/auth";
import { CheckoutForm } from "@/components/CheckoutForm";
import { AcceptCustodyForm } from "@/components/AcceptCustodyForm";
import { ActionButton } from "@/components/ActionButton";
import { InspectForm } from "@/components/InspectForm";
import { LostForm } from "@/components/LostForm";
import { AssetStepper } from "@/components/AssetStepper";
import { ReturnForm } from "@/components/ReturnForm";

const STATE_LABELS: Record<string, string> = {
  PROCURED: "Procured",
  AVAILABLE: "Available",
  PENDING_ACCEPTANCE: "Pending Acceptance",
  ASSIGNED_ACTIVE: "Assigned",
  UNDER_INSPECTION: "Under Inspection",
  MAINTENANCE: "Maintenance",
  RETIRED: "Retired",
  LOST: "Lost",
};

const EVENT_LABELS: Record<string, string> = {
  "asset.intake": "Intake",
  "asset.checkout": "Checked out",
  "asset.custody_accepted": "Custody accepted",
  "asset.returned": "Returned",
  "asset.inspected": "Inspected",
  "asset.lost": "Reported lost",
  "asset.recovered": "Recovered",
  "asset.maintenance_opened": "Sent to maintenance",
  "asset.maintenance_closed": "Maintenance closed",
  "asset.retired": "Retired",
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDate(d: unknown) {
  if (!d) return "—";
  const dt = new Date(d as string);
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

function fmtDateTime(d: unknown) {
  if (!d) return "";
  const dt = new Date(d as string);
  const h = String(dt.getUTCHours()).padStart(2, "0");
  const m = String(dt.getUTCMinutes()).padStart(2, "0");
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}, ${h}:${m}`;
}

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) return <div className="card">Please sign in from the dashboard first.</div>;

  const assets = await withTenant(
    actor.org_id,
    sql`SELECT a.*, u.full_name AS holder_name
        FROM asset a
        LEFT JOIN app_user u ON u.id = a.current_holder_id
        WHERE a.id = ${id}::uuid`,
  );
  const asset = assets[0];
  if (!asset) notFound();

  const liveHandshake = await withTenant(
    actor.org_id,
    sql`SELECT ch.id, ch.to_user_id, ch.otp_expires_at, u.full_name AS to_user_name
        FROM custody_handshake ch
        JOIN app_user u ON u.id = ch.to_user_id
        WHERE ch.asset_id = ${id}::uuid AND ch.status = 'INITIATED'
        ORDER BY ch.initiated_at DESC LIMIT 1`,
  );

  const recipients =
    asset.current_state === "AVAILABLE"
      ? await withTenant(
          actor.org_id,
          sql`SELECT id, full_name, role FROM app_user
              WHERE org_id = ${actor.org_id}::uuid AND role IN ('EMPLOYEE','MANAGER')
              ORDER BY full_name`,
        )
      : [];

  const canSeeTimeline = hasRole(actor, "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN");
  const events = canSeeTimeline
    ? await withTenant(
        actor.org_id,
        sql`SELECT e.event_type, e.from_state, e.to_state, e.occurred_at, e.payload,
                   u.full_name AS actor_name
            FROM asset_state_event e
            LEFT JOIN app_user u ON u.id = e.actor_id
            WHERE e.asset_id = ${id}::uuid
            ORDER BY e.asset_version DESC`,
      )
    : [];

  const isHolder = asset.current_holder_id === actor.id;
  const isRecipient = liveHandshake[0]?.to_user_id === actor.id;

  const openRecovery = await withTenant(
    actor.org_id,
    sql`SELECT reason, due_date, reminders FROM recovery_task
        WHERE asset_id = ${id}::uuid AND status <> 'RESOLVED'
        ORDER BY created_at LIMIT 1`,
  );

  const hasAnyAction =
    (asset.current_state === "AVAILABLE" && hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN")) ||
    (asset.current_state === "PENDING_ACCEPTANCE" && isRecipient) ||
    (asset.current_state === "ASSIGNED_ACTIVE" &&
      (isHolder || hasRole(actor, "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN"))) ||
    (asset.current_state === "UNDER_INSPECTION" && hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN")) ||
    (asset.current_state === "LOST" && hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN"));

  return (
    <>
      <Link
        href="/"
        className="hint-text"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 16 }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 5l-7 7 7 7"/>
        </svg>
        Back to assets
      </Link>

      <div className="card">
        {/* Header row */}
        <div className="asset-detail-header">
          <div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.07em",
                color: "var(--muted-2)",
              }}
            >
              {asset.category as string}
            </span>
            <div
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "var(--muted)", marginTop: 2 }}
            >
              {asset.asset_tag as string}
            </div>
          </div>
          <span className={`badge ${asset.current_state}`}>
            {STATE_LABELS[asset.current_state as string] ?? (asset.current_state as string)}
          </span>
        </div>

        <h2 style={{ fontSize: 22, margin: "6px 0 16px" }}>{asset.model as string}</h2>

        <AssetStepper state={asset.current_state as string} />

        <div className="info-grid">
          <div className="item">
            <div className="k">Current holder</div>
            <div className="v">
              {asset.current_state === "PENDING_ACCEPTANCE" && liveHandshake[0] ? (
                <span style={{ color: "var(--warn)" }}>
                  Pending · {liveHandshake[0].to_user_name as string}
                </span>
              ) : (
                (asset.holder_name as string) ?? "Unassigned"
              )}
            </div>
          </div>
          <div className="item">
            <div className="k">Serial number</div>
            <div className="v" style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>
              {asset.serial_number as string}
            </div>
          </div>
          <div className="item">
            <div className="k">Location</div>
            <div className="v">{(asset.location as string) ?? "—"}</div>
          </div>
          <div className="item">
            <div className="k">Warranty expiry</div>
            <div className="v">{fmtDate(asset.warranty_expiry)}</div>
          </div>
          <div className="item">
            <div className="k">Procured</div>
            <div className="v">{fmtDate(asset.procurement_date)}</div>
          </div>
          <div className="item">
            <div className="k">Version</div>
            <div className="v" style={{ color: "var(--muted)", fontWeight: 500 }}>v{String(asset.version)}</div>
          </div>
        </div>

        {openRecovery[0] && (
          <div className="recovery-banner">
            <span>⚠</span>
            <span>
              Recovery pending —{" "}
              <strong>{(openRecovery[0].reason as string).toLowerCase()}</strong>
              {openRecovery[0].due_date ? <> · due {String(openRecovery[0].due_date)}</> : null}
              {Number(openRecovery[0].reminders) > 0 ? (
                <> · {String(openRecovery[0].reminders)} reminder(s) sent</>
              ) : null}
            </span>
          </div>
        )}

        {hasAnyAction && <hr className="divider" />}

        {asset.current_state === "AVAILABLE" && hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN") && (
          <CheckoutForm assetId={id} recipients={recipients as { id: string; full_name: string }[]} />
        )}

        {asset.current_state === "PENDING_ACCEPTANCE" && isRecipient && liveHandshake[0] && (
          <AcceptCustodyForm handshakeId={liveHandshake[0].id as string} />
        )}
        {asset.current_state === "PENDING_ACCEPTANCE" && !isRecipient && (
          <p className="msg hint-text">Waiting for the recipient to verify their OTP.</p>
        )}

        {asset.current_state === "ASSIGNED_ACTIVE" &&
          (isHolder || hasRole(actor, "MANAGER", "ASSET_ADMIN", "SUPER_ADMIN")) && (
            <div className="action-row" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
              <ReturnForm assetId={id} />
              <LostForm assetId={id} />
            </div>
          )}

        {asset.current_state === "UNDER_INSPECTION" && hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN") && (
          <InspectForm assetId={id} />
        )}

        {asset.current_state === "LOST" && hasRole(actor, "ASSET_ADMIN", "SUPER_ADMIN") && (
          <ActionButton
            label="Mark recovered → send to inspection"
            endpoint={`/api/assets/${id}/recover`}
            method="POST"
            variant="primary"
          />
        )}
      </div>

      {canSeeTimeline && (
        <div className="card">
          <div className="card-header">
            <h3>Audit timeline</h3>
            <span className="hint">{events.length} event{events.length !== 1 ? "s" : ""}</span>
          </div>
          {events.length === 0 ? (
            <div className="empty-state">
              <div className="icon">📋</div>
              No events recorded yet.
            </div>
          ) : (
            <ul className="timeline">
              {events.map((e, i) => (
                <li key={i}>
                  <div className="tl-left">
                    <div className="tl-transition">
                      {e.from_state ? (
                        <span className={`badge ${e.from_state}`}>
                          {STATE_LABELS[e.from_state as string] ?? (e.from_state as string)}
                        </span>
                      ) : (
                        <span className="badge plain">—</span>
                      )}
                      <span className="tl-arrow">→</span>
                      <span className={`badge ${e.to_state}`}>
                        {STATE_LABELS[e.to_state as string] ?? (e.to_state as string)}
                      </span>
                    </div>
                    <div className="tl-meta">
                      {EVENT_LABELS[e.event_type as string] ?? (e.event_type as string)}
                      {e.actor_name ? (
                        <>
                          {" · "}
                          <span className="tl-actor">{e.actor_name as string}</span>
                        </>
                      ) : null}
                    </div>
                    {(e.payload as { photoUrl?: string } | null)?.photoUrl && (
                      <img
                        src={(e.payload as { photoUrl: string }).photoUrl}
                        alt="Condition photo"
                        style={{
                          marginTop: 8,
                          width: 96,
                          height: 96,
                          objectFit: "cover",
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--border)",
                        }}
                      />
                    )}
                  </div>
                  <div className="when">{fmtDateTime(e.occurred_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
