"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const CATEGORIES = ["LAPTOP", "MOBILE", "PERIPHERAL", "MONITOR", "TABLET", "OTHER"];

export function AddAssetForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [assetTag, setAssetTag] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [model, setModel] = useState("");
  const [vendor, setVendor] = useState("");
  const [procurementDate, setProcurementDate] = useState("");
  const [warrantyExpiry, setWarrantyExpiry] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setAssetTag("");
    setSerialNumber("");
    setCategory(CATEGORIES[0]);
    setModel("");
    setVendor("");
    setProcurementDate("");
    setWarrantyExpiry("");
    setLocation("");
    setError(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assetTag,
        serialNumber,
        category,
        model,
        vendor: vendor || undefined,
        procurementDate: procurementDate || undefined,
        warrantyExpiry: warrantyExpiry || undefined,
        location: location || undefined,
      }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(body.error);
      return;
    }
    reset();
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button className="btn primary" onClick={() => setOpen(true)}>
        + Add asset
      </button>
    );
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <div className="card-header">
        <h3>Add asset</h3>
      </div>

      <div className="field">
        <label>Asset tag</label>
        <input value={assetTag} onChange={(e) => setAssetTag(e.target.value)} placeholder="ACME-LT-005" />
      </div>
      <div className="field">
        <label>Serial number</label>
        <input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
      </div>
      <div className="field">
        <label>Category</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Model</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder='MacBook Pro 14"' />
      </div>
      <div className="field">
        <label>Vendor</label>
        <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Apple (optional)" />
      </div>
      <div className="field">
        <label>Procurement date</label>
        <input type="date" value={procurementDate} onChange={(e) => setProcurementDate(e.target.value)} />
      </div>
      <div className="field">
        <label>Warranty expiry</label>
        <input type="date" value={warrantyExpiry} onChange={(e) => setWarrantyExpiry(e.target.value)} />
      </div>
      <div className="field">
        <label>Location</label>
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Bengaluru HQ" />
      </div>

      <div className="action-row">
        <button
          className="btn large primary"
          disabled={busy || !assetTag || !serialNumber || !model}
          onClick={submit}
        >
          {busy ? "Adding…" : "Add asset"}
        </button>
        <button className="btn large" disabled={busy} onClick={() => { reset(); setOpen(false); }}>
          Cancel
        </button>
      </div>
      {error && <p className="msg error">{error}</p>}
    </div>
  );
}
