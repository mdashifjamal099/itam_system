"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type ImportResult = {
  total: number;
  createdCount: number;
  failed: { row: number; assetTag: string | null; error: string }[];
};

const TEMPLATE_ROWS = [
  ["Asset Tag", "Serial Number", "Category", "Model", "Vendor", "Procurement Date", "Warranty Expiry", "Location"],
  ["ACME-LT-101", "C02XK9HTJGH1", "LAPTOP", "MacBook Pro 14\"", "Apple", "2026-01-15", "2029-01-15", "Bengaluru HQ"],
  ["ACME-MB-201", "F2LXK9HTJGH2", "MOBILE", "iPhone 15", "Apple", "2026-02-01", "2028-02-01", "Bengaluru HQ"],
];

function downloadTemplate() {
  const csv = TEMPLATE_ROWS.map((row) =>
    row.map((cell) => (cell.includes(",") ? `"${cell}"` : cell)).join(","),
  ).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "asset-import-template.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export function BulkImportForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setFile(null);
    setError(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/assets/import", { method: "POST", body: formData });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error);
      return;
    }
    setResult(body as ImportResult);
    // No router.refresh() yet — same reason as AddAssetForm/CreateUserForm:
    // let the admin read the per-row results before the list underneath
    // re-renders. The Done button below refreshes once they have.
  }

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        Bulk import (CSV/Excel)
      </button>
    );
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <div className="card-header">
        <h3>Bulk import assets</h3>
      </div>

      {result ? (
        <div>
          <p className="msg" style={{ marginBottom: 8 }}>
            Created <strong>{result.createdCount}</strong> of {result.total} asset(s).
          </p>
          {result.failed.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: "auto", marginBottom: 8 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Asset tag</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.failed.map((f) => (
                    <tr key={f.row}>
                      <td>{f.row}</td>
                      <td>{f.assetTag ?? "—"}</td>
                      <td className="hint-text">{f.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button
            className="btn large primary"
            onClick={() => {
              reset();
              setOpen(false);
              router.refresh();
            }}
          >
            Done
          </button>
        </div>
      ) : (
        <>
          <p className="hint-text" style={{ marginBottom: 10 }}>
            Upload a CSV or Excel file from your hardware vendor. Expected columns: asset tag, serial
            number, category, model, vendor, procurement date, warranty expiry, location. Column names
            are matched case-insensitively (e.g. &quot;Supplier&quot; also works for vendor).
          </p>
          <button
            type="button"
            className="btn"
            style={{ marginBottom: 12 }}
            onClick={downloadTemplate}
          >
            Download CSV template
          </button>
          <div className="field">
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="action-row">
            <button className="btn large primary" disabled={busy || !file} onClick={submit}>
              {busy ? "Importing…" : "Import"}
            </button>
            <button
              className="btn large"
              disabled={busy}
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
          {error && <p className="msg error">{error}</p>}
        </>
      )}
    </div>
  );
}
