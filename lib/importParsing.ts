// Pure parsing logic for the bulk asset import (CSV/Excel) — split out from
// app/api/assets/import/route.ts so it can be unit tested without spinning up
// a server or a database.

// Vendors export inventory sheets with all kinds of header spellings — accept
// the common variants instead of forcing every vendor file to be reformatted.
const HEADER_ALIASES: Record<string, string> = {
  assettag: "assetTag",
  asset_tag: "assetTag",
  tag: "assetTag",
  serialnumber: "serialNumber",
  serial_number: "serialNumber",
  serial: "serialNumber",
  category: "category",
  model: "model",
  vendor: "vendor",
  supplier: "vendor",
  manufacturer: "vendor",
  procurementdate: "procurementDate",
  procurement_date: "procurementDate",
  purchasedate: "procurementDate",
  warrantyexpiry: "warrantyExpiry",
  warranty_expiry: "warrantyExpiry",
  warrantyexpirydate: "warrantyExpiry",
  location: "location",
};

export function normalizeKey(key: string): string | null {
  const flat = key.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/_/g, "");
  const withUnderscoreCheck = key.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return HEADER_ALIASES[flat] ?? HEADER_ALIASES[withUnderscoreCheck] ?? null;
}

export function toDateString(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    // Excel serial date (days since 1899-12-30) — only reached when a sheet
    // stores a date as a bare number without a date format SheetJS's
    // cellDates option can recognize.
    const epoch = new Date(Date.UTC(1899, 11, 30));
    epoch.setUTCDate(epoch.getUTCDate() + value);
    return epoch.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  return s === "" ? null : s;
}

export type ImportRow = {
  assetTag?: string;
  serialNumber?: string;
  category?: string;
  model?: string;
  vendor?: string;
  procurementDate?: string | null;
  warrantyExpiry?: string | null;
  location?: string;
};

/** Maps one raw parsed sheet row (arbitrary header spellings) onto our canonical field names. */
export function normalizeRow(raw: Record<string, unknown>): ImportRow {
  const row: ImportRow = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = normalizeKey(key);
    if (!field) continue;
    if (field === "procurementDate" || field === "warrantyExpiry") {
      (row as Record<string, unknown>)[field] = toDateString(value);
    } else if (value != null) {
      (row as Record<string, unknown>)[field] = String(value).trim();
    }
  }
  return row;
}

export type CompleteImportRow = ImportRow & {
  assetTag: string;
  serialNumber: string;
  category: string;
  model: string;
};

export function isRowComplete(row: ImportRow): row is CompleteImportRow {
  return Boolean(row.assetTag && row.serialNumber && row.category && row.model);
}
