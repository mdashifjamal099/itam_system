import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { ownerClient, seedScenario, setOrg, createUser } from "../helpers/db";
import { api, loginAs } from "../helpers/api";
import type { Client } from "pg";

function signHris(body: string) {
  return "sha256=" + createHmac("sha256", process.env.HRIS_WEBHOOK_SECRET!).update(body).digest("hex");
}

describe("API: offboarding, recovery tasks, HRIS webhook", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  it("manual offboard flags a held asset for recovery, visible via /api/ops/recovery-tasks", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const employeeCookie = await loginAs(employeeId);

    const co = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId },
    });
    await api(`/api/custody/accept`, {
      cookie: employeeCookie,
      body: { handshakeId: co.body.handshakeId, otp: co.body.devOtp },
    });

    const offboard = await api(`/api/ops/offboard`, {
      cookie: adminCookie,
      body: { userId: employeeId, lastWorkingDay: "2026-12-01" },
    });
    expect(offboard.status).toBe(200);
    expect(offboard.body.recoveryTasks).toBe(1);
    expect(offboard.body.assets).toEqual([assetId]);

    const assetTag = (await owner.query(`SELECT asset_tag FROM asset WHERE id=$1`, [assetId]))
      .rows[0].asset_tag;

    const tasks = await api<{ tasks: { asset_tag: string; reason: string; holder_name: string }[] }>(
      `/api/ops/recovery-tasks`,
      { method: "GET", cookie: adminCookie },
    );
    expect(tasks.status).toBe(200);
    const match = tasks.body.tasks.find((t) => t.asset_tag === assetTag);
    expect(match).toMatchObject({ reason: "OFFBOARDING", holder_name: "Employee" });
  });

  it("recovery task auto-resolves when the offboarded holder's asset is returned", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const employeeCookie = await loginAs(employeeId);

    const co = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId },
    });
    await api(`/api/custody/accept`, {
      cookie: employeeCookie,
      body: { handshakeId: co.body.handshakeId, otp: co.body.devOtp },
    });
    await api(`/api/ops/offboard`, { cookie: adminCookie, body: { userId: employeeId } });

    const openBefore = await owner.query(
      `SELECT status FROM recovery_task WHERE asset_id=$1`,
      [assetId],
    );
    expect(openBefore.rows[0].status).not.toBe("RESOLVED");

    // The ADMIN performs the return, not the employee. Offboarding sets
    // employment_status='TERMINATED', and getActor() rejects any non-ACTIVE
    // user — so the terminated employee is locked out by design. In the real
    // workflow IT receives the device and records the return on their behalf,
    // which the route's RBAC already permits.
    const returned = await api(`/api/assets/${assetId}/return`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(returned.status).toBe(200);

    const after = await owner.query(`SELECT status FROM recovery_task WHERE asset_id=$1`, [
      assetId,
    ]);
    expect(after.rows[0].status).toBe("RESOLVED");
  });

  it("a terminated employee is locked out, but the admin can still complete the recovery", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const employeeCookie = await loginAs(employeeId);

    const co = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId },
    });
    await api(`/api/custody/accept`, {
      cookie: employeeCookie,
      body: { handshakeId: co.body.handshakeId, otp: co.body.devOtp },
    });
    await api(`/api/ops/offboard`, { cookie: adminCookie, body: { userId: employeeId } });

    // The asset is still ASSIGNED_ACTIVE and this user is still its holder, so
    // the ONLY reason this is refused is the employment-status lockout. An
    // active holder returning their own asset succeeds (covered in
    // checkout-flow.test.ts), which is what makes this a meaningful assertion.
    const employeeReturn = await api(`/api/assets/${assetId}/return`, {
      method: "POST",
      cookie: employeeCookie,
    });
    expect(employeeReturn.status).toBe(403);

    const employeeTimeline = await api(`/api/assets/${assetId}/timeline`, {
      method: "GET",
      cookie: employeeCookie,
    });
    expect(employeeTimeline.status).toBe(403);

    // The recovery workflow still completes — IT records the return.
    const adminReturn = await api(`/api/assets/${assetId}/return`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(adminReturn.status).toBe(200);

    const task = await owner.query(`SELECT status FROM recovery_task WHERE asset_id=$1`, [assetId]);
    expect(task.rows[0].status).toBe("RESOLVED");
  });

  it("HRIS webhook: offboarding an employee identified by employee_id flags their assets", async () => {
    const { orgId, adminId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);
    const employeeId = await createUser(owner, orgId, { role: "EMPLOYEE" });
    const employeeRow = await owner.query(`SELECT employee_id FROM app_user WHERE id=$1`, [
      employeeId,
    ]);
    const employeeCode = employeeRow.rows[0].employee_id;

    const adminCookie = await loginAs(adminId);
    const employeeCookie = await loginAs(employeeId);
    const co = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId },
    });
    await api(`/api/custody/accept`, {
      cookie: employeeCookie,
      body: { handshakeId: co.body.handshakeId, otp: co.body.devOtp },
    });

    const payload = JSON.stringify({
      event: "employee.terminated",
      orgId,
      employeeId: employeeCode,
      lastWorkingDay: "2026-11-30",
    });

    const res = await api(`/api/webhooks/hris`, {
      rawBody: payload,
      headers: { "x-hris-signature": signHris(payload) },
    });
    expect(res.status).toBe(200);
    expect(res.body.recoveryTasks).toBe(1);

    const asset = await owner.query(`SELECT current_state FROM asset WHERE id=$1`, [assetId]);
    // Offboarding does NOT force a return — the asset stays ASSIGNED_ACTIVE.
    expect(asset.rows[0].current_state).toBe("ASSIGNED_ACTIVE");
  });

  it("HRIS webhook rejects a request with an invalid signature", async () => {
    const payload = JSON.stringify({ event: "employee.terminated", orgId: "x", employeeId: "y" });
    const res = await api(`/api/webhooks/hris`, {
      rawBody: payload,
      headers: { "x-hris-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000" },
    });
    expect(res.status).toBe(401);
  });

  it("HRIS webhook rejects a request with no signature header at all", async () => {
    const payload = JSON.stringify({ event: "employee.terminated", orgId: "x", employeeId: "y" });
    const res = await api(`/api/webhooks/hris`, { rawBody: payload });
    expect(res.status).toBe(401);
  });

  it("HRIS webhook ignores events it does not recognize", async () => {
    const payload = JSON.stringify({ event: "employee.promoted", orgId: "x", employeeId: "y" });
    const res = await api(`/api/webhooks/hris`, {
      rawBody: payload,
      headers: { "x-hris-signature": signHris(payload) },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
  });
});
