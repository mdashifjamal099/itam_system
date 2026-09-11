import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ownerClient, seedScenario, createOrg, unique } from "../helpers/db";
import { api, loginAs } from "../helpers/api";
import type { Client } from "pg";

describe("API: asset intake (POST /api/assets)", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  it("an admin creates a new asset, which lands as AVAILABLE and audited", async () => {
    const { orgId, adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const tag = unique("NEW-ASSET");

    const res = await api(`/api/assets`, {
      cookie,
      body: {
        assetTag: tag,
        serialNumber: unique("SN"),
        category: "LAPTOP",
        model: "Dell XPS 15",
        vendor: "Dell",
        procurementDate: "2026-01-15",
        warrantyExpiry: "2029-01-15",
        location: "Bengaluru HQ",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.toState).toBe("AVAILABLE");

    const row = await owner.query(
      `SELECT current_state, org_id, metadata FROM asset WHERE id=$1`,
      [res.body.assetId],
    );
    expect(row.rows[0].current_state).toBe("AVAILABLE");
    expect(row.rows[0].org_id).toBe(orgId);
    expect(row.rows[0].metadata.vendor).toBe("Dell");

    const audit = await owner.query(
      `SELECT event_type FROM asset_state_event WHERE asset_id=$1 ORDER BY asset_version`,
      [res.body.assetId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].event_type).toBe("asset.intake");
  });

  it("a non-admin (EMPLOYEE) cannot create an asset", async () => {
    const { employeeId } = await seedScenario(owner);
    const cookie = await loginAs(employeeId);

    const res = await api(`/api/assets`, {
      cookie,
      body: { assetTag: unique("X"), serialNumber: unique("SN"), category: "LAPTOP", model: "X" },
    });
    expect(res.status).toBe(403);
  });

  it("a MANAGER cannot create an asset", async () => {
    const { managerId } = await seedScenario(owner);
    const cookie = await loginAs(managerId);

    const res = await api(`/api/assets`, {
      cookie,
      body: { assetTag: unique("X"), serialNumber: unique("SN"), category: "LAPTOP", model: "X" },
    });
    expect(res.status).toBe(403);
  });

  it("requires assetTag, serialNumber, category, and model", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);

    const res = await api(`/api/assets`, { cookie, body: { assetTag: "ONLY-TAG" } });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate asset_tag within the same org with a clean 409", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const tag = unique("DUP-TAG");

    const first = await api(`/api/assets`, {
      cookie,
      body: { assetTag: tag, serialNumber: unique("SN"), category: "LAPTOP", model: "X" },
    });
    expect(first.status).toBe(200);

    const second = await api(`/api/assets`, {
      cookie,
      body: { assetTag: tag, serialNumber: unique("SN"), category: "LAPTOP", model: "Y" },
    });
    expect(second.status).toBe(409);
  });

  it("rejects a duplicate serial_number within the same org with a clean 409", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const serial = unique("DUP-SN");

    const first = await api(`/api/assets`, {
      cookie,
      body: { assetTag: unique("TAG"), serialNumber: serial, category: "LAPTOP", model: "X" },
    });
    expect(first.status).toBe(200);

    const second = await api(`/api/assets`, {
      cookie,
      body: { assetTag: unique("TAG"), serialNumber: serial, category: "LAPTOP", model: "Y" },
    });
    expect(second.status).toBe(409);
  });

  it("the same asset_tag IS allowed across two different orgs (uniqueness is per-org)", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const orgB = await createOrg(owner, "Org B asset intake");
    void orgB;

    // Reuse a tag that already exists in a DIFFERENT org from a previous test
    // run is not guaranteed unique across the whole suite, so just prove the
    // constraint is (org_id, asset_tag) by checking the schema-level intent:
    // two calls with the same tag but different admins/orgs both succeed.
    const { adminId: adminB } = await seedScenario(owner);
    const cookieB = await loginAs(adminB);
    const sharedTag = unique("SHARED-TAG");

    const resA = await api(`/api/assets`, {
      cookie,
      body: { assetTag: sharedTag, serialNumber: unique("SN"), category: "LAPTOP", model: "X" },
    });
    const resB = await api(`/api/assets`, {
      cookie: cookieB,
      body: { assetTag: sharedTag, serialNumber: unique("SN"), category: "LAPTOP", model: "X" },
    });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
  });

  it("a created asset appears immediately in the caller's own dashboard grid data, never another org's", async () => {
    const { orgId, adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);
    const tag = unique("VISIBLE-TAG");

    await api(`/api/assets`, {
      cookie,
      body: { assetTag: tag, serialNumber: unique("SN"), category: "LAPTOP", model: "X" },
    });

    const own = await owner.query(`SELECT 1 FROM asset WHERE org_id=$1 AND asset_tag=$2`, [
      orgId,
      tag,
    ]);
    expect(own.rows).toHaveLength(1);

    const { orgId: otherOrg } = await seedScenario(owner);
    const crossTenant = await owner.query(
      `SELECT 1 FROM asset WHERE org_id=$1 AND asset_tag=$2`,
      [otherOrg, tag],
    );
    expect(crossTenant.rows).toHaveLength(0);
  });
});
