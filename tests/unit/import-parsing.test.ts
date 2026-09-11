import { describe, it, expect } from "vitest";
import { normalizeKey, toDateString, normalizeRow, isRowComplete } from "../../lib/importParsing";

// Pure logic only — no DB, no HTTP server. These run in milliseconds and
// cover the header-aliasing / date-parsing rules the bulk import route
// depends on, independent of the plumbing around them.
describe("lib/importParsing (unit)", () => {
  describe("normalizeKey", () => {
    it.each([
      ["assetTag", "assetTag"],
      ["Asset Tag", "assetTag"],
      ["asset_tag", "assetTag"],
      ["ASSET-TAG", "assetTag"],
      ["Tag", "assetTag"],
      ["Serial Number", "serialNumber"],
      ["serial", "serialNumber"],
      ["Supplier", "vendor"],
      ["Manufacturer", "vendor"],
      ["vendor", "vendor"],
      ["Purchase Date", "procurementDate"],
      ["Warranty Expiry", "warrantyExpiry"],
      ["Location", "location"],
      ["Category", "category"],
      ["Model", "model"],
    ])("maps header %s -> %s", (input, expected) => {
      expect(normalizeKey(input)).toBe(expected);
    });

    it("returns null for a header it doesn't recognize", () => {
      expect(normalizeKey("Asset Owner's Cat")).toBeNull();
      expect(normalizeKey("random column")).toBeNull();
      expect(normalizeKey("")).toBeNull();
    });

    it("is case- and whitespace-insensitive", () => {
      expect(normalizeKey("  SERIAL NUMBER  ")).toBe("serialNumber");
      expect(normalizeKey("sErIaL_NuMbEr")).toBe("serialNumber");
    });
  });

  describe("toDateString", () => {
    it("returns null for null, undefined, and empty string", () => {
      expect(toDateString(null)).toBeNull();
      expect(toDateString(undefined)).toBeNull();
      expect(toDateString("")).toBeNull();
    });

    it("converts a JS Date to a plain YYYY-MM-DD string", () => {
      expect(toDateString(new Date(Date.UTC(2026, 2, 1)))).toBe("2026-03-01");
    });

    it("converts an Excel serial-date number using the 1899-12-30 epoch", () => {
      // 46082 is the serial for 2026-03-01 — the exact number Excel would
      // store for that calendar date, independent of any timezone.
      expect(toDateString(46082)).toBe("2026-03-01");
    });

    it("passes through an already-formatted date string untouched", () => {
      expect(toDateString("2026-03-01")).toBe("2026-03-01");
    });

    it("trims a string value and treats whitespace-only as absent", () => {
      expect(toDateString("  2026-03-01  ")).toBe("2026-03-01");
      expect(toDateString("   ")).toBeNull();
    });
  });

  describe("normalizeRow", () => {
    it("maps a full vendor-style row onto canonical field names", () => {
      const row = normalizeRow({
        "Asset Tag": "ACME-LT-100",
        "Serial Number": "SN-100",
        Category: "LAPTOP",
        Model: "ThinkPad T14",
        Supplier: "Lenovo",
        "Purchase Date": "2026-01-10",
        "Warranty Expiry": "2029-01-10",
        Location: "Mumbai Office",
      });
      expect(row).toEqual({
        assetTag: "ACME-LT-100",
        serialNumber: "SN-100",
        category: "LAPTOP",
        model: "ThinkPad T14",
        vendor: "Lenovo",
        procurementDate: "2026-01-10",
        warrantyExpiry: "2029-01-10",
        location: "Mumbai Office",
      });
    });

    it("drops columns it doesn't recognize instead of throwing", () => {
      const row = normalizeRow({
        "Asset Tag": "X-1",
        "Internal Note": "ignore me",
        "PO Number": "PO-555",
      });
      expect(row).toEqual({ assetTag: "X-1" });
    });

    it("omits a field entirely when the source cell is null (defval: null from the sheet reader)", () => {
      const row = normalizeRow({ "Asset Tag": "X-1", Vendor: null, Location: null });
      expect(row.vendor).toBeUndefined();
      expect(row.location).toBeUndefined();
    });

    it("stringifies and trims non-date values", () => {
      const row = normalizeRow({ "Asset Tag": "  X-1  ", Category: 123 as unknown as string });
      expect(row.assetTag).toBe("X-1");
      expect(row.category).toBe("123");
    });

    it("converts date-shaped columns through toDateString, not raw string coercion", () => {
      const row = normalizeRow({ "Asset Tag": "X-1", "Purchase Date": 46082 });
      expect(row.procurementDate).toBe("2026-03-01");
    });
  });

  describe("isRowComplete", () => {
    it("is true only when all four required fields are present", () => {
      expect(
        isRowComplete({ assetTag: "T", serialNumber: "S", category: "C", model: "M" }),
      ).toBe(true);
    });

    it.each([
      [{ serialNumber: "S", category: "C", model: "M" }],
      [{ assetTag: "T", category: "C", model: "M" }],
      [{ assetTag: "T", serialNumber: "S", model: "M" }],
      [{ assetTag: "T", serialNumber: "S", category: "C" }],
      [{}],
    ])("is false when a required field is missing: %j", (row) => {
      expect(isRowComplete(row)).toBe(false);
    });

    it("treats an empty string as missing, not present", () => {
      expect(
        isRowComplete({ assetTag: "", serialNumber: "S", category: "C", model: "M" }),
      ).toBe(false);
    });
  });
});
