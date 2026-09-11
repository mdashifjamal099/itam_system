import pg from "pg";
import bcrypt from "bcryptjs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const { Client } = pg;

const actorsFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev-actors.json");

// Seeding creates the organization row, which the application role is not
// permitted to insert, so it runs on the owner/direct connection.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL_UNPOOLED or DATABASE_URL.");
  process.exit(1);
}

const client = new Client(url);
await client.connect();

// Default dev password for all seed users. Never used in production.
// Real users set their own password via the admin flow (not yet implemented).
const DEV_PASSWORD = "password123";
const BCRYPT_COST = 12;
const passwordHash = await bcrypt.hash(DEV_PASSWORD, BCRYPT_COST);

const ORG_NAME = "Acme Corp";

try {
  // Idempotent: reuse the existing seed org rather than creating a new one
  // every run. Previously this always INSERTed a fresh org, which — after
  // app_user.email became globally unique (db/007) — made a second run fail
  // outright on the very first user insert, since the same seed emails would
  // collide with the previous run's rows. Assets and audit history are
  // append-only by design (see db/001, db/003) and can never be deleted, so
  // "wipe and recreate" was never a valid option here; find-or-create is.
  const existingOrg = await client.query(`SELECT id FROM organization WHERE name = $1`, [
    ORG_NAME,
  ]);
  let orgId;
  if (existingOrg.rows.length > 0) {
    orgId = existingOrg.rows[0].id;
  } else {
    const created = await client.query(
      `INSERT INTO organization (name) VALUES ($1) RETURNING id`,
      [ORG_NAME],
    );
    orgId = created.rows[0].id;
  }

  // RLS is FORCEd, so even the owner needs tenant context to touch tenant rows.
  await client.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);

  const users = [
    ["E-000", "Admin Root", "root@acme.test", "IT", "SUPER_ADMIN"],
    ["E-001", "Priya Nair", "priya@acme.test", "IT", "ASSET_ADMIN"],
    ["E-002", "Rahul Menon", "rahul@acme.test", "Engineering", "EMPLOYEE"],
    ["E-003", "Sara Khan", "sara@acme.test", "Engineering", "MANAGER"],
    ["E-004", "Dev Patel", "dev@acme.test", "Design", "EMPLOYEE"],
  ];

  const userIds = {};
  for (const [empId, name, email, dept, role] of users) {
    // Upsert on the same expression the unique index uses (lower(email)).
    // DO UPDATE (rather than DO NOTHING) guarantees RETURNING always fires,
    // and re-applies role/name/department/password in case they drifted.
    const { rows } = await client.query(
      `INSERT INTO app_user (org_id, employee_id, full_name, email, department, role, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (lower(email)) DO UPDATE
         SET full_name = EXCLUDED.full_name,
             department = EXCLUDED.department,
             role = EXCLUDED.role,
             password_hash = EXCLUDED.password_hash,
             employment_status = 'ACTIVE'
       RETURNING id`,
      [orgId, empId, name, email, dept, role, passwordHash],
    );
    userIds[empId] = rows[0].id;
  }

  const assets = [
    ["ACME-LT-001", "C02XK1HTJGH5", "LAPTOP", 'MacBook Pro 14"', "2025-01-15", "2028-01-15"],
    ["ACME-LT-002", "C02XK1HTJGH6", "LAPTOP", "ThinkPad X1 Carbon", "2025-03-02", "2028-03-02"],
    ["ACME-MB-001", "F2LXK1HTJGH7", "MOBILE", "iPhone 15", "2025-05-20", "2027-05-20"],
    ["ACME-PR-001", "DELL-U2723QE-1", "PERIPHERAL", "Dell U2723QE Monitor", "2024-11-01", "2027-11-01"],
  ];

  for (const [tag, serial, category, model, procured, warranty] of assets) {
    // ON CONFLICT DO NOTHING here (not DO UPDATE): an asset that has already
    // moved through the FSM (checked out, in maintenance, etc.) must not be
    // silently reset to its seed values on a rerun. If the row already
    // exists we just look up its id and leave its lifecycle state alone.
    const inserted = await client.query(
      `INSERT INTO asset (org_id, asset_tag, serial_number, category, model,
                          procurement_date, warranty_expiry, location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Bengaluru HQ')
       ON CONFLICT (org_id, asset_tag) DO NOTHING
       RETURNING id, current_state`,
      [orgId, tag, serial, category, model, procured, warranty],
    );

    let assetId, currentState;
    if (inserted.rows.length > 0) {
      assetId = inserted.rows[0].id;
      currentState = inserted.rows[0].current_state;
    } else {
      const existing = await client.query(
        `SELECT id, current_state FROM asset WHERE org_id=$1 AND asset_tag=$2`,
        [orgId, tag],
      );
      assetId = existing.rows[0].id;
      currentState = existing.rows[0].current_state;
    }

    // Intake goes through the FSM so it is audited like every other
    // transition — but only once. PROCURED -> AVAILABLE is the only legal
    // transition out of the freshly-inserted default state; re-running it
    // against an asset that has since moved on would be rejected by the FSM
    // (correctly), so only do this for a genuinely new row.
    if (currentState === "PROCURED") {
      await client.query(`SELECT fn_transition_asset($1,'AVAILABLE',$2,'asset.intake')`, [
        assetId,
        userIds["E-001"],
      ]);
    }
  }

  // Local-only directory the dev login picker reads. Never queried from the
  // running app itself: an unauthenticated "list all users" endpoint would be
  // a real information leak, so this stays a build-time file, not a route.
  const directory = users.map(([empId, name, email, dept, role]) => ({
    id: userIds[empId],
    name,
    email,
    department: dept,
    role,
  }));
  await writeFile(actorsFile, JSON.stringify(directory, null, 2));

  console.log("Seeded organization:", orgId);
  console.log(`Wrote actor directory to ${actorsFile}`);
  console.log(`\nSeed users (password for all: ${DEV_PASSWORD}):`);
  for (const [empId, name, email, , role] of users) {
    console.log(`  ${userIds[empId]}  ${name.padEnd(14)} ${role}  ${email}`);
  }
} catch (err) {
  console.error("Seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
