import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ownerClient, appClient, setOrg, seedScenario } from "../helpers/db";
import type { Client } from "pg";

describe("Audit log: creation, immutability, hash chain", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  it("writes an audit_log row for every state transition, in the same transaction", async () => {
    const { orgId, adminId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    const before = await owner.query(`SELECT count(*) n FROM audit_log WHERE entity_id=$1`, [
      assetId,
    ]);

    await owner.query(`SELECT fn_transition_asset($1,'MAINTENANCE',$2,'test.audit')`, [
      assetId,
      adminId,
    ]);

    const totalAfter = await owner.query(`SELECT count(*) n FROM audit_log WHERE entity_id=$1`, [
      assetId,
    ]);
    expect(Number(totalAfter.rows[0].n)).toBe(Number(before.rows[0].n) + 1);

    const latest = await owner.query(
      `SELECT action, before, after FROM audit_log WHERE entity_id=$1 ORDER BY id DESC LIMIT 1`,
      [assetId],
    );
    expect(latest.rows[0].action).toBe("test.audit");
    expect(latest.rows[0].after.state).toBe("MAINTENANCE");
  });

  it("chains row_hash to the previous row's hash for the same entity", async () => {
    const { orgId, adminId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    await owner.query(`SELECT fn_transition_asset($1,'MAINTENANCE',$2,'test.h1')`, [
      assetId,
      adminId,
    ]);
    await owner.query(`SELECT fn_transition_asset($1,'AVAILABLE',$2,'test.h2')`, [
      assetId,
      adminId,
    ]);

    const rows = await owner.query(
      `SELECT prev_hash, row_hash FROM audit_log WHERE entity_id=$1 ORDER BY id`,
      [assetId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < rows.rows.length; i++) {
      expect(rows.rows[i].prev_hash).toBe(rows.rows[i - 1].row_hash);
    }
    expect(rows.rows[0].prev_hash).toBeNull();
  });

  it("fn_verify_audit_chain reports no breaks on an untouched chain", async () => {
    const { orgId, adminId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);
    await owner.query(`SELECT fn_transition_asset($1,'MAINTENANCE',$2,'test.intact')`, [
      assetId,
      adminId,
    ]);

    const result = await owner.query(`SELECT * FROM fn_verify_audit_chain($1)`, [orgId]);
    expect(result.rows).toHaveLength(0);
  });

  it("fn_verify_audit_chain detects a tampered row_hash", async () => {
    const { orgId, adminId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);
    await owner.query(`SELECT fn_transition_asset($1,'MAINTENANCE',$2,'test.tamper')`, [
      assetId,
      adminId,
    ]);

    // The append-only trigger blocks UPDATE for every role, including the
    // table owner — that IS the guarantee (SYSTEM_DESIGN.md: "only a
    // break-glass superuser can bypass"). Proving the verifier catches
    // tampering therefore requires genuinely exercising that break-glass path
    // (disable the trigger, corrupt, re-enable), not a plain UPDATE — a plain
    // UPDATE from ANY role, owner included, must keep failing; that is
    // covered separately below.
    await owner.query(`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_immutable`);
    try {
      await owner.query(
        `UPDATE audit_log SET row_hash = 'deadbeef' WHERE entity_id=$1 AND action='test.tamper'`,
        [assetId],
      );
    } finally {
      await owner.query(`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_immutable`);
    }

    const result = await owner.query(`SELECT * FROM fn_verify_audit_chain($1)`, [orgId]);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.some((r) => r.entity_id === assetId)).toBe(true);
  });

  it("rejects UPDATE and DELETE on audit_log via the backstop trigger (owner connection)", async () => {
    const { orgId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    await expect(
      owner.query(`UPDATE audit_log SET action='hacked' WHERE entity_id=$1`, [assetId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query(`DELETE FROM audit_log WHERE entity_id=$1`, [assetId]),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects UPDATE and DELETE on asset_state_event via the backstop trigger", async () => {
    const { orgId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    await expect(
      owner.query(`UPDATE asset_state_event SET event_type='hacked' WHERE asset_id=$1`, [assetId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query(`DELETE FROM asset_state_event WHERE asset_id=$1`, [assetId]),
    ).rejects.toThrow(/append-only/);
  });

  it("itam_app has no UPDATE/DELETE grant on audit_log or asset_state_event (the real guarantee)", async () => {
    const { orgId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    const app = appClient();
    await app.connect();
    try {
      await setOrg(app, orgId);
      // A grant-level rejection is a PostgreSQL permission error, distinct from
      // (and stronger than) the trigger-level rejection above: even if someone
      // disabled the trigger, this still holds because itam_app is not the
      // table owner.
      await expect(
        app.query(`UPDATE audit_log SET action='hacked' WHERE entity_id=$1`, [assetId]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        app.query(`DELETE FROM asset_state_event WHERE asset_id=$1`, [assetId]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
});
