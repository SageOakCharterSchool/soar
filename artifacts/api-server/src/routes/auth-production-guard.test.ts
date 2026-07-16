import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import bcrypt from "bcryptjs";
import type { Server } from "http";
import { fakeDb, tables, resetFakeDb } from "../test/fakeDb";

vi.mock("drizzle-orm", async () => (await import("../test/fakeDb")).drizzleOrmMock);
vi.mock("@workspace/db", async () => (await import("../test/fakeDb")).dbModuleMock);
vi.mock(
  "connect-pg-simple",
  async () => (await import("../test/fakeDb")).connectPgSimpleMock,
);

import app from "../app";
import { DEFAULT_DEV_ADMIN_PASSWORD } from "../lib/auth";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("No port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ENV_KEYS = ["NODE_ENV", "ADMIN_EMAIL", "ADMIN_PASSWORD"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  resetFakeDb();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Import a fresh copy of lib/auth so its module-level NODE_ENV check re-runs. */
async function freshAuthLib() {
  vi.resetModules();
  return await import("../lib/auth");
}

describe("seed() production guards", () => {
  it("throws in production when ADMIN_PASSWORD is unset", async () => {
    process.env.NODE_ENV = "production";
    const { seed } = await freshAuthLib();
    await expect(seed()).rejects.toThrow(/ADMIN_PASSWORD.*required in production/);
    expect(fakeDb.rows(tables.usersTable)).toHaveLength(0);
  });

  it("throws in production when ADMIN_PASSWORD equals the dev default", async () => {
    process.env.NODE_ENV = "production";
    process.env.ADMIN_EMAIL = "admin@sageoak.org";
    process.env.ADMIN_PASSWORD = DEFAULT_DEV_ADMIN_PASSWORD;
    const { seed } = await freshAuthLib();
    await expect(seed()).rejects.toThrow(/well-known development default/);
    expect(fakeDb.rows(tables.usersTable)).toHaveLength(0);
  });

  it("seeds the admin in production with a real password", async () => {
    process.env.NODE_ENV = "production";
    process.env.ADMIN_EMAIL = "admin@sageoak.org";
    process.env.ADMIN_PASSWORD = "a-real-secret-password";
    const { seed } = await freshAuthLib();
    await seed();
    const users = fakeDb.rows(tables.usersTable);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "admin@sageoak.org", role: "admin" });
    expect(
      await bcrypt.compare("a-real-secret-password", users[0]!.passwordHash as string),
    ).toBe(true);
  });

  it("still seeds the default admin in development when ADMIN_PASSWORD is unset", async () => {
    process.env.NODE_ENV = "development";
    const { seed } = await freshAuthLib();
    await seed();
    const users = fakeDb.rows(tables.usersTable);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "admin@sageoak.org", role: "admin" });
    expect(
      await bcrypt.compare(
        DEFAULT_DEV_ADMIN_PASSWORD,
        users[0]!.passwordHash as string,
      ),
    ).toBe(true);
  });
});

describe("login guard against the default dev password", () => {
  const EMAIL = "admin@sageoak.org";

  async function seedAdminWithDefaultPassword() {
    fakeDb.rows(tables.usersTable).push({
      id: 1,
      email: EMAIL,
      passwordHash: await bcrypt.hash(DEFAULT_DEV_ADMIN_PASSWORD, 4),
      displayName: "Administrator",
      role: "admin",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
  }

  async function login(password: string) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password }),
    });
    return { status: res.status, body: (await res.json()) as { message?: string } };
  }

  it("returns 401 in production for the default password, even if it matches the stored hash", async () => {
    await seedAdminWithDefaultPassword();
    process.env.NODE_ENV = "production";
    const res = await login(DEFAULT_DEV_ADMIN_PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password");
  });

  it("still allows the default password in development", async () => {
    await seedAdminWithDefaultPassword();
    process.env.NODE_ENV = "development";
    const res = await login(DEFAULT_DEV_ADMIN_PASSWORD);
    expect(res.status).toBe(200);
  });
});
