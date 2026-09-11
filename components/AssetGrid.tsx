"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export type AssetRow = {
  id: string;
  asset_tag: string;
  model: string;
  category: string;
  current_state: string;
  holder_name: string | null;
};

const STATES = [
  "AVAILABLE",
  "PENDING_ACCEPTANCE",
  "ASSIGNED_ACTIVE",
  "UNDER_INSPECTION",
  "MAINTENANCE",
  "LOST",
  "RETIRED",
  "PROCURED",
];

const STATE_LABELS: Record<string, string> = {
  AVAILABLE: "Available",
  ASSIGNED_ACTIVE: "Assigned",
  PENDING_ACCEPTANCE: "Pending",
  UNDER_INSPECTION: "Inspection",
  MAINTENANCE: "Maintenance",
  LOST: "Lost",
  RETIRED: "Retired",
  PROCURED: "Procured",
};

/** Client-side search/filter over the asset list already fetched server-side —
 *  no new API surface, just filtering data that was already loaded. */
export function AssetGrid({ assets }: { assets: AssetRow[] }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState("ALL");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((a) => {
      if (state !== "ALL" && a.current_state !== state) return false;
      if (!q) return true;
      return (
        a.asset_tag.toLowerCase().includes(q) ||
        a.model.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        (a.holder_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [assets, query, state]);

  const availableStates = STATES.filter((s) => assets.some((a) => a.current_state === s));

  return (
    <>
      <div className="toolbar">
        <input
          id="asset-search"
          className="search-input"
          placeholder="Search by tag, model, category, or holder…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          id="asset-state-filter"
          className="filter-select"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="ALL">All states</option>
          {availableStates.map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s] ?? s}
            </option>
          ))}
        </select>
        <span
          className="hint-text"
          style={{ whiteSpace: "nowrap" }}
        >
          {filtered.length} / {assets.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="icon">🔍</div>
            {assets.length === 0
              ? "No assets in this organization yet."
              : "No assets match your search."}
          </div>
        </div>
      ) : (
        <div className="asset-grid">
          {filtered.map((a) => (
            <Link key={a.id} href={`/assets/${a.id}`} className="asset-tile">
              <div className="tile-top">
                <span className="category">{a.category}</span>
                <span className={`badge ${a.current_state}`}>
                  {STATE_LABELS[a.current_state] ?? a.current_state}
                </span>
              </div>
              <div className="tag">{a.asset_tag}</div>
              <div className="model">{a.model}</div>
              {a.holder_name ? (
                <div className="holder-line">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                  </svg>
                  {a.holder_name}
                </div>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
