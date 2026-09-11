import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ownerClient, setOrg, seedScenario } from "../helpers/db";
import type { Client } from "pg";

/** Drives an asset from AVAILABLE all the way to an accepted, active custody. */
async function checkoutAndAccept(
  client: Client,
  assetId: string,
  fromUser: string,
  toUser: string,
) {
  const co = await client.query(
    `SELECT fn_checkout_asset($1,$2,$3,'otphash',60) AS r`,
    [assetId, toUser, fromUser],
  );
  const handshakeId = co.rows[0].r.handshakeId;
  await client.query(`SELECT fn_accept_custody($1,$2,'otphash',NULL)`, [handshakeId, toUser]);
  return handshakeId;
}

describe("HoldingPeriod: open/close lifecycle", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  it("opens exactly one holding_period row on custody acceptance", async () => {
    const { orgId, adminId, employeeId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    await checkoutAndAccept(owner, assetId, adminId, employeeId);

    const open = await owner.query(
      `SELECT id, user_id, end_ts FROM holding_period WHERE asset_id=$1 AND end_ts IS NULL`,
      [assetId],
    );
    expect(open.rows).toHaveLength(1);
    expect(open.rows[0].user_id).toBe(employeeId);
  });

  it("the partial unique index prevents a second concurrently-open holding_period for the same asset", async () => {
    const { orgId, adminId, employeeId, managerId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);
    const handshakeId = await checkoutAndAccept(owner, assetId, adminId, employeeId);

    // Attempt to open a second one directly (bypassing fn_return_asset), which
    // is exactly what the unique index exists to prevent even if application
    // code has a bug.
    await expect(
      owner.query(
        `INSERT INTO holding_period (org_id, asset_id, user_id, handshake_id, start_ts)
         VALUES ($1,$2,$3,$4, now())`,
        [orgId, assetId, managerId, handshakeId],
      ),
    ).rejects.toThrow(/duplicate key|uq_holding_open/);
  });

  it("closes exactly once on return and computes a non-negative holding duration", async () => {
    const { orgId, adminId, employeeId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);
    await checkoutAndAccept(owner, assetId, adminId, employeeId);

    const result = await owner.query(`SELECT fn_return_asset($1,$2) AS r`, [assetId, adminId]);
    expect(result.rows[0].r.ok).toBe(true);
    expect(result.rows[0].r.holdingDays).toBeGreaterThanOrEqual(0);

    const closed = await owner.query(
      `SELECT end_ts, closed_by FROM holding_period WHERE asset_id=$1 ORDER BY start_ts DESC LIMIT 1`,
      [assetId],
    );
    expect(closed.rows[0].end_ts).not.toBeNull();
    expect(closed.rows[0].closed_by).toBe(adminId);
  });

  it("a closed holding_period is frozen: cannot be reopened, edited, or deleted", async () => {
    const { orgId, adminId, employeeId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);
    await checkoutAndAccept(owner, assetId, adminId, employeeId);
    await owner.query(`SELECT fn_return_asset($1,$2)`, [assetId, adminId]);

    const row = await owner.query(
      `SELECT id FROM holding_period WHERE asset_id=$1 ORDER BY start_ts DESC LIMIT 1`,
      [assetId],
    );
    const id = row.rows[0].id;

    await expect(
      owner.query(`UPDATE holding_period SET end_ts = now() WHERE id=$1`, [id]),
    ).rejects.toThrow(/frozen/);
    await expect(
      owner.query(`UPDATE holding_period SET start_ts = now() WHERE id=$1`, [id]),
    ).rejects.toThrow(/frozen/);
    await expect(owner.query(`DELETE FROM holding_period WHERE id=$1`, [id])).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it("fn_holder_at answers point-in-time custody correctly across two consecutive holders", async () => {
    const { orgId, adminId, employeeId, managerId, assetId } = await seedScenario(owner);
    await setOrg(owner, orgId);

    await checkoutAndAccept(owner, assetId, adminId, employeeId);
    const t1 = (await owner.query(`SELECT now() t`)).rows[0].t;

    await owner.query(`SELECT fn_return_asset($1,$2)`, [assetId, adminId]);
    await owner.query(`SELECT fn_complete_inspection($1,$2,'GOOD')`, [assetId, adminId]);
    await checkoutAndAccept(owner, assetId, adminId, managerId);
    const t2 = (await owner.query(`SELECT now() t`)).rows[0].t;

    const holderAtT1 = await owner.query(`SELECT * FROM fn_holder_at($1,$2)`, [assetId, t1]);
    expect(holderAtT1.rows[0].user_id).toBe(employeeId);

    const holderAtT2 = await owner.query(`SELECT * FROM fn_holder_at($1,$2)`, [assetId, t2]);
    expect(holderAtT2.rows[0].user_id).toBe(managerId);

    // A time before the asset was ever checked out has no holder.
    const beforeAnyCustody = await owner.query(`SELECT * FROM fn_holder_at($1, now() - interval '1 hour')`, [
      assetId,
    ]);
    expect(beforeAnyCustody.rows).toHaveLength(0);
  });
});
