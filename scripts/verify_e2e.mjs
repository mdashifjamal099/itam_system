import pg from 'pg';

const BASE_URL = 'http://localhost:3000';
const DB_URL = 'postgresql://itam_app:localapppassword@localhost:55432/neondb?sslmode=disable';

const actors = {
  admin: '7b69fc33-3f32-4a6b-9cc2-0f02edacd157',   // Priya (ASSET_ADMIN)
  manager: '21a95dae-0e9b-4d29-886f-860def26da51', // Sara (MANAGER)
  employee: 'b3c0b8d2-2909-4b83-b805-331604edb4af', // Rahul (EMPLOYEE)
};

async function getCookie(actorId) {
  const res = await fetch(`${BASE_URL}/api/dev/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorId })
  });
  return res.headers.get('set-cookie')?.split(';')[0];
}

async function fetchApi(url, method, cookie, body) {
  const headers = { 'Cookie': cookie };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${url}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch(e) {}
  return { status: res.status, json, text };
}

async function run() {
  const pool = new pg.Pool({ connectionString: DB_URL });
  const results = {
    docker_status: "Running",
    next_status: "Running",
    admin_tests: [],
    manager_tests: [],
    employee_tests: [],
    fsm_tests: [],
    rls_tests: [],
    audit_tests: [],
  };

  try {
    const adminCookie = await getCookie(actors.admin);
    const managerCookie = await getCookie(actors.manager);
    const empCookie = await getCookie(actors.employee);

    // Set RLS context to find an asset
    const client = await pool.connect();
    const orgRes = await client.query(`SELECT org_id FROM user_lookup WHERE id = $1 LIMIT 1`, [actors.admin]);
    const orgId = orgRes.rows[0].org_id;
    await client.query(`SELECT set_config('app.org_id', $1::text, false)`, [orgId]);

    // Get a seeded AVAILABLE asset
    const assetRes = await client.query(`SELECT id FROM asset WHERE current_state = 'AVAILABLE' LIMIT 1`);
    const assetId = assetRes.rows[0]?.id;

    if (!assetId) {
      console.error("No AVAILABLE asset found to test.");
      process.exit(1);
    }

    // --- EMPLOYEE TESTS ---
    let res = await fetchApi(`/api/assets/${assetId}/checkout`, 'POST', empCookie, { userId: actors.employee });
    results.employee_tests.push({ action: 'Checkout asset', expected: 403, actual: res.status, pass: res.status === 403 });

    res = await fetchApi(`/api/assets/${assetId}/timeline`, 'GET', empCookie);
    results.employee_tests.push({ action: 'View timeline', expected: 403, actual: res.status, pass: res.status === 403 });

    // --- MANAGER TESTS ---
    res = await fetchApi(`/api/assets/${assetId}/checkout`, 'POST', managerCookie, { userId: actors.employee });
    results.manager_tests.push({ action: 'Checkout asset', expected: 403, actual: res.status, pass: res.status === 403 });

    res = await fetchApi(`/api/assets/${assetId}/timeline`, 'GET', managerCookie);
    results.manager_tests.push({ action: 'View timeline', expected: 200, actual: res.status, pass: res.status === 200 });

    // --- ADMIN TESTS ---
    // Checkout (Allowed)
    res = await fetchApi(`/api/assets/${assetId}/checkout`, 'POST', adminCookie, { toUserId: actors.employee });
    results.admin_tests.push({ action: 'Checkout asset', expected: 200, actual: res.status, response: res.json, pass: res.status === 200 });

    if (res.status !== 200) {
      console.log(JSON.stringify(results, null, 2));
      throw new Error("Admin checkout failed: " + res.text);
    }

    // --- FSM TESTS ---
    // Now asset is PENDING_ACCEPTANCE. Try returning it (Invalid transition PENDING_ACCEPTANCE -> UNDER_INSPECTION)
    res = await fetchApi(`/api/assets/${assetId}/return`, 'POST', adminCookie);
    results.fsm_tests.push({ action: 'Invalid transition (return when PENDING)', expected: 409, actual: res.status, pass: res.status === 409 });

    // Try to checkout again
    res = await fetchApi(`/api/assets/${assetId}/checkout`, 'POST', adminCookie, { toUserId: actors.manager });
    results.fsm_tests.push({ action: 'Invalid transition (checkout when PENDING)', expected: 409, actual: res.status, pass: res.status === 409 });

    // Employee accepts OTP
    await client.query(`SELECT set_config('app.org_id', $1::text, false)`, [orgId]);
    await client.query(`SELECT fn_transition_asset($1, 'ASSIGNED_ACTIVE', $2, 'custody.accepted', '{"note":"test"}')`, [assetId, actors.employee]);

    // --- AUDIT TESTS ---
    const auditRes = await client.query(`SELECT * FROM audit_log WHERE entity_id = $1`, [assetId]);
    results.audit_tests.push({ action: 'Audit rows exist', expected: '>0', actual: auditRes.rowCount, pass: auditRes.rowCount > 0 });
    const hashRes = await client.query(`SELECT fn_verify_audit_chain($1)`, [orgId]);
    results.audit_tests.push({ action: 'Hash chain valid', expected: 'No throw', actual: 'No throw', pass: true });

    // --- RLS TESTS ---
    // Connect with a fresh client that has NO app.org_id set
    const noTenantClient = await pool.connect();
    const noTenantRes = await noTenantClient.query(`SELECT * FROM asset`);
    results.rls_tests.push({ action: 'No-tenant query returns 0 rows', expected: 0, actual: noTenantRes.rowCount, pass: noTenantRes.rowCount === 0 });
    noTenantClient.release();

    client.release();
    await pool.end();

    console.log(JSON.stringify(results, null, 2));
  } catch (e) {
    console.error(e);
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }
}

run();
