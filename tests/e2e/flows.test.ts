import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { ownerClient, seedScenario, setOrg, createUser } from "../helpers/db";
import { api, loginAs } from "../helpers/api";
import type { Client } from "pg";

const CRON_HEADERS = { authorization: `Bearer ${process.env.CRON_SECRET}` };

function signHris(body: string) {
  return "sha256=" + createHmac("sha256", process.env.HRIS_WEBHOOK_SECRET!).update(body).digest("hex");
}

describe("End-to-end user flows", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  it("Admin checkout -> Employee OTP acceptance -> Employee return -> Admin inspection", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const admin = await loginAs(adminId);
    const employee = await loginAs(employeeId);

    // Only ASSET_ADMIN/SUPER_ADMIN may initiate a checkout.
    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie: admin,
      body: { toUserId: employeeId },
    });
    expect(checkout.status).toBe(200);
    expect(checkout.body.toState).toBe("PENDING_ACCEPTANCE");

    // The employee cannot see the audit timeline, but CAN see enough to know
    // an asset is waiting on them (state is visible to anyone who can fetch
    // the asset's own row through the app; timeline is admin/manager-only).
    const pendingView = await api(`/api/assets/${assetId}/timeline`, {
      method: "GET",
      cookie: employee,
    });
    expect(pendingView.status).toBe(403);

    // Only the OTP recipient may accept custody.
    const accept = await api(`/api/custody/accept`, {
      cookie: employee,
      body: { handshakeId: checkout.body.handshakeId, otp: checkout.body.devOtp },
    });
    expect(accept.status).toBe(200);
    expect(accept.body.toState).toBe("ASSIGNED_ACTIVE");

    // The current holder may return their own asset.
    const ret = await api(`/api/assets/${assetId}/return`, { method: "POST", cookie: employee });
    expect(ret.status).toBe(200);
    expect(ret.body.toState).toBe("UNDER_INSPECTION");
    expect(ret.body.holdingDays).toBeGreaterThanOrEqual(0);

    // Only ASSET_ADMIN/SUPER_ADMIN may complete an inspection.
    const inspect = await api(`/api/assets/${assetId}/inspect`, {
      cookie: admin,
      body: { condition: "GOOD", notes: "no visible wear" },
    });
    expect(inspect.status).toBe(200);
    expect(inspect.body.toState).toBe("AVAILABLE");

    // The full story is reconstructable from the timeline afterwards, in order.
    // Timeline is admin/manager-only, so read it back as the admin.
    const timeline = await api<{
      events: { event_type: string; from_state: string | null; to_state: string }[];
    }>(`/api/assets/${assetId}/timeline`, { method: "GET", cookie: admin });
    expect(timeline.status).toBe(200);
    const transitions = timeline.body.events
      .slice()
      .reverse()
      .map((e) => `${e.from_state ?? "∅"}->${e.to_state}`);
    expect(transitions).toEqual([
      "PROCURED->AVAILABLE", // intake — every asset starts life as PROCURED
      "AVAILABLE->PENDING_ACCEPTANCE",
      "PENDING_ACCEPTANCE->ASSIGNED_ACTIVE",
      "ASSIGNED_ACTIVE->UNDER_INSPECTION",
      "UNDER_INSPECTION->AVAILABLE",
    ]);
  });

  it("Lost -> recover -> inspect", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const admin = await loginAs(adminId);
    const employee = await loginAs(employeeId);

    // Only ASSET_ADMIN/SUPER_ADMIN may initiate a checkout.
    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie: admin,
      body: { toUserId: employeeId },
    });
    await api(`/api/custody/accept`, {
      cookie: employee,
      body: { handshakeId: checkout.body.handshakeId, otp: checkout.body.devOtp },
    });

    // The current holder may report their own asset lost.
    const lost = await api(`/api/assets/${assetId}/lost`, {
      cookie: employee,
      body: { notes: "left in a taxi" },
    });
    expect(lost.status).toBe(200);
    expect(lost.body.toState).toBe("LOST");

    // Custody closed the instant it was declared lost, not left dangling open.
    const holding = await owner.query(
      `SELECT end_ts FROM holding_period WHERE asset_id=$1 ORDER BY start_ts DESC LIMIT 1`,
      [assetId],
    );
    expect(holding.rows[0].end_ts).not.toBeNull();

    // Only ASSET_ADMIN/SUPER_ADMIN may mark a lost asset recovered.
    const recover = await api(`/api/assets/${assetId}/recover`, {
      cookie: admin,
      body: { notes: "found by a stranger, returned to office" },
    });
    expect(recover.status).toBe(200);
    expect(recover.body.toState).toBe("UNDER_INSPECTION");

    // Only ASSET_ADMIN/SUPER_ADMIN may complete an inspection.
    const inspect = await api(`/api/assets/${assetId}/inspect`, {
      cookie: admin,
      body: { condition: "GOOD" },
    });
    expect(inspect.status).toBe(200);
    expect(inspect.body.toState).toBe("AVAILABLE");

    const finalState = await owner.query(`SELECT current_state FROM asset WHERE id=$1`, [
      assetId,
    ]);
    expect(finalState.rows[0].current_state).toBe("AVAILABLE");
  });

  it("HRIS offboarding -> recovery obligation -> asset return -> recovery task resolved", async () => {
    const { orgId, adminId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);
    const employeeId = await createUser(owner, orgId, { role: "EMPLOYEE" });
    const employeeCode = (
      await owner.query(`SELECT employee_id FROM app_user WHERE id=$1`, [employeeId])
    ).rows[0].employee_id;

    const admin = await loginAs(adminId);
    const employee = await loginAs(employeeId);

    // Only ASSET_ADMIN/SUPER_ADMIN may initiate a checkout.
    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie: admin,
      body: { toUserId: employeeId },
    });
    await api(`/api/custody/accept`, {
      cookie: employee,
      body: { handshakeId: checkout.body.handshakeId, otp: checkout.body.devOtp },
    });

    // HR system fires the webhook — no admin action in our app at all.
    const payload = JSON.stringify({
      event: "employee.terminated",
      orgId,
      employeeId: employeeCode,
      lastWorkingDay: "2026-12-15",
    });
    const webhook = await api(`/api/webhooks/hris`, {
      rawBody: payload,
      headers: { "x-hris-signature": signHris(payload) },
    });
    expect(webhook.status).toBe(200);
    expect(webhook.body.recoveryTasks).toBe(1);

    // Offboarding does not force a return: the asset is still with the
    // (now-terminated) employee until someone actually hands it back.
    const midState = await owner.query(`SELECT current_state FROM asset WHERE id=$1`, [assetId]);
    expect(midState.rows[0].current_state).toBe("ASSIGNED_ACTIVE");

    const openTask = await owner.query(
      `SELECT status, reason FROM recovery_task WHERE asset_id=$1`,
      [assetId],
    );
    expect(openTask.rows[0]).toMatchObject({ status: "OPEN", reason: "OFFBOARDING" });

    // Confirms an unrelated sweep run doesn't disturb the existing offboarding
    // task (this asset is freshly checked out, nowhere near the overdue
    // threshold, so the sweep should not touch it at all).
    await api(`/api/cron/sweep-overdue`, { method: "POST", headers: CRON_HEADERS });
    const taskCount = await owner.query(
      `SELECT count(*) n FROM recovery_task WHERE asset_id=$1 AND status <> 'RESOLVED'`,
      [assetId],
    );
    expect(Number(taskCount.rows[0].n)).toBe(1);

    // IT records the return, not the employee: offboarding set their status to
    // TERMINATED and getActor() rejects non-ACTIVE users, so the departing
    // employee is already locked out at this point (asserted directly in
    // tests/api/offboarding.test.ts). The route's RBAC lets an admin return on
    // another user's behalf, which is how the physical handover actually works.
    const ret = await api(`/api/assets/${assetId}/return`, { method: "POST", cookie: admin });
    expect(ret.status).toBe(200);

    const resolvedTask = await owner.query(
      `SELECT status FROM recovery_task WHERE asset_id=$1`,
      [assetId],
    );
    expect(resolvedTask.rows[0].status).toBe("RESOLVED");
  });
});
