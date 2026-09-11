/**
 * Invariant suite for the core foundation.
 *
 * These are not unit tests of application code — they assert that the DATABASE
 * refuses to do the wrong thing even when the application asks it to. Every
 * check here corresponds to a guarantee the design claims.
 *
 *   npm run db:verify
 */
import pg from "pg";
const { Client } = pg;

const ownerUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_URL;

if (!ownerUrl) {
  console.error("Set DATABASE_URL_UNPOOLED / DATABASE_URL first.");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  PASS  ${name}`);
}
function bad(name, detail) {
  failed++;
  console.log(`  FAIL  ${name}\n        ${detail}`);
}

/** Asserts the statement is rejected, and that the message matches. */
async function mustReject(client, name, fn, expect) {
  try {
    await fn();
    bad(name, "statement was ACCEPTED but should have been rejected");
  } catch (err) {
    if (expect && !err.message.includes(expect)) {
      bad(name, `rejected, but for the wrong reason: ${err.message}`);
    } else {
      ok(name);
    }
  }
}

const owner = new Client(ownerUrl);
await owner.connect();

// Scratch tenant, torn down at the end.
const { rows: o1 } = await owner.query(
  `INSERT INTO organization (name) VALUES ('VerifyCo A') RETURNING id`,
);
const { rows: o2 } = await owner.query(
  `INSERT INTO organization (name) VALUES ('VerifyCo B') RETURNING id`,
);
const orgA = o1[0].id;
const orgB = o2[0].id;

async function setOrg(client, org) {
  await client.query(`SELECT set_config('app.org_id', $1, false)`, [org]);
}

try {
  await setOrg(owner, orgA);

  // Emails must be unique per run: app_user.email is globally unique
  // (db/007), and this script's scratch orgs are deliberately never cleaned
  // up (their audit rows are append-only and cannot be deleted), so a fixed
  // literal email would collide with the previous run's row on every rerun.
  const runTag = orgA.slice(0, 8);
  const { rows: au } = await owner.query(
    `INSERT INTO app_user (org_id, employee_id, full_name, email, role)
     VALUES ($1,'V-1','Verify Admin',$2,'ASSET_ADMIN') RETURNING id`,
    [orgA, `admin+${runTag}@verify.test`],
  );
  const { rows: eu } = await owner.query(
    `INSERT INTO app_user (org_id, employee_id, full_name, email, role)
     VALUES ($1,'V-2','Verify Employee',$2,'EMPLOYEE') RETURNING id`,
    [orgA, `emp+${runTag}@verify.test`],
  );
  const admin = au[0].id;
  const employee = eu[0].id;

  const { rows: ar } = await owner.query(
    `INSERT INTO asset (org_id, asset_tag, serial_number, category, model)
     VALUES ($1,'VER-001','VER-SN-001','LAPTOP','Verify Book') RETURNING id`,
    [orgA],
  );
  const asset = ar[0].id;

  console.log("\n1. FSM enforcement");

  await mustReject(
    owner,
    "illegal transition PROCURED -> ASSIGNED_ACTIVE is rejected",
    () => owner.query(`SELECT fn_transition_asset($1,'ASSIGNED_ACTIVE',$2,'bogus')`, [asset, admin]),
    "Illegal transition",
  );

  await owner.query(`SELECT fn_transition_asset($1,'AVAILABLE',$2,'asset.intake')`, [asset, admin]);
  const { rows: st } = await owner.query(`SELECT current_state, version FROM asset WHERE id=$1`, [asset]);
  st[0].current_state === "AVAILABLE" && Number(st[0].version) === 1
    ? ok("legal transition applied and bumped version to 1")
    : bad("legal transition", `state=${st[0].current_state} version=${st[0].version}`);

  await mustReject(
    owner,
    "direct UPDATE of asset.current_state is rejected by the guard trigger",
    () => owner.query(`UPDATE asset SET current_state='RETIRED' WHERE id=$1`, [asset]),
    "fn_transition_asset",
  );

  await mustReject(
    owner,
    "stale aggregate version is rejected",
    () =>
      owner.query(`SELECT fn_transition_asset($1,'MAINTENANCE',$2,'x','{}'::jsonb,NULL,99)`, [
        asset,
        admin,
      ]),
    "Stale asset version",
  );

  console.log("\n2. One transaction: state + event + audit + outbox");

  const before = await owner.query(
    `SELECT
       (SELECT count(*) FROM asset_state_event WHERE asset_id=$1) AS ev,
       (SELECT count(*) FROM audit_log WHERE entity_id=$1) AS au,
       (SELECT count(*) FROM event_outbox WHERE aggregate_id=$1) AS ob`,
    [asset],
  );

  const { rows: co } = await owner.query(
    `SELECT fn_checkout_asset($1,$2,$3,'deadbeef',1440) AS r`,
    [asset, employee, admin],
  );
  const handshake = co[0].r.handshakeId;

  const after = await owner.query(
    `SELECT
       (SELECT count(*) FROM asset_state_event WHERE asset_id=$1) AS ev,
       (SELECT count(*) FROM audit_log WHERE entity_id=$1) AS au,
       (SELECT count(*) FROM event_outbox WHERE aggregate_id=$1) AS ob`,
    [asset],
  );

  const grew = (k) => Number(after.rows[0][k]) === Number(before.rows[0][k]) + 1;
  grew("ev") && grew("au") && grew("ob")
    ? ok("checkout wrote exactly one event, one audit row and one outbox row")
    : bad("atomic write", JSON.stringify({ before: before.rows[0], after: after.rows[0] }));

  const { rows: unp } = await owner.query(
    `SELECT count(*) AS n FROM event_outbox WHERE aggregate_id=$1 AND published_at IS NULL`,
    [asset],
  );
  Number(unp[0].n) > 0
    ? ok("outbox rows are durable and unpublished (no broker dependency at commit)")
    : bad("outbox durability", "expected unpublished rows");

  console.log("\n3. Append-only enforcement");

  await mustReject(
    owner,
    "UPDATE on asset_state_event is rejected",
    () => owner.query(`UPDATE asset_state_event SET event_type='tampered' WHERE asset_id=$1`, [asset]),
    "append-only",
  );
  await mustReject(
    owner,
    "DELETE on audit_log is rejected",
    () => owner.query(`DELETE FROM audit_log WHERE entity_id=$1`, [asset]),
    "append-only",
  );

  console.log("\n4. Custody handshake + holding period lifecycle");

  const { rows: acc } = await owner.query(`SELECT fn_accept_custody($1,$2,'deadbeef','127.0.0.1') AS r`, [
    handshake,
    employee,
  ]);
  acc[0].r.ok === true
    ? ok("employee accepted custody with a valid OTP")
    : bad("accept custody", JSON.stringify(acc[0].r));

  const { rows: wrongUser } = await owner.query(
    `SELECT fn_accept_custody($1,$2,'deadbeef',NULL) AS r`,
    [handshake, admin],
  );
  wrongUser[0].r.ok === false
    ? ok(`replaying an accepted handshake is refused (${wrongUser[0].r.reason})`)
    : bad("handshake replay", "second accept succeeded");

  const { rows: hp } = await owner.query(
    `SELECT id FROM holding_period WHERE asset_id=$1 AND end_ts IS NULL`,
    [asset],
  );
  hp.length === 1
    ? ok("exactly one open holding period after acceptance")
    : bad("holding period", `expected 1 open, found ${hp.length}`);

  await owner.query(`SELECT fn_return_asset($1,$2)`, [asset, admin]);

  await mustReject(
    owner,
    "closed holding period cannot be reopened or edited",
    () => owner.query(`UPDATE holding_period SET end_ts = now() WHERE id=$1`, [hp[0].id]),
    "frozen",
  );
  await mustReject(
    owner,
    "holding period cannot be deleted",
    () => owner.query(`DELETE FROM holding_period WHERE id=$1`, [hp[0].id]),
    "cannot be deleted",
  );

  const { rows: insp } = await owner.query(
    `SELECT fn_complete_inspection($1,$2,'MINOR_DAMAGE','scuffed lid') AS r`,
    [asset, admin],
  );
  insp[0].r.toState === "MAINTENANCE" && insp[0].r.maintenanceLogId
    ? ok("damaged return routed to MAINTENANCE with a maintenance log")
    : bad("inspection routing", JSON.stringify(insp[0].r));

  console.log("\n5. Concurrency");

  // Put a second asset in AVAILABLE, then race two checkouts.
  const { rows: a2 } = await owner.query(
    `INSERT INTO asset (org_id, asset_tag, serial_number, category, model)
     VALUES ($1,'VER-002','VER-SN-002','LAPTOP','Verify Book 2') RETURNING id`,
    [orgA],
  );
  const raceAsset = a2[0].id;
  await owner.query(`SELECT fn_transition_asset($1,'AVAILABLE',$2,'asset.intake')`, [raceAsset, admin]);

  const c1 = new Client(ownerUrl);
  const c2 = new Client(ownerUrl);
  await c1.connect();
  await c2.connect();
  await setOrg(c1, orgA);
  await setOrg(c2, orgA);

  await c1.query("BEGIN");
  await c2.query("BEGIN");
  await c1.query(`SELECT fn_checkout_asset($1,$2,$3,'aaa',60)`, [raceAsset, employee, admin]);

  // c2 blocks on the FOR UPDATE lock until c1 commits, then sees
  // PENDING_ACCEPTANCE and fails the transition check.
  const racer = c2
    .query(`SELECT fn_checkout_asset($1,$2,$3,'bbb',60)`, [raceAsset, employee, admin])
    .then(() => "accepted")
    .catch((e) => e.message);

  await c1.query("COMMIT");
  const raceResult = await racer;
  await c2.query("ROLLBACK").catch(() => {});
  await c1.end();
  await c2.end();

  typeof raceResult === "string" && raceResult.includes("Illegal transition")
    ? ok("concurrent checkout of the same asset: one wins, one is rejected")
    : bad("concurrency", `second checkout result: ${raceResult}`);

  console.log("\n6. Tenant isolation (RLS)");

  // RLS must be checked as itam_app, not as the owner connection. In this local
  // Docker image the bootstrap POSTGRES_USER is a genuine Postgres superuser,
  // and superusers bypass RLS unconditionally — FORCE ROW LEVEL SECURITY only
  // pulls in the table OWNER, never a superuser. Real Neon's owner role is not
  // a superuser, but locally it is, so the owner connection is not a valid way
  // to prove isolation here. itam_app is a plain non-owner role either way, so
  // it is the right (and only reliable) connection to test this with.
  if (appUrl && appUrl !== ownerUrl) {
    const rls = new Client(appUrl);
    await rls.connect();
    try {
      await setOrg(rls, orgB);
      const { rows: leak } = await rls.query(`SELECT count(*) AS n FROM asset WHERE id=$1`, [asset]);
      Number(leak[0].n) === 0
        ? ok("org B (itam_app) cannot see org A's asset")
        : bad("RLS", "cross-tenant read succeeded");

      const { rows: evLeak } = await rls.query(
        `SELECT count(*) AS n FROM asset_state_event WHERE asset_id=$1`,
        [asset],
      );
      Number(evLeak[0].n) === 0
        ? ok("org B (itam_app) cannot see org A's event history")
        : bad("RLS", "cross-tenant event read succeeded");

      await setOrg(rls, "");
      const { rows: noCtx } = await rls.query(`SELECT count(*) AS n FROM asset`);
      Number(noCtx[0].n) === 0
        ? ok("no tenant context yields no rows (fails closed)")
        : bad("RLS", "queries without tenant context returned rows");
    } finally {
      await rls.end();
    }
  } else {
    console.log(
      "  SKIP  DATABASE_URL is the owner connection — set up itam_app to test RLS for real.",
    );
  }

  console.log("\n7. Idempotency ledger");

  // Fresh id per run so re-running verify.mjs against a database that already
  // has scratch data from a prior run doesn't collide.
  const probeEventId = `00000000-0000-0000-0000-${(Date.now() % 1e12).toString().padStart(12, "0")}`;

  await owner.query(`INSERT INTO processed_event (event_id, consumer) VALUES ($1,'notify')`, [
    probeEventId,
  ]);
  const { rows: dup } = await owner.query(
    `INSERT INTO processed_event (event_id, consumer) VALUES ($1,'notify')
     ON CONFLICT DO NOTHING RETURNING event_id`,
    [probeEventId],
  );
  dup.length === 0
    ? ok("redelivery to the same consumer is a no-op")
    : bad("idempotency", "duplicate claim succeeded");

  const { rows: other } = await owner.query(
    `INSERT INTO processed_event (event_id, consumer) VALUES ($1,'mdm')
     ON CONFLICT DO NOTHING RETURNING event_id`,
    [probeEventId],
  );
  other.length === 1
    ? ok("a different consumer can still claim the same event")
    : bad("idempotency", "second consumer was starved by the first");

  // ---------------------------------------------------------------------
  // The grant-level guarantee, which only means anything on the app role.
  // ---------------------------------------------------------------------
  if (appUrl && appUrl !== ownerUrl) {
    console.log("\n8. Application role privileges");
    const app = new Client(appUrl);
    try {
      await app.connect();
      await setOrg(app, orgA);
      await mustReject(
        app,
        "itam_app has no UPDATE grant on audit_log",
        () => app.query(`UPDATE audit_log SET action='tampered' WHERE entity_id=$1`, [asset]),
        "permission denied",
      );
      await mustReject(
        app,
        "itam_app has no DELETE grant on asset_state_event",
        () => app.query(`DELETE FROM asset_state_event WHERE asset_id=$1`, [asset]),
        "permission denied",
      );
      await mustReject(
        app,
        "itam_app cannot rewrite the transition rules",
        () => app.query(`INSERT INTO transition_rules VALUES ('RETIRED','AVAILABLE','nope')`),
        "permission denied",
      );
      await app.end();
    } catch (err) {
      bad("app role connection", err.message);
    }
  } else {
    console.log("\n8. Application role privileges");
    console.log("  SKIP  DATABASE_URL is the owner connection — set up itam_app to test grants.");
    console.log("        Until then the append-only guarantee is triggers only, not grants.");
  }
} finally {
  // Teardown is deliberately partial: audit_log and asset_state_event rows for
  // the scratch orgs cannot be deleted, by design. That is the guarantee working,
  // not a leak. Drop and re-migrate if you want a pristine database.
  console.log(`\nScratch tenants left in place (append-only rows cannot be removed):`);
  console.log(`  ${orgA}\n  ${orgB}`);
  await owner.query(`SELECT set_config('app.org_id', '', false)`).catch(() => {});
  await owner.end();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
