import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ownerClient, seedScenario } from "../helpers/db";
import { api, loginAs } from "../helpers/api";
import type { Client } from "pg";

const TINY_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

/** One character short of the 2MB payload cap enforced in the checkout/return routes. */
const OVERSIZED_PHOTO = "data:image/jpeg;base64," + "A".repeat(2_100_000);

describe("API: condition photos on checkout / return", () => {
  let owner: Client;

  beforeAll(async () => {
    owner = ownerClient();
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
  });

  async function payloadPhoto(assetId: string, eventType: string): Promise<string | null> {
    const r = await owner.query(
      `SELECT payload->>'photoUrl' AS photo FROM asset_state_event
       WHERE asset_id = $1 AND event_type = $2
       ORDER BY asset_version DESC LIMIT 1`,
      [assetId, eventType],
    );
    return r.rows[0]?.photo ?? null;
  }

  it("a checkout photo is stored on the asset.assigned event and nowhere else", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);

    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId, photoUrl: TINY_JPEG },
    });
    expect(checkout.status).toBe(200);

    expect(await payloadPhoto(assetId, "asset.assigned")).toBe(TINY_JPEG);
    expect(await payloadPhoto(assetId, "asset.intake")).toBeNull();
  });

  it("a return photo is stored on the asset.returned event, independent of the checkout photo", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const employeeCookie = await loginAs(employeeId);

    const checkoutPhoto = TINY_JPEG;
    const returnPhoto =
      "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCVAB9k//9k=";

    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId, photoUrl: checkoutPhoto },
    });
    await api(`/api/custody/accept`, {
      cookie: employeeCookie,
      body: { handshakeId: checkout.body.handshakeId, otp: checkout.body.devOtp },
    });

    const ret = await api(`/api/assets/${assetId}/return`, {
      cookie: employeeCookie,
      body: { photoUrl: returnPhoto },
    });
    expect(ret.status).toBe(200);

    expect(await payloadPhoto(assetId, "asset.assigned")).toBe(checkoutPhoto);
    expect(await payloadPhoto(assetId, "asset.returned")).toBe(returnPhoto);
    // custody.accepted never takes a photo — it must not have picked either one up.
    expect(await payloadPhoto(assetId, "custody.accepted")).toBeNull();
  });

  it("checkout without a photo still succeeds, with photoUrl null on the event", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);

    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie,
      body: { toUserId: employeeId },
    });
    expect(checkout.status).toBe(200);
    expect(await payloadPhoto(assetId, "asset.assigned")).toBeNull();
  });

  it("return without a photo still succeeds (legacy callers with no body)", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const employeeCookie = await loginAs(employeeId);

    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId },
    });
    await api(`/api/custody/accept`, {
      cookie: employeeCookie,
      body: { handshakeId: checkout.body.handshakeId, otp: checkout.body.devOtp },
    });

    // No body at all — the pre-photo-feature ActionButton client never sent one.
    const ret = await api(`/api/assets/${assetId}/return`, {
      method: "POST",
      cookie: employeeCookie,
    });
    expect(ret.status).toBe(200);
    expect(await payloadPhoto(assetId, "asset.returned")).toBeNull();
  });

  it("an oversized checkout photo is rejected with 400 and the checkout never happens", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);

    const res = await api(`/api/assets/${assetId}/checkout`, {
      cookie,
      body: { toUserId: employeeId, photoUrl: OVERSIZED_PHOTO },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);

    const state = await owner.query(`SELECT current_state FROM asset WHERE id=$1`, [assetId]);
    expect(state.rows[0].current_state).toBe("AVAILABLE");
  });

  it("an oversized return photo is rejected with 400 and the asset stays ASSIGNED_ACTIVE", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const adminCookie = await loginAs(adminId);
    const employeeCookie = await loginAs(employeeId);

    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie: adminCookie,
      body: { toUserId: employeeId },
    });
    await api(`/api/custody/accept`, {
      cookie: employeeCookie,
      body: { handshakeId: checkout.body.handshakeId, otp: checkout.body.devOtp },
    });

    const res = await api(`/api/assets/${assetId}/return`, {
      cookie: employeeCookie,
      body: { photoUrl: OVERSIZED_PHOTO },
    });
    expect(res.status).toBe(400);

    const state = await owner.query(`SELECT current_state FROM asset WHERE id=$1`, [assetId]);
    expect(state.rows[0].current_state).toBe("ASSIGNED_ACTIVE");
  });

  it("a non-string photoUrl is rejected rather than passed through to the database", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);

    const res = await api(`/api/assets/${assetId}/checkout`, {
      cookie,
      body: { toUserId: employeeId, photoUrl: { not: "a string" } },
    });
    expect(res.status).toBe(400);
  });

  it("the photo travels through the outbox event payload alongside the rest of the checkout data", async () => {
    const { adminId, employeeId, assetId } = await seedScenario(owner);
    const cookie = await loginAs(adminId);

    const checkout = await api(`/api/assets/${assetId}/checkout`, {
      cookie,
      body: { toUserId: employeeId, photoUrl: TINY_JPEG },
    });
    expect(checkout.status).toBe(200);

    const outbox = await owner.query(
      `SELECT data->>'photoUrl' AS photo FROM event_outbox WHERE event_id = $1`,
      [checkout.body.outboxEventId],
    );
    expect(outbox.rows[0]?.photo).toBe(TINY_JPEG);
  });
});
