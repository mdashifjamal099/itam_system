import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as XLSX from "xlsx";
import { ownerClient, seedScenario, unique } from "../helpers/db";
import { apiBase, loginAs } from "../helpers/api";
import type { Client } from "pg";

/** The import endpoint takes multipart/form-data, which the shared `api()`
 *  JSON helper doesn't support — upload directly with fetch + FormData. */
async function uploadImport(
  cookie: string,
  file: { name: string; content: string | Buffer; type: string },
) {
  const form = new FormData();
  const content = typeof file.content === "string" ? file.content : new Uint8Array(file.content);
  const blob = new Blob([content], { type: file.type });
  form.append("file", blob, file.name);

  const res = await fetch(`${apiBase()}/api/assets/import`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  const body = await res.json();
  return { status: res.status, body };
}

function csv(rows: string[][]): string {
  return rows.map((r) => r.join(",")).join("\n");
}

function xlsxBuffer(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Assets");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

describe("API: bulk asset import (POST /api/assets/import)", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  it("imports a valid CSV, creating each asset through the real FSM intake path", async () => {
    const { orgId, adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const tag1 = unique("CSV-A");
    const tag2 = unique("CSV-B");

    const file = csv([
      ["Asset Tag", "Serial Number", "Category", "Model", "Supplier", "Location"],
      [tag1, unique("SN"), "LAPTOP", "Dell Latitude", "Dell", "Mumbai Office"],
      [tag2, unique("SN"), "MONITOR", "LG UltraWide", "LG Electronics", "Mumbai Office"],
    ]);

    const res = await uploadImport(cookie, { name: "assets.csv", content: file, type: "text/csv" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.createdCount).toBe(2);
    expect(res.body.failed).toEqual([]);
    expect(res.body.created).toEqual(expect.arrayContaining([tag1, tag2]));

    const rows = await owner.query(
      `SELECT asset_tag, current_state, metadata->>'vendor' AS vendor
       FROM asset WHERE org_id=$1 AND asset_tag = ANY($2) ORDER BY asset_tag`,
      [orgId, [tag1, tag2]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.current_state === "AVAILABLE")).toBe(true);
    expect(rows.rows.find((r) => r.asset_tag === tag1)?.vendor).toBe("Dell");

    // Intake goes through fn_transition_asset like every other route, so it
    // must be audited exactly like a single manual creation would be.
    const events = await owner.query(
      `SELECT event_type FROM asset_state_event e
       JOIN asset a ON a.id = e.asset_id
       WHERE a.org_id=$1 AND a.asset_tag = $2`,
      [orgId, tag1],
    );
    expect(events.rows).toEqual([{ event_type: "asset.intake" }]);
  });

  it("imports a genuine .xlsx file, including vendor and dates", async () => {
    const { orgId, adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const tag = unique("XLSX-A");

    const buf = xlsxBuffer([
      {
        assetTag: tag,
        serialNumber: unique("SN"),
        category: "MOBILE",
        model: "iPhone 16",
        vendor: "Apple",
        procurementDate: new Date(Date.UTC(2026, 2, 1)),
        warrantyExpiry: new Date(Date.UTC(2028, 2, 1)),
        location: "Delhi Office",
      },
    ]);

    const res = await uploadImport(cookie, {
      name: "assets.xlsx",
      content: buf,
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(1);

    const row = await owner.query(
      `SELECT to_char(procurement_date,'YYYY-MM-DD') AS pd,
              to_char(warranty_expiry,'YYYY-MM-DD') AS we,
              metadata->>'vendor' AS vendor
       FROM asset WHERE org_id=$1 AND asset_tag=$2`,
      [orgId, tag],
    );
    expect(row.rows[0]).toEqual({ pd: "2026-03-01", we: "2028-03-01", vendor: "Apple" });
  });

  it("a duplicate tag within the same file fails that row only, the rest still import", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const tag = unique("DUP");
    const okTag = unique("OK");

    const file = csv([
      ["Asset Tag", "Serial Number", "Category", "Model"],
      [tag, unique("SN"), "LAPTOP", "Model A"],
      [okTag, unique("SN"), "LAPTOP", "Model B"],
      [tag, unique("SN"), "LAPTOP", "Model A (dup tag)"],
    ]);

    const res = await uploadImport(cookie, { name: "d.csv", content: file, type: "text/csv" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.createdCount).toBe(2);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0]).toMatchObject({ row: 4, assetTag: tag });
    expect(res.body.failed[0].error).toMatch(/already exists/i);
  });

  it("a row missing a required field is reported with its row number and does not block others", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const goodTag = unique("GOOD");

    const file = csv([
      ["Asset Tag", "Serial Number", "Category", "Model"],
      ["", unique("SN"), "LAPTOP", "No Tag Model"],
      [goodTag, unique("SN"), "LAPTOP", "Fine Model"],
    ]);

    const res = await uploadImport(cookie, { name: "m.csv", content: file, type: "text/csv" });
    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(1);
    expect(res.body.created).toEqual([goodTag]);
    expect(res.body.failed).toEqual([
      { row: 2, assetTag: null, error: expect.stringMatching(/missing required field/i) },
    ]);
  });

  it("an EMPLOYEE cannot use the bulk import endpoint (403)", async () => {
    const { employeeId } = await seedScenario(owner);
    const cookie = await loginAs(employeeId);

    const file = csv([
      ["Asset Tag", "Serial Number", "Category", "Model"],
      [unique("X"), unique("SN"), "LAPTOP", "X"],
    ]);
    const res = await uploadImport(cookie, { name: "x.csv", content: file, type: "text/csv" });
    expect(res.status).toBe(403);
  });

  it("a MANAGER cannot use the bulk import endpoint (403)", async () => {
    const { managerId } = await seedScenario(owner);
    const cookie = await loginAs(managerId);

    const file = csv([
      ["Asset Tag", "Serial Number", "Category", "Model"],
      [unique("X"), unique("SN"), "LAPTOP", "X"],
    ]);
    const res = await uploadImport(cookie, { name: "x.csv", content: file, type: "text/csv" });
    expect(res.status).toBe(403);
  });

  it("an unauthenticated request is rejected", async () => {
    const file = csv([
      ["Asset Tag", "Serial Number", "Category", "Model"],
      [unique("X"), unique("SN"), "LAPTOP", "X"],
    ]);
    const form = new FormData();
    form.append("file", new Blob([file], { type: "text/csv" }), "x.csv");
    const res = await fetch(`${apiBase()}/api/assets/import`, { method: "POST", body: form });
    expect([401, 403]).toContain(res.status);
  });

  it("rejects a request with no file field", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const form = new FormData();
    form.append("notfile", "irrelevant");
    const res = await fetch(`${apiBase()}/api/assets/import`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a file with no data rows", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const file = csv([["Asset Tag", "Serial Number", "Category", "Model"]]);
    const res = await uploadImport(cookie, { name: "empty.csv", content: file, type: "text/csv" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no data rows/i);
  });

  it("a corrupt/unparseable file degrades to a clean 400, never a 500", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    // Garbage bytes: not valid CSV text, not a real xlsx zip container. SheetJS
    // doesn't throw on this — it parses to zero usable rows, which the route
    // then rejects the same way it rejects a header-only file.
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
    const res = await uploadImport(cookie, {
      name: "garbage.xlsx",
      content: garbage,
      type: "application/octet-stream",
    });
    expect(res.status).toBe(400);
  });

  it("imported assets are scoped to the importing admin's own org, never cross-tenant", async () => {
    const { orgId, adminId } = await seedScenario(owner);
    const { orgId: otherOrgId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const tag = unique("SCOPED");

    const file = csv([
      ["Asset Tag", "Serial Number", "Category", "Model"],
      [tag, unique("SN"), "LAPTOP", "X"],
    ]);
    await uploadImport(cookie, { name: "s.csv", content: file, type: "text/csv" });

    const own = await owner.query(`SELECT 1 FROM asset WHERE org_id=$1 AND asset_tag=$2`, [
      orgId,
      tag,
    ]);
    expect(own.rows).toHaveLength(1);
    const cross = await owner.query(`SELECT 1 FROM asset WHERE org_id=$1 AND asset_tag=$2`, [
      otherOrgId,
      tag,
    ]);
    expect(cross.rows).toHaveLength(0);
  });

  it("recognizes common vendor header variants (Tag/Serial/Manufacturer) case-insensitively", async () => {
    const { orgId, adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const tag = unique("ALIAS");

    const file = csv([
      ["TAG", "serial", "CATEGORY", "model", "MANUFACTURER"],
      [tag, unique("SN"), "PERIPHERAL", "Webcam", "Logitech"],
    ]);
    const res = await uploadImport(cookie, { name: "a.csv", content: file, type: "text/csv" });
    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(1);

    const row = await owner.query(
      `SELECT metadata->>'vendor' AS vendor FROM asset WHERE org_id=$1 AND asset_tag=$2`,
      [orgId, tag],
    );
    expect(row.rows[0].vendor).toBe("Logitech");
  });
});
