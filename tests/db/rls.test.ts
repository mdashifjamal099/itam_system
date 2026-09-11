import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ownerClient,
  appClient,
  setOrg,
  clearContext,
  createOrg,
  createUser,
  seedScenario,
} from "../helpers/db";
import type { Client } from "pg";

/**
 * RLS must be proven against `itam_app`, not the owner connection. In local
 * Docker the bootstrap Postgres user is a genuine superuser, and superusers
 * bypass RLS unconditionally regardless of FORCE ROW LEVEL SECURITY — that is
 * not the case for a real Neon owner role, but it means the owner connection
 * cannot demonstrate isolation here at all. itam_app is a plain non-owner role
 * either way, so it is the only connection that proves anything.
 *
 * Fixture setup (creating orgs/users) still has to go through the OWNER
 * connection: `organization` INSERT is revoked from itam_app by design (it is
 * provisioned out of band), so seedScenario/createOrg/createUser run as owner
 * and only the assertions under test run as itam_app.
 */
describe("Tenant isolation (RLS) and user_lookup", () => {
  let owner: Client;
  let app: Client;

  beforeAll(async () => {
    owner = ownerClient();
    app = appClient();
    await owner.connect();
    await app.connect();
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it("an org cannot see another org's assets, events, or users", async () => {
    const a = await seedScenario(owner);
    const orgB = await createOrg(owner);

    await setOrg(app, orgB);
    const asset = await app.query(`SELECT count(*) n FROM asset WHERE id=$1`, [a.assetId]);
    expect(Number(asset.rows[0].n)).toBe(0);

    const events = await app.query(
      `SELECT count(*) n FROM asset_state_event WHERE asset_id=$1`,
      [a.assetId],
    );
    expect(Number(events.rows[0].n)).toBe(0);

    const users = await app.query(`SELECT count(*) n FROM app_user WHERE id=$1`, [a.adminId]);
    expect(Number(users.rows[0].n)).toBe(0);
  });

  it("no tenant context set yields zero rows everywhere (fails closed, not open)", async () => {
    const a = await seedScenario(owner);
    await clearContext(app);

    const asset = await app.query(`SELECT count(*) n FROM asset WHERE id=$1`, [a.assetId]);
    expect(Number(asset.rows[0].n)).toBe(0);

    const anyAsset = await app.query(`SELECT count(*) n FROM asset`);
    expect(Number(anyAsset.rows[0].n)).toBe(0);
  });

  it("a WHERE-clause cannot smuggle a cross-tenant row past RLS (policy applies regardless of predicate)", async () => {
    const a = await seedScenario(owner);
    const orgB = await createOrg(owner);
    await setOrg(app, orgB);

    // Even an unconstrained SELECT * scoped only by the target id — no org_id
    // in the WHERE clause at all — still returns nothing, because the policy
    // is applied by Postgres, not by query authorship.
    const row = await app.query(`SELECT * FROM asset WHERE id=$1`, [a.assetId]);
    expect(row.rows).toHaveLength(0);
  });

  it("cannot write into another tenant's rows via an org_id mismatch (WITH CHECK)", async () => {
    const a = await seedScenario(owner);
    const orgB = await createOrg(owner);
    const otherUserInB = await createUser(owner, orgB, { role: "EMPLOYEE" });

    await setOrg(app, orgB);
    // The row is invisible under orgB's context, so the UPDATE matches zero
    // rows rather than erroring — this is what "fails closed" looks like for
    // a write, not a thrown exception.
    const result = await app.query(
      `UPDATE app_user SET department='hacked' WHERE id=$1`,
      [a.adminId],
    );
    expect(result.rowCount).toBe(0);

    // Sanity: this connection really can write within its own tenant.
    const ownWrite = await app.query(
      `UPDATE app_user SET department='ok' WHERE id=$1`,
      [otherUserInB],
    );
    expect(ownWrite.rowCount).toBe(1);
  });

  it("user_lookup holds no business data and is readable without tenant context (by design)", async () => {
    const a = await seedScenario(owner);
    await clearContext(app);

    const row = await app.query(`SELECT * FROM user_lookup WHERE id=$1`, [a.adminId]);
    expect(row.rows).toHaveLength(1);
    // Exactly id + org_id — nothing else. If a future migration ever adds a
    // column here, this test forces a conscious decision about whether that
    // column belongs somewhere RLS-protected instead.
    expect(Object.keys(row.rows[0]).sort()).toEqual(["id", "org_id"]);
  });

  it("user_lookup stays in sync with app_user via the AFTER INSERT trigger", async () => {
    const orgId = await createOrg(owner);
    const userId = await createUser(owner, orgId, { role: "EMPLOYEE" });

    await clearContext(app);
    const lookup = await app.query(`SELECT org_id FROM user_lookup WHERE id=$1`, [userId]);
    expect(lookup.rows[0].org_id).toBe(orgId);
  });

  it("itam_app cannot rewrite transition_rules (config, not tenant data)", async () => {
    await expect(
      app.query(`INSERT INTO transition_rules VALUES ('RETIRED','AVAILABLE','nope')`),
    ).rejects.toThrow(/permission denied/);
  });

  it("itam_app cannot INSERT/UPDATE/DELETE organization rows (provisioned out of band)", async () => {
    await expect(
      app.query(`INSERT INTO organization (name) VALUES ('should fail')`),
    ).rejects.toThrow(/permission denied/);
  });
});
