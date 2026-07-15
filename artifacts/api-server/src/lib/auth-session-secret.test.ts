import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("drizzle-orm", async () => (await import("../test/fakeDb")).drizzleOrmMock);
vi.mock("@workspace/db", async () => (await import("../test/fakeDb")).dbModuleMock);
vi.mock(
  "connect-pg-simple",
  async () => (await import("../test/fakeDb")).connectPgSimpleMock,
);

const ENV_KEYS = ["NODE_ENV", "SESSION_SECRET"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
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
  return await import("./auth");
}

describe("buildSessionMiddleware() production session-secret guard", () => {
  it("throws in production when SESSION_SECRET is unset", async () => {
    process.env.NODE_ENV = "production";
    const { buildSessionMiddleware } = await freshAuthLib();
    expect(() => buildSessionMiddleware()).toThrow(
      /SESSION_SECRET.*required in production/,
    );
  });

  it("works in production when SESSION_SECRET is set", async () => {
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "a-real-session-secret";
    const { buildSessionMiddleware } = await freshAuthLib();
    const middleware = buildSessionMiddleware();
    expect(typeof middleware).toBe("function");
  });

  it("works in development without SESSION_SECRET", async () => {
    process.env.NODE_ENV = "development";
    const { buildSessionMiddleware } = await freshAuthLib();
    const middleware = buildSessionMiddleware();
    expect(typeof middleware).toBe("function");
  });
});
