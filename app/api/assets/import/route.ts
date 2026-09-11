import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";
import { normalizeRow, isRowComplete, type ImportRow } from "@/lib/importParsing";

const MAX_ROWS = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "File is too large (max 5MB)" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let sheetRows: Record<string, unknown>[];
    try {
      // cellDates makes SheetJS do its own (correct) serial-number-to-date
      // conversion and hand back real Date objects, instead of us reimplementing
      // that math on raw serial numbers — which drifted a day off under a
      // non-UTC system timezone during testing.
      const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        return NextResponse.json({ error: "The file has no sheets" }, { status: 400 });
      }
      sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
    } catch {
      return NextResponse.json(
        { error: "Could not read that file — is it a valid CSV or Excel file?" },
        { status: 400 },
      );
    }

    if (sheetRows.length === 0) {
      return NextResponse.json({ error: "The file has no data rows" }, { status: 400 });
    }
    if (sheetRows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Too many rows (max ${MAX_ROWS} per import)` },
        { status: 400 },
      );
    }

    const rows: ImportRow[] = sheetRows.map(normalizeRow);

    const created: string[] = [];
    const failed: { row: number; assetTag: string | null; error: string }[] = [];

    // Sequential, one fn_create_asset call per row, each its own transaction —
    // a bad row (duplicate tag, missing field) must not roll back the good
    // rows before or after it in the same file.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNumber = i + 2; // header is row 1 in the source file
      if (!isRowComplete(r)) {
        failed.push({
          row: rowNumber,
          assetTag: r.assetTag ?? null,
          error: "Missing required field (assetTag, serialNumber, category, model)",
        });
        continue;
      }
      try {
        await withTenant(
          actor.org_id,
          sql`SELECT fn_create_asset(
                ${actor.org_id}::uuid, ${actor.id}::uuid, ${r.assetTag}, ${r.serialNumber},
                ${r.category}, ${r.model}, ${r.vendor ?? null},
                ${r.procurementDate ?? null}::date, ${r.warrantyExpiry ?? null}::date,
                ${r.location ?? null}
              ) AS result`,
        );
        created.push(r.assetTag);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({
          row: rowNumber,
          assetTag: r.assetTag,
          error: message.includes("duplicate key")
            ? "An asset with this tag or serial number already exists"
            : "Could not create this asset",
        });
      }
    }

    return NextResponse.json({
      total: rows.length,
      createdCount: created.length,
      created,
      failed,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
