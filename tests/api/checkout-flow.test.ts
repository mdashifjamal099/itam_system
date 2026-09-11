import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ownerClient, seedScenario, createAvailableAsset } from "../helpers/db";
import { api, loginAs } from "../helpers/api";
import type { Client } from "pg";

describe("API: checkout / accept / return / inspect / lost / recover", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  it("full happy path: checkout -> accept -> return -> inspect(GOOD)", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const employeeCookie = await loginAs(employeeId);

    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId },
    });
    expect(checkout.status).toBe(200);
    expect(checkout.body.toState).toBe("PENDING_ACCEPTANCE");
    expect(typeof checkout.body.devOtp).toBe("string");

    const accept = await api(`/api/custody/accept`, {
      cookie: employeeCookie,
      body: { handshakeId: checkout.body.handshakeId, otp: checkout.body.devOtp },
    });
    expect(accept.status).toBe(200);
    expect(accept.body.toState).toBe("ASSIGNED_ACTIVE");

    const ret = await api(`/api/assets/${assetId}/return`, {
      method: "POST",
      cookie: employeeCookie,
    });
    expect(ret.status).toBe(200);
    expect(ret.body.toState).toBe("UNDER_INSPECTION");

    const inspect = await api(`/api/assets/${assetId}/inspect`, {
      cookie: adminCookie,
      body: { condition: "GOOD" },
    });
    expect(inspect.status).toBe(200);
    expect(inspect.body.toState).toBe("AVAILABLE");
    expect(inspect.body.maintenanceLogId).toBeNull();
  });

  it.each(["MINOR_DAMAGE", "MAJOR_DAMAGE"] as const)(
    "inspect routes %s to MAINTENANCE with a maintenance log",
    async (condition) => {
      const { orgId, adminId, employeeId } = await seedScenario(owner);
      const assetId = await createAvailableAsset(owner, orgId, adminId);
      const adminCookie = await loginAs(adminId);
      const employeeCookie = await loginAs(employeeId);

      const co = await api(`/api/assets/${assetId}/checkout`, {
        cookie: adminCookie,
        body: { toUserId: employeeId },
      });
      await api(`/api/custody/accept`, {
        cookie: employeeCookie,
        body: { handshakeId: co.body.handshakeId, otp: co.body.devOtp },
      });
      await api(`/api/assets/${assetId}/return`, { method: "POST", cookie: employeeCookie });

      const inspect = await api(`/api/assets/${assetId}/inspect`, {
        cookie: adminCookie,
        body: { condition },
      });
      expect(inspect.body.toState).toBe("MAINTENANCE");
      expect(inspect.body.maintenanceLogId).not.toBeNull();
    },
  );

  it("UNUSABLE condition retires the asset", async () => {
    const { orgId, adminId, employeeId } = await seedScenario(owner);
    const assetId = await createAvailableAsset(owner, orgId, adminId);
    const adminCookie = await loginAs(adminId);
    const employeeCookie = await loginAs(employeeId);

    const co = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId },
    });
    await api(`/api/custody/accept`, {
      cookie: employeeCookie,
      body: { handshakeId: co.body.handshakeId, otp: co.body.devOtp },
    });
    await api(`/api/assets/${assetId}/return`, { method: "POST", cookie: employeeCookie });

    const inspect = await api(`/api/assets/${assetId}/inspect`, {
      cookie: adminCookie,
      body: { condition: "UNUSABLE" },
    });
    expect(inspect.body.toState).toBe("RETIRED");
    expect(inspect.body.maintenanceLogId).toBeNull();
  });

  it("lost -> recover -> inspect(GOOD) cycle", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const employeeCookie = await loginAs(employeeId);

    const co = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId },
    });
    await api(`/api/custody/accept`, {
      cookie: employeeCookie,
      body: { handshakeId: co.body.handshakeId, otp: co.body.devOtp },
    });

    const lost = await api(`/api/assets/${assetId}/lost`, {
      cookie: employeeCookie,
      body: { notes: "left on a train" },
    });
    expect(lost.status).toBe(200);
    expect(lost.body.toState).toBe("LOST");

    const recover = await api(`/api/assets/${assetId}/recover`, {
      cookie: adminCookie,
      body: { notes: "returned by a stranger" },
    });
    expect(recover.status).toBe(200);
    expect(recover.body.toState).toBe("UNDER_INSPECTION");

    const inspect = await api(`/api/assets/${assetId}/inspect`, {
      cookie: adminCookie,
      body: { condition: "GOOD" },
    });
    expect(inspect.body.toState).toBe("AVAILABLE");
  });

  describe("RBAC", () => {
    it("an EMPLOYEE cannot initiate a checkout (403)", async () => {
      const { employeeId, assetId } = await seedScenario(owner);
      const cookie = await loginAs(employeeId);

      const res = await api(`/api/assets/${assetId}/checkout`, {
        cookie,
        body: { toUserId: employeeId },
      });
      expect(res.status).toBe(403);
    });

    it("an EMPLOYEE cannot view the audit timeline (403)", async () => {
      const { employeeId, assetId } = await seedScenario(owner);
      const cookie = await loginAs(employeeId);

      const res = await api(`/api/assets/${assetId}/timeline`, { method: "GET", cookie });
      expect(res.status).toBe(403);
    });

    it("an unauthenticated request is rejected", async () => {
      const { assetId } = await seedScenario(owner);
      const res = await api(`/api/assets/${assetId}/checkout`, { body: { toUserId: assetId } });
      expect([401, 403]).toContain(res.status);
    });

    it("an EMPLOYEE who is not the holder cannot return the asset (a MANAGER can)", async () => {
      const { adminId, employeeId, managerId, assetId } = await seedScenario(owner);
      const adminCookie = await loginAs(adminId);
      const employeeCookie = await loginAs(employeeId);
      const managerCookie = await loginAs(managerId);

      const co = await api(`/api/assets/${assetId}/checkout`, {
        cookie: adminCookie,
        body: { toUserId: employeeId },
      });
      await api(`/api/custody/accept`, {
        cookie: employeeCookie,
        body: { handshakeId: co.body.handshakeId, otp: co.body.devOtp },
      });

      const otherEmployeeCookie = await loginAs((await seedScenario(owner)).employeeId);
      const deniedResult = await api(`/api/assets/${assetId}/return`, {
        method: "POST",
        cookie: otherEmployeeCookie,
      });
      expect(deniedResult.status).toBe(403);

      // Confirms the 403 above is genuinely about "not the holder", not a
      // blanket rule against non-admins returning assets: a MANAGER acting on
      // the employee's behalf is explicitly permitted by the route's RBAC.
      const managerResult = await api(`/api/assets/${assetId}/return`, {
        method: "POST",
        cookie: managerCookie,
      });
      expect(managerResult.status).toBe(200);
    });

    it("only the OTP recipient can accept custody, not the admin who initiated it", async () => {
      const { adminId, employeeId, assetId } = await seedScenario(owner);
      const adminCookie = await loginAs(adminId);

      const co = await api(`/api/assets/${assetId}/checkout`, {
        cookie: adminCookie,
        body: { toUserId: employeeId },
      });
      const res = await api(`/api/custody/accept`, {
        cookie: adminCookie,
        body: { handshakeId: co.body.handshakeId, otp: co.body.devOtp },
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("NOT_RECIPIENT");
    });

    it("a wrong OTP is rejected without accepting custody", async () => {
      const { adminId, employeeId, assetId } = await seedScenario(owner);
      const adminCookie = await loginAs(adminId);
      const employeeCookie = await loginAs(employeeId);

      const co = await api(`/api/assets/${assetId}/checkout`, {
        cookie: adminCookie,
        body: { toUserId: employeeId },
      });
      const res = await api(`/api/custody/accept`, {
        cookie: employeeCookie,
        body: { handshakeId: co.body.handshakeId, otp: "000000" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("OTP_INVALID");
    });
  });

  describe("Illegal transitions return 409", () => {
    it("returning an AVAILABLE asset (never checked out) is rejected as 409", async () => {
      const { adminId, assetId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);

      const res = await api(`/api/assets/${assetId}/return`, { method: "POST", cookie });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/Illegal transition/);
    });

    it("checking out an already-PENDING_ACCEPTANCE asset again is rejected as 409", async () => {
      const { adminId, employeeId, managerId, assetId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);

      await api(`/api/assets/${assetId}/checkout`, { cookie, body: { toUserId: employeeId } });
      const second = await api(`/api/assets/${assetId}/checkout`, {
        cookie,
        body: { toUserId: managerId },
      });
      expect(second.status).toBe(409);
    });

    it("inspecting an asset that is not UNDER_INSPECTION is rejected as 409", async () => {
      const { adminId, assetId } = await seedScenario(owner);
      const cookie = await loginAs(adminId);

      const res = await api(`/api/assets/${assetId}/inspect`, {
        cookie,
        body: { condition: "GOOD" },
      });
      expect(res.status).toBe(409);
    });
  });
});
