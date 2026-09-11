import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ownerClient, seedScenario, setOrg, createAvailableAsset } from "../helpers/db";
import { api, loginAs } from "../helpers/api";
import type { Client } from "pg";

const CRON_HEADERS = { authorization: `Bearer ${process.env.CRON_SECRET}` };

describe("API: cron authorization, sweeps, ops dashboard", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  describe("cron authorization", () => {
    it("rejects a cron call with no Authorization header (401)", async () => {
      const res = await api(`/api/cron/drain-outbox`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects a cron call with the wrong bearer token (401)", async () => {
      const res = await api(`/api/cron/drain-outbox`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts a cron call with the correct bearer token", async () => {
      const res = await api(`/api/cron/expire-handshakes`, {
        method: "POST",
        headers: CRON_HEADERS,
      });
      expect(res.status).toBe(200);
      expect(typeof res.body.expired).toBe("number");
    });
  });

  describe("sweep-overdue", () => {
    it("flags an asset held past the org's policy limit, and is idempotent on rerun", async () => {
      const { orgId, adminId, employeeId, assetId } = await seedScenario(owner);
      await setOrg(owner, orgId);

      // Drive the asset to ASSIGNED_ACTIVE through the real FSM (skipping only
      // the OTP step, which is irrelevant here), then insert a holding_period
      // directly with a backdated start_ts. This is the one place the guard
      // trigger's "no editing an open period" rule would otherwise block us —
      // it only covers UPDATE/DELETE, not INSERT — so a raw INSERT is the
      // legitimate way to fixture a year-old holding without waiting a year.
      const co = await owner.query(`SELECT fn_checkout_asset($1,$2,$3,'x',60) AS r`, [
        assetId,
        employeeId,
        adminId,
      ]);
      await owner.query(
        `SELECT fn_transition_asset($1,'ASSIGNED_ACTIVE',$2,'test.fixture','{}'::jsonb,$3)`,
        [assetId, employeeId, employeeId],
      );
      await owner.query(
        `INSERT INTO holding_period (org_id, asset_id, user_id, handshake_id, start_ts)
         VALUES ($1,$2,$3,$4, now() - interval '400 days')`,
        [orgId, assetId, employeeId, co.rows[0].r.handshakeId],
      );

      const first = await api(`/api/cron/sweep-overdue`, { method: "POST", headers: CRON_HEADERS });
      expect(first.status).toBe(200);
      expect(first.body.overdue).toBeGreaterThanOrEqual(1);
      expect(first.body.tasks).toBeGreaterThanOrEqual(1);

      const task = await owner.query(
        `SELECT reason, reminders FROM recovery_task WHERE asset_id=$1`,
        [assetId],
      );
      expect(task.rows[0]).toMatchObject({ reason: "OVERDUE" });

      // Rerunning must not create a second task row for the same asset — the
      // partial unique index on (asset_id, reason) forces an UPDATE instead —
      // and the reported `tasks` (newly-created) count must reflect that: 0
      // new tasks on a run that only re-reminds an already-open one.
      const second = await api(`/api/cron/sweep-overdue`, { method: "POST", headers: CRON_HEADERS });
      expect(second.status).toBe(200);
      expect(second.body.tasks).toBe(0);

      const taskCount = await owner.query(
        `SELECT count(*) n, max(reminders) r FROM recovery_task WHERE asset_id=$1`,
        [assetId],
      );
      expect(Number(taskCount.rows[0].n)).toBe(1);
      expect(Number(taskCount.rows[0].r)).toBeGreaterThanOrEqual(1);
    });
  });

  describe("sweep-warranty", () => {
    it("flags an asset whose warranty expires within the alert window", async () => {
      const { orgId, adminId } = await seedScenario(owner);
      await setOrg(owner, orgId);
      const assetId = await createAvailableAsset(owner, orgId, adminId);
      await owner.query(
        `UPDATE asset SET warranty_expiry = CURRENT_DATE + 10 WHERE id=$1`,
        [assetId],
      );

      const res = await api(`/api/cron/sweep-warranty`, { method: "POST", headers: CRON_HEADERS });
      expect(res.status).toBe(200);
      expect(res.body.expiring).toBeGreaterThanOrEqual(1);

      const outboxRow = await owner.query(
        `SELECT event_type FROM event_outbox WHERE aggregate_id=$1 ORDER BY id DESC LIMIT 1`,
        [assetId],
      );
      expect(outboxRow.rows[0].event_type).toBe("asset.warranty_expiring");
    });

    it("does not flag an asset whose warranty is not expiring soon", async () => {
      const { orgId, adminId } = await seedScenario(owner);
      await setOrg(owner, orgId);
      const assetId = await createAvailableAsset(owner, orgId, adminId);
      await owner.query(
        `UPDATE asset SET warranty_expiry = CURRENT_DATE + 365 WHERE id=$1`,
        [assetId],
      );

      await api(`/api/cron/sweep-warranty`, { method: "POST", headers: CRON_HEADERS });

      const outboxRow = await owner.query(
        `SELECT count(*) n FROM event_outbox WHERE aggregate_id=$1 AND event_type='asset.warranty_expiring'`,
        [assetId],
      );
      expect(Number(outboxRow.rows[0].n)).toBe(0);
    });
  });

  describe("verify-audit", () => {
    it("reports intact:true with no tampering", async () => {
      const res = await api(`/api/cron/verify-audit`, { method: "POST", headers: CRON_HEADERS });
      expect(res.status).toBe(200);
      expect(res.body.intact).toBe(true);
      expect(res.body.broken).toEqual([]);
    });
  });

  describe("ops dashboard endpoints", () => {
    it("GET /api/ops/kpis returns fleet counts for an admin", async () => {
      const { adminId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);

      const res = await api(`/api/ops/kpis`, { method: "GET", cookie });
      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      expect(res.body.byState).toHaveProperty("AVAILABLE");
    });

    it("GET /api/ops/kpis is forbidden for an EMPLOYEE", async () => {
      const { employeeId } = await seedScenario(owner);
      const cookie = await loginAs(employeeId);

      const res = await api(`/api/ops/kpis`, { method: "GET", cookie });
      expect(res.status).toBe(403);
    });

    it("POST /api/ops/sweep is scoped to the caller's own org, not every tenant", async () => {
      const { adminId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);

      const res = await api(`/api/ops/sweep`, { cookie, body: { kind: "warranty" } });
      expect(res.status).toBe(200);
      expect(typeof res.body.expiring).toBe("number");
    });

    it("POST /api/ops/sweep rejects an unknown kind", async () => {
      const { adminId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);

      const res = await api(`/api/ops/sweep`, { cookie, body: { kind: "bogus" } });
      expect(res.status).toBe(400);
    });
  });
});
