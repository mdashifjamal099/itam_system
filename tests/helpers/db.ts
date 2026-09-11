import pg from "pg";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const { Client } = pg;

/** Owner/direct connection — same role migrate.mjs and seed.mjs use. */
export function ownerClient() {
  return new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
}

/** Application-role connection — the role RLS and grants actually restrict. */
export function appClient() {
  return new Client({ connectionString: process.env.DATABASE_URL });
}

export async function setOrg(client: pg.Client, orgId: string | null) {
  await client.query(`SELECT set_config('app.org_id', $1, false)`, [orgId ?? ""]);
}

export async function setSystem(client: pg.Client) {
  await client.query(`SELECT set_config('app.system', '1', false)`);
}

export async function setDrainer(client: pg.Client) {
  await client.query(`SELECT set_config('app.drainer', '1', false)`);
}

export async function clearContext(client: pg.Client) {
  await client.query(
    `SELECT set_config('app.org_id', '', false), set_config('app.system', '', false), set_config('app.drainer', '', false)`,
  );
}

/** Unique-enough suffix so parallel test runs (or reruns) never collide on unique constraints. */
export function unique(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function createOrg(client: pg.Client, name = "Test Org"): Promise<string> {
  const r = await client.query(`INSERT INTO organization (name) VALUES ($1) RETURNING id`, [
    `${name} ${unique("")}`,
  ]);
  return r.rows[0].id;
}

export type Role = "EMPLOYEE" | "MANAGER" | "ASSET_ADMIN" | "SUPER_ADMIN";

/**
 * The default plaintext password used for test users.
 * Stored as a bcrypt hash in the DB; never in plaintext.
 * Exposed here so auth tests can use it to test the real login flow.
 */
export const TEST_PASSWORD = "testpassword123";

// Pre-compute once per test process (bcrypt cost 10 is fast enough for tests).
let _testPasswordHash: string | null = null;
async function testPasswordHash(): Promise<string> {
  if (!_testPasswordHash) {
    _testPasswordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  }
  return _testPasswordHash;
}

export async function createUser(
  client: pg.Client,
  orgId: string,
  opts: { role: Role; fullName?: string; department?: string; email?: string },
): Promise<string> {
  const tag = unique("user");
  const hash = await testPasswordHash();
  const r = await client.query(
    `INSERT INTO app_user (org_id, employee_id, full_name, email, department, role, password_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      orgId,
      tag,
      opts.fullName ?? tag,
      opts.email ?? `${tag}@test.local`,
      opts.department ?? "General",
      opts.role,
      hash,
    ],
  );
  return r.rows[0].id;
}

/** Creates an asset and runs it through intake (PROCURED -> AVAILABLE) via the real FSM function. */
export async function createAvailableAsset(
  client: pg.Client,
  orgId: string,
  actorId: string,
  opts: { category?: string; model?: string } = {},
): Promise<string> {
  const tag = unique("ASSET");
  const r = await client.query(
    `INSERT INTO asset (org_id, asset_tag, serial_number, category, model)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [orgId, tag, unique("SN"), opts.category ?? "LAPTOP", opts.model ?? "Test Laptop"],
  );
  const assetId = r.rows[0].id;
  await client.query(`SELECT fn_transition_asset($1,'AVAILABLE',$2,'asset.intake')`, [
    assetId,
    actorId,
  ]);
  return assetId;
}

/** Full org + admin + employee + one AVAILABLE asset, the shape most tests need. */
export async function seedScenario(client: pg.Client) {
  const orgId = await createOrg(client);
  await setOrg(client, orgId);
  const adminId = await createUser(client, orgId, { role: "ASSET_ADMIN", fullName: "Admin" });
  const employeeId = await createUser(client, orgId, { role: "EMPLOYEE", fullName: "Employee" });
  const managerId = await createUser(client, orgId, { role: "MANAGER", fullName: "Manager" });
  const assetId = await createAvailableAsset(client, orgId, adminId);
  return { orgId, adminId, employeeId, managerId, assetId };
}

/** Returns the email address for a user id (useful in auth tests). */
export async function getUserEmail(client: pg.Client, userId: string): Promise<string> {
  const r = await client.query(`SELECT email FROM app_user WHERE id=$1`, [userId]);
  return r.rows[0].email as string;
}
