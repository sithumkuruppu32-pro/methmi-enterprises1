import { createHmac, randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/content-store.js", async (original) => {
  const actual = await original<typeof import("../../src/lib/content-store.js")>();
  return { ...actual, getAllTours: vi.fn(), getAllVehicles: vi.fn(), saveTour: vi.fn(), saveVehicle: vi.fn(), deleteTourBySlug: vi.fn(), deleteVehicleBySlug: vi.fn() };
});
vi.mock("../../src/lib/storage.js", () => ({ LOCAL_UPLOAD_DIR: "/nonexistent-unit-test-uploads", uploadImage: vi.fn() }));

import { createApp } from "../../src/app.js";
import * as store from "../../src/lib/content-store.js";
import { uploadImage } from "../../src/lib/storage.js";
import { DatabaseOperationError } from "../../src/lib/database-error.js";
import { ADMIN_SESSION_COOKIE } from "../../src/lib/admin-auth.js";
import { getSupabase } from "../../src/lib/supabase.js";
import { tourInput, vehicleInput, png } from "../fixtures.js";

const app = createApp();
const adminEmail = `ica6-admin-${randomBytes(12).toString("hex")}@example.invalid`;
const adminPassword = `Aa1!${randomBytes(24).toString("hex")}`;
let db: ReturnType<typeof getSupabase> | undefined;
let verifiedTestDatabase = false;
let adminUserId: string | undefined;
let cookie: string;
const tour = { ...tourInput, slug: "test-tour", highlights: ["Temple", "Beach"], included: ["Transport"] };
const vehicle = { ...vehicleInput, slug: "test-van" };
const endpointCases = [
  ["get", "/api/admin/tours"], ["post", "/api/admin/tours"],
  ["put", "/api/admin/tours/test-tour"], ["delete", "/api/admin/tours/test-tour"],
  ["get", "/api/admin/vehicles"], ["post", "/api/admin/vehicles"],
  ["put", "/api/admin/vehicles/test-van"], ["delete", "/api/admin/vehicles/test-van"],
  ["post", "/api/admin/upload"], ["get", "/api/admin/session"],
] as const;

function expiredCookie() {
  if (!adminUserId) throw new Error("The isolated test admin has not been created.");
  const payload = `${Date.now() - 60000}.${adminUserId}`;
  const signature = createHmac("sha256", process.env.ADMIN_SESSION_SECRET!).update(payload).digest("hex");
  return `${ADMIN_SESSION_COOKIE}=${payload}.${signature}`;
}

function forgedCookie() {
  // Retain the real expiry and user UUID, but change one signature character.
  return `${cookie.slice(0, -1)}${cookie.endsWith("0") ? "1" : "0"}`;
}

beforeAll(async () => {
  if (!process.env.TEST_SUPABASE_URL || !process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ||
      process.env.TEST_DATABASE_CONFIRM !== "ISOLATED_TEST_DATABASE") {
    throw new Error("Admin security tests require TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_ROLE_KEY and TEST_DATABASE_CONFIRM=ISOLATED_TEST_DATABASE. See TESTING.md.");
  }
  db = getSupabase();
  // No Auth or membership writes are allowed before the isolated database marker is verified.
  const marker = await db.from("app_meta").select("value").eq("key", "ica5_test_database").maybeSingle();
  if (marker.error || marker.data?.value !== "TEST_ONLY") {
    throw new Error("Refusing admin test writes: the isolated test database marker is missing. See TESTING.md.");
  }
  verifiedTestDatabase = true;

  const created = await db.auth.admin.createUser({ email: adminEmail, password: adminPassword, email_confirm: true });
  adminUserId = created.data.user?.id;
  if (created.error || !adminUserId) throw new Error("Could not create the confirmed isolated test admin Auth user.");
  const membership = await db.from("admins").insert({ email: adminEmail });
  if (membership.error) throw new Error("Could not add the isolated test email to the admins table.");

  const response = await request(app)
    .post("/api/admin/login")
    .type("json")
    .send({ email: adminEmail, password: adminPassword });
  expect(response.status, JSON.stringify(response.body)).toBe(200);

  const cookies = response.headers["set-cookie"];

  if (!cookies || cookies.length === 0) {
    throw new Error(`Admin login did not return a session cookie: ${JSON.stringify(response.body)}`);
  }

  cookie = cookies[0].split(";")[0];
});

afterAll(async () => {
  if (!verifiedTestDatabase || !db) return;
  const errors: string[] = [];
  // Always attempt both cleanups, including when beforeAll failed after creating the Auth user.
  // Only this run's unpredictable email and the returned owned user ID may be deleted.
  try {
    const removed = await db.from("admins").delete().eq("email", adminEmail);
    if (removed.error) errors.push("admin membership");
  } catch {
    errors.push("admin membership");
  }
  if (adminUserId) {
    try {
      const removed = await db.auth.admin.deleteUser(adminUserId);
      if (removed.error) errors.push("Auth user");
    } catch {
      errors.push("Auth user");
    }
  }
  if (errors.length) {
    throw new Error(`Isolated admin test cleanup incomplete (${errors.join(", ")}). Remove only test email ${adminEmail} and Auth user ${adminUserId ?? "not created"}.`);
  }
});

beforeEach(() => {
  vi.mocked(store.getAllTours).mockResolvedValue([tour]);
  vi.mocked(store.getAllVehicles).mockResolvedValue([vehicle]);
  vi.mocked(store.saveTour).mockImplementation(async (value) => value);
  vi.mocked(store.saveVehicle).mockImplementation(async (value) => value);
  vi.mocked(store.deleteTourBySlug).mockResolvedValue(true);
  vi.mocked(store.deleteVehicleBySlug).mockResolvedValue(true);
  vi.mocked(uploadImage).mockResolvedValue({ path: "https://example.invalid/test.png", storage: "supabase" });
});

describe("Real Supabase admin login and server session enforcement", () => {
  it("rejects a missing email without issuing a session", async () => {
    const response = await request(app).post("/api/admin/login").send({ password: adminPassword });
    expect(response.status).toBe(400);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
  it("rejects an incorrect password and does not issue a session", async () => {
    const response = await request(app).post("/api/admin/login").send({ email: adminEmail, password: "wrong-test-password" });
    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
  it("issues the existing HttpOnly cookie and allows the session endpoint", async () => {
    const response = await request(app).post("/api/admin/login").send({ email: adminEmail, password: adminPassword });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
    expect((await request(app).get("/api/admin/session").set("Cookie", cookie)).body.authenticated).toBe(true);
  });
  it("clears the existing cookie when logging out", async () => {
    const response = await request(app).post("/api/admin/logout").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"][0]).toContain("Max-Age=0");
  });
  it("rejects valid non-admin credentials and revokes an existing session when membership is removed", async () => {
    if (!db) throw new Error("The isolated test database has not been configured.");
    const removed = await db.from("admins").delete().eq("email", adminEmail);
    expect(removed.error).toBeNull();
    try {
      const login = await request(app).post("/api/admin/login").send({ email: adminEmail, password: adminPassword });
      expect(login.status, JSON.stringify(login.body)).toBe(403);
      expect(login.headers["set-cookie"]).toBeUndefined();
      const session = await request(app).get("/api/admin/session").set("Cookie", cookie);
      expect(session.status).toBe(401);
      expect(session.body.authenticated).toBe(false);
      const create = await request(app).post("/api/admin/tours").set("Cookie", cookie).send(tourInput);
      expect(create.status).toBe(401);
      expect(store.saveTour).not.toHaveBeenCalled();
      expect(store.getAllTours).not.toHaveBeenCalled();
    } finally {
      const restored = await db.from("admins").insert({ email: adminEmail });
      if (restored.error) throw new Error("Could not restore the isolated test admin membership.");
    }
  });
  for (const [method, path] of endpointCases) {
    it(`${method.toUpperCase()} ${path}: no session returns 401 before storage access`, async () => {
      const response = await request(app)[method](path).send({ role: "admin", owner: "someone" });
      expect(response.status).toBe(401);
      expect(store.saveTour).not.toHaveBeenCalled();
      expect(store.saveVehicle).not.toHaveBeenCalled();
      expect(store.deleteTourBySlug).not.toHaveBeenCalled();
      expect(store.deleteVehicleBySlug).not.toHaveBeenCalled();
      expect(store.getAllTours).not.toHaveBeenCalled();
      expect(store.getAllVehicles).not.toHaveBeenCalled();
      expect(uploadImage).not.toHaveBeenCalled();
    });
    it(`${method.toUpperCase()} ${path}: forged or expired sessions return 401`, async () => {
      for (const session of [forgedCookie(), expiredCookie()]) {
        const response = await request(app)[method](path).set("Cookie", session).send({});
        expect(response.status).toBe(401);
      }
      expect(store.saveTour).not.toHaveBeenCalled();
      expect(store.saveVehicle).not.toHaveBeenCalled();
      expect(store.deleteTourBySlug).not.toHaveBeenCalled();
      expect(store.deleteVehicleBySlug).not.toHaveBeenCalled();
      expect(uploadImage).not.toHaveBeenCalled();
    });
  }
});

describe("Admin request validation and safe errors (mocked persistence)", () => {
  for (const [resource, input, existing] of [["tours", tourInput, "test-tour"], ["vehicles", vehicleInput, "test-van"]] as const) {
    it(`${resource}: allows an authenticated admin to read/create/update/delete`, async () => {
      expect((await request(app).get(`/api/admin/${resource}`).set("Cookie", cookie)).status).toBe(200);
      expect((await request(app).post(`/api/admin/${resource}`).set("Cookie", cookie).send(input)).status).toBe(201);
      expect((await request(app).put(`/api/admin/${resource}/${existing}`).set("Cookie", cookie).send(input)).status).toBe(200);
      expect((await request(app).delete(`/api/admin/${resource}/${existing}`).set("Cookie", cookie)).status).toBe(200);
    });
    it(`${resource}: rejects unknown fields on create and update without writing`, async () => {
      expect((await request(app).post(`/api/admin/${resource}`).set("Cookie", cookie).send({ ...input, owner: "other" })).status).toBe(400);
      expect((await request(app).put(`/api/admin/${resource}/${existing}`).set("Cookie", cookie).send({ ...input, role: "admin" })).status).toBe(400);
      expect(store.saveTour).not.toHaveBeenCalled();
      expect(store.saveVehicle).not.toHaveBeenCalled();
    });
    it(`${resource}: missing updates and deletes return 404`, async () => {
      vi.mocked(store.deleteTourBySlug).mockResolvedValue(false);
      vi.mocked(store.deleteVehicleBySlug).mockResolvedValue(false);
      expect((await request(app).put(`/api/admin/${resource}/missing`).set("Cookie", cookie).send(input)).status).toBe(404);
      expect((await request(app).delete(`/api/admin/${resource}/missing`).set("Cookie", cookie)).status).toBe(404);
    });
    it(`${resource}: malformed record slugs return 400`, async () => {
      expect((await request(app).delete(`/api/admin/${resource}/invalid!`).set("Cookie", cookie)).status).toBe(400);
    });
    it(`${resource}: database unique violations return 409`, async () => {
      vi.mocked(store.saveTour).mockRejectedValue(new DatabaseOperationError("That record already exists.", 409));
      vi.mocked(store.saveVehicle).mockRejectedValue(new DatabaseOperationError("That record already exists.", 409));
      expect((await request(app).post(`/api/admin/${resource}`).set("Cookie", cookie).send(input)).status).toBe(409);
    });
  }
  it("duplicate slug updates return 409 without writing", async () => {
    vi.mocked(store.getAllTours).mockResolvedValue([tour, { ...tour, slug: "taken" }]);
    vi.mocked(store.getAllVehicles).mockResolvedValue([vehicle, { ...vehicle, slug: "taken" }]);
    expect((await request(app).put("/api/admin/tours/test-tour").set("Cookie", cookie).send({ ...tourInput, slug: "taken" })).status).toBe(409);
    expect((await request(app).put("/api/admin/vehicles/test-van").set("Cookie", cookie).send({ ...vehicleInput, slug: "taken" })).status).toBe(409);
    expect(store.saveTour).not.toHaveBeenCalled();
    expect(store.saveVehicle).not.toHaveBeenCalled();
  });
  it("returns a safe 500 when async database reads fail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(store.getAllTours).mockRejectedValue(new Error("sensitive database details"));
    const response = await request(app).get("/api/admin/tours").set("Cookie", cookie);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("sensitive database details");
    log.mockRestore();
  });
  it("rejects malformed JSON with 400", async () => {
    const response = await request(app).post("/api/admin/tours").set("Cookie", cookie).type("json").send('{"name":');
    expect(response.status).toBe(400);
  });
  it("allows an authenticated image upload", async () => {
    const response = await request(app).post("/api/admin/upload").set("Cookie", cookie).field("target", "tours").field("slug", "test-image").attach("file", png, { filename: "image.png", contentType: "image/png" });
    expect(response.status).toBe(200);
    expect(uploadImage).toHaveBeenCalledWith(png, "image/png", "tours", expect.stringMatching(/^test-image-\d+\.png$/));
  });
  it("rejects unexpected upload fields before storing a file", async () => {
    const response = await request(app).post("/api/admin/upload").set("Cookie", cookie).field("owner", "someone").attach("file", png, "image.png");
    expect(response.status).toBe(400);
    expect(uploadImage).not.toHaveBeenCalled();
  });
  it("rejects an invalid upload target or MIME type", async () => {
    expect((await request(app).post("/api/admin/upload").set("Cookie", cookie).field("target", "private").attach("file", png, "image.png")).status).toBe(400);
    expect((await request(app).post("/api/admin/upload").set("Cookie", cookie).attach("file", Buffer.from("text"), "file.txt")).status).toBe(400);
    expect(uploadImage).not.toHaveBeenCalled();
  });
  it("does not expose storage service errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(uploadImage).mockRejectedValue(new Error("private storage key details"));
    const response = await request(app).post("/api/admin/upload").set("Cookie", cookie).attach("file", png, "image.png");
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("private storage key details");
    log.mockRestore();
  });
});
