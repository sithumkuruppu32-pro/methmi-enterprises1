import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";

// These values exist only in the test process. Never load normal .env files.
// Admin login uses real Supabase Auth in an explicitly isolated test database.
const file = new URL("../../.env.test.local", import.meta.url);
const config = existsSync(file) ? parse(readFileSync(file)) : {};
const url = process.env.TEST_SUPABASE_URL || config.TEST_SUPABASE_URL;
const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY || config.TEST_SUPABASE_SERVICE_ROLE_KEY;
const confirmation = process.env.TEST_DATABASE_CONFIRM || config.TEST_DATABASE_CONFIRM;
if (url || key || confirmation) {
  if (!url || !key || confirmation !== "ISOLATED_TEST_DATABASE") {
    throw new Error("Real admin tests require TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_ROLE_KEY and TEST_DATABASE_CONFIRM=ISOLATED_TEST_DATABASE.");
  }
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Invalid test database URL.");
  if (process.env.SUPABASE_URL && new URL(process.env.SUPABASE_URL).origin === parsedUrl.origin) {
    throw new Error("Test database URL matches the application's inherited SUPABASE_URL. Use a separate test project.");
  }
  process.env.TEST_SUPABASE_URL = url;
  process.env.TEST_SUPABASE_SERVICE_ROLE_KEY = key;
  process.env.TEST_DATABASE_CONFIRM = confirmation;
}
process.env.NODE_ENV = "test";
process.env.ADMIN_PASSWORD = randomBytes(24).toString("hex");
process.env.ADMIN_SESSION_SECRET = randomBytes(32).toString("hex");
process.env.SUPABASE_URL = url || "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = key || "unit-test-only-not-a-live-key";
process.env.SUPABASE_STORAGE_BUCKET = "unit-tests-only";
for (const key of ["RESEND_API_KEY", "BUSINESS_EMAIL", "EMAIL_FROM", "COOKIE_DOMAIN", "COOKIE_SECURE", "COOKIE_SAMESITE"]) delete process.env[key];
