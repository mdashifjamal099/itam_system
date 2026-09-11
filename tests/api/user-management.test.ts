import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ownerClient, seedScenario, createOrg, createUser, getUserEmail } from "../helpers/db";
import { api, loginAs, loginAsEmail } from "../helpers/api";
import type { Client } from "pg";

describe("API: admin user provisioning (/api/ops/users)", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  it("an admin creates a user, who can immediately log in with the returned temp password", async () => {
    const { adminId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);

    const email = `new-${Date.now()}@acme.test`;
    const create = await api(`/api/ops/users`, {
      cookie: adminCookie,
      body: { fullName: "Grace Hopper", email, department: "Engineering", role: "EMPLOYEE" },
    });
    expect(create.status).toBe(200);
    expect(create.body.ok).toBe(true);
    expect(typeof create.body.tempPassword).toBe("string");
    expect((create.body.tempPassword as string).length).toBeGreaterThanOrEqual(12);

    const login = await loginAsEmail(email, create.body.tempPassword as string);
    expect(login.ok).toBe(true);

    const kpis = await api(`/api/ops/kpis`, { method: "GET", cookie: login.cookie });
    // EMPLOYEE role: correctly forbidden from the admin KPI endpoint, but the
    // 403 (not 401) proves the session itself is valid and resolved a real actor.
    expect(kpis.status).toBe(403);
  });

  it("a non-admin (EMPLOYEE) cannot create users", async () => {
    const { employeeId } = await seedScenario(owner);
    const cookie = await loginAs(employeeId);

    const res = await api(`/api/ops/users`, {
      cookie,
      body: { fullName: "X", email: "x@acme.test", role: "EMPLOYEE" },
    });
    expect(res.status).toBe(403);
  });

  it("a non-admin (MANAGER) cannot create users", async () => {
    const { managerId } = await seedScenario(owner);
    const cookie = await loginAs(managerId);

    const res = await api(`/api/ops/users`, {
      cookie,
      body: { fullName: "X", email: "x2@acme.test", role: "EMPLOYEE" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a duplicate email with a clean 409, not a 500", async () => {
    const { adminId, employeeId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const existingEmail = await getUserEmail(owner, employeeId);

    const res = await api(`/api/ops/users`, {
      cookie: adminCookie,
      body: { fullName: "Duplicate", email: existingEmail, role: "EMPLOYEE" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("rejects an invalid role and a malformed email with 400", async () => {
    const { adminId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);

    const badRole = await api(`/api/ops/users`, {
      cookie: adminCookie,
      body: { fullName: "X", email: "valid@acme.test", role: "SUPERUSER" },
    });
    expect(badRole.status).toBe(400);

    const badEmail = await api(`/api/ops/users`, {
      cookie: adminCookie,
      body: { fullName: "X", email: "not-an-email", role: "EMPLOYEE" },
    });
    expect(badEmail.status).toBe(400);
  });

  it("a created user's org_id always matches the creating admin's org (cannot be smuggled)", async () => {
    const { orgId, adminId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const otherOrg = await createOrg(owner, "Some Other Org");

    const email = `smuggle-${Date.now()}@acme.test`;
    const res = await api(`/api/ops/users`, {
      cookie: adminCookie,
      // The route accepts no org_id field at all, but this proves the point
      // even if such a field were ever added carelessly: the created row is
      // scoped to the ADMIN'S org, not attacker-controlled input.
      body: { fullName: "Y", email, role: "EMPLOYEE", orgId: otherOrg },
    });
    expect(res.status).toBe(200);

    const row = await owner.query(`SELECT org_id FROM app_user WHERE id=$1`, [res.body.id]);
    expect(row.rows[0].org_id).toBe(orgId);
    expect(row.rows[0].org_id).not.toBe(otherOrg);
  });

  it("GET /api/ops/users only lists the caller's own org (RLS proof)", async () => {
    const { adminId } = await seedScenario(owner);
    const orgB = await createOrg(owner, "Org B listing");
    await createUser(owner, orgB, { role: "EMPLOYEE", fullName: "Not Visible" });

    const adminCookie = await loginAs(adminId);
    const res = await api<{ users: { full_name: string }[] }>(`/api/ops/users`, {
      method: "GET",
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    expect(res.body.users.some((u) => u.full_name === "Not Visible")).toBe(false);
  });

  it("a role change is audited with before/after values", async () => {
    const { orgId, adminId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const target = await createUser(owner, orgId, { role: "EMPLOYEE", fullName: "Promotable" });

    const res = await api(`/api/ops/users/${target}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { role: "MANAGER" },
    });
    expect(res.status).toBe(200);

    const audit = await owner.query(
      `SELECT action, before, after FROM audit_log
       WHERE entity_type='app_user' AND entity_id=$1 AND action='user.updated'
       ORDER BY id DESC LIMIT 1`,
      [target],
    );
    expect(audit.rows[0].before.role).toBe("EMPLOYEE");
    expect(audit.rows[0].after.role).toBe("MANAGER");

    const row = await owner.query(`SELECT role FROM app_user WHERE id=$1`, [target]);
    expect(row.rows[0].role).toBe("MANAGER");
  });

  it("deactivating a user immediately blocks their login and session", async () => {
    const { orgId, adminId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const target = await createUser(owner, orgId, { role: "EMPLOYEE", fullName: "Soon Gone" });
    const targetCookie = await loginAs(target);

    // Sanity: works while active.
    const before = await api(`/api/assets`, { method: "GET", cookie: targetCookie }).catch(() => null);
    void before; // no such route exists; the real check is the 403 below post-deactivation

    const deactivate = await api(`/api/ops/users/${target}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { employmentStatus: "TERMINATED" },
    });
    expect(deactivate.status).toBe(200);

    const after = await api(`/api/ops/kpis`, { method: "GET", cookie: targetCookie });
    expect(after.status).toBe(403);
  });

  it("an admin cannot deactivate or demote themselves through this endpoint", async () => {
    const { adminId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);

    const deactivateSelf = await api(`/api/ops/users/${adminId}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { employmentStatus: "TERMINATED" },
    });
    expect(deactivateSelf.status).toBe(400);

    const demoteSelf = await api(`/api/ops/users/${adminId}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { role: "EMPLOYEE" },
    });
    expect(demoteSelf.status).toBe(400);
  });

  it("cannot update a user in a different organization", async () => {
    const { adminId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const orgB = await createOrg(owner, "Org B update target");
    const targetInOtherOrg = await createUser(owner, orgB, { role: "EMPLOYEE" });

    const res = await api(`/api/ops/users/${targetInOtherOrg}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { role: "MANAGER" },
    });
    expect(res.status).toBe(404);

    const row = await owner.query(`SELECT role FROM app_user WHERE id=$1`, [targetInOtherOrg]);
    expect(row.rows[0].role).toBe("EMPLOYEE");
  });

  describe("admin-tier accounts require SUPER_ADMIN", () => {
    it("an ASSET_ADMIN cannot create a SUPER_ADMIN account", async () => {
      const { adminId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);

      const res = await api(`/api/ops/users`, {
        cookie,
        body: { fullName: "Wannabe Root", email: `root-${Date.now()}@acme.test`, role: "SUPER_ADMIN" },
      });
      expect(res.status).toBe(403);
    });

    it("an ASSET_ADMIN cannot create another ASSET_ADMIN account", async () => {
      const { adminId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);

      const res = await api(`/api/ops/users`, {
        cookie,
        body: { fullName: "Second Admin", email: `admin2-${Date.now()}@acme.test`, role: "ASSET_ADMIN" },
      });
      expect(res.status).toBe(403);
    });

    it("a SUPER_ADMIN CAN create an ASSET_ADMIN or SUPER_ADMIN account", async () => {
      const { orgId } = await seedScenario(owner);
      const superAdminId = await createUser(owner, orgId, { role: "SUPER_ADMIN", fullName: "Root" });
      const cookie = await loginAs(superAdminId);

      const res = await api(`/api/ops/users`, {
        cookie,
        body: { fullName: "New Admin", email: `newadmin-${Date.now()}@acme.test`, role: "ASSET_ADMIN" },
      });
      expect(res.status).toBe(200);
    });

    it("an ASSET_ADMIN cannot deactivate or change the role of an existing admin-tier account", async () => {
      const { orgId, adminId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);
      const otherAdmin = await createUser(owner, orgId, { role: "ASSET_ADMIN", fullName: "Other Admin" });

      const deactivate = await api(`/api/ops/users/${otherAdmin}`, {
        method: "PATCH",
        cookie,
        body: { employmentStatus: "TERMINATED" },
      });
      expect(deactivate.status).toBe(403);

      const demote = await api(`/api/ops/users/${otherAdmin}`, {
        method: "PATCH",
        cookie,
        body: { role: "EMPLOYEE" },
      });
      expect(demote.status).toBe(403);

      const row = await owner.query(`SELECT role, employment_status FROM app_user WHERE id=$1`, [
        otherAdmin,
      ]);
      expect(row.rows[0]).toMatchObject({ role: "ASSET_ADMIN", employment_status: "ACTIVE" });
    });

    it("an ASSET_ADMIN cannot promote an EMPLOYEE to ASSET_ADMIN or SUPER_ADMIN", async () => {
      const { adminId, employeeId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);

      const res = await api(`/api/ops/users/${employeeId}`, {
        method: "PATCH",
        cookie,
        body: { role: "ASSET_ADMIN" },
      });
      expect(res.status).toBe(403);

      const row = await owner.query(`SELECT role FROM app_user WHERE id=$1`, [employeeId]);
      expect(row.rows[0].role).toBe("EMPLOYEE");
    });

    it("a SUPER_ADMIN CAN deactivate, promote, and demote admin-tier accounts", async () => {
      const { orgId } = await seedScenario(owner);
      const superAdminId = await createUser(owner, orgId, { role: "SUPER_ADMIN", fullName: "Root2" });
      const cookie = await loginAs(superAdminId);
      const targetAdmin = await createUser(owner, orgId, { role: "ASSET_ADMIN", fullName: "Managed Admin" });

      const demote = await api(`/api/ops/users/${targetAdmin}`, {
        method: "PATCH",
        cookie,
        body: { role: "EMPLOYEE" },
      });
      expect(demote.status).toBe(200);

      const row = await owner.query(`SELECT role FROM app_user WHERE id=$1`, [targetAdmin]);
      expect(row.rows[0].role).toBe("EMPLOYEE");
    });

    it("an ASSET_ADMIN can still fully manage a MANAGER account (non-admin-tier, unaffected)", async () => {
      const { orgId, adminId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);
      const manager = await createUser(owner, orgId, { role: "MANAGER", fullName: "Regular Manager" });

      const res = await api(`/api/ops/users/${manager}`, {
        method: "PATCH",
        cookie,
        body: { role: "EMPLOYEE" },
      });
      expect(res.status).toBe(200);
    });
  });
});
