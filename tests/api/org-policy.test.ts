import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ownerClient, seedScenario, setOrg } from "../helpers/db";
import { api, loginAs } from "../helpers/api";
import type { Client } from "pg";

const CRON_HEADERS = { authorization: `Bearer ${process.env.CRON_SECRET}` };

describe("API: org policy admin (/api/ops/policy)", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  it("GET returns the default policy for an org that has never customized it", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);

    const res = await api(`/api/ops/policy`, { method: "GET", cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      max_holding_days: 365,
      warranty_alert_days: 30,
      handshake_ttl_minutes: 1440,
    });
  });

  it("a non-admin (EMPLOYEE) cannot view or update policy", async () => {
    const { employeeId } = await seedScenario(owner);
    const cookie = await loginAs(employeeId);

    const get = await api(`/api/ops/policy`, { method: "GET", cookie });
    expect(get.status).toBe(403);

    const patch = await api(`/api/ops/policy`, {
      method: "PATCH",
      cookie,
      body: { maxHoldingDays: 10, warrantyAlertDays: 10, handshakeTtlMinutes: 10 },
    });
    expect(patch.status).toBe(403);
  });

  it("a MANAGER cannot update policy", async () => {
    const { managerId } = await seedScenario(owner);
    const cookie = await loginAs(managerId);

    const res = await api(`/api/ops/policy`, {
      method: "PATCH",
      cookie,
      body: { maxHoldingDays: 10, warrantyAlertDays: 10, handshakeTtlMinutes: 10 },
    });
    expect(res.status).toBe(403);
  });

  it("an update persists and is reflected on the next GET", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);

    const patch = await api(`/api/ops/policy`, {
      method: "PATCH",
      cookie,
      body: { maxHoldingDays: 7, warrantyAlertDays: 14, handshakeTtlMinutes: 60 },
    });
    expect(patch.status).toBe(200);

    const get = await api(`/api/ops/policy`, { method: "GET", cookie });
    expect(get.body).toMatchObject({
      max_holding_days: 7,
      warranty_alert_days: 14,
      handshake_ttl_minutes: 60,
    });
  });

  it("rejects zero, negative, and non-integer values with 400", async () => {
    const { adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);

    const cases = [
      { maxHoldingDays: 0, warrantyAlertDays: 10, handshakeTtlMinutes: 10 },
      { maxHoldingDays: -5, warrantyAlertDays: 10, handshakeTtlMinutes: 10 },
      { maxHoldingDays: 3.5, warrantyAlertDays: 10, handshakeTtlMinutes: 10 },
      { maxHoldingDays: 10, warrantyAlertDays: 10 }, // missing field
    ];
    for (const body of cases) {
      const res = await api(`/api/ops/policy`, { method: "PATCH", cookie, body });
      expect(res.status).toBe(400);
    }
  });

  it("the update is audited with before/after values", async () => {
    const { orgId, adminId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);

    await api(`/api/ops/policy`, {
      method: "PATCH",
      cookie,
      body: { maxHoldingDays: 21, warrantyAlertDays: 5, handshakeTtlMinutes: 30 },
    });

    const audit = await owner.query(
      `SELECT before, after FROM audit_log
       WHERE entity_type='org_policy' AND entity_id=$1 AND action='policy.updated'
       ORDER BY id DESC LIMIT 1`,
      [orgId],
    );
    expect(audit.rows[0].before.max_holding_days).toBe(365);
    expect(audit.rows[0].after.max_holding_days).toBe(21);
  });

  it("lowering max_holding_days actually changes sweep behavior for this org", async () => {
    const { orgId, adminId, employeeId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);
    const cookie = await loginAs(adminId);

    // Back-date a holding period to 10 days old (see cron.test.ts for why a
    // raw INSERT is the legitimate way to fixture this without waiting).
    const co = await owner.query(`SELECT fn_checkout_asset($1,$2,$3,'x',60) AS r`, [
      assetId,
      employeeId,
      adminId,
    ]);
    await owner.query(`SELECT fn_transition_asset($1,'ASSIGNED_ACTIVE',$2,'test.fixture','{}'::jsonb,$3)`, [
      assetId,
      employeeId,
      employeeId,
    ]);
    await owner.query(
      `INSERT INTO holding_period (org_id, asset_id, user_id, handshake_id, start_ts)
       VALUES ($1,$2,$3,$4, now() - interval '10 days')`,
      [orgId, assetId, employeeId, co.rows[0].r.handshakeId],
    );

    // Default policy (365 days) would never flag this.
    const beforePolicy = await api(`/api/cron/sweep-overdue`, { method: "POST", headers: CRON_HEADERS });
    expect(beforePolicy.status).toBe(200);
    const noTaskYet = await owner.query(`SELECT count(*) n FROM recovery_task WHERE asset_id=$1`, [
      assetId,
    ]);
    expect(Number(noTaskYet.rows[0].n)).toBe(0);

    // Lower the limit below 10 days — the same asset should now be caught.
    await api(`/api/ops/policy`, {
      method: "PATCH",
      cookie,
      body: { maxHoldingDays: 5, warrantyAlertDays: 30, handshakeTtlMinutes: 1440 },
    });
    const afterPolicy = await api(`/api/cron/sweep-overdue`, { method: "POST", headers: CRON_HEADERS });
    expect(afterPolicy.status).toBe(200);

    const task = await owner.query(
      `SELECT reason FROM recovery_task WHERE asset_id=$1 AND status <> 'RESOLVED'`,
      [assetId],
    );
    expect(task.rows).toHaveLength(1);
    expect(task.rows[0].reason).toBe("OVERDUE");
  });

  it("policy is isolated per tenant (RLS) — updating org A never affects org B's defaults", async () => {
    const { adminId: adminA } = await seedScenario(owner);
    const { adminId: adminB } = await seedScenario(owner);
    const cookieA = await loginAs(adminA);
    const cookieB = await loginAs(adminB);

    await api(`/api/ops/policy`, {
      method: "PATCH",
      cookie: cookieA,
      body: { maxHoldingDays: 999, warrantyAlertDays: 999, handshakeTtlMinutes: 999 },
    });

    const bPolicy = await api(`/api/ops/policy`, { method: "GET", cookie: cookieB });
    expect(bPolicy.body).toMatchObject({ max_holding_days: 365 });
  });
});
