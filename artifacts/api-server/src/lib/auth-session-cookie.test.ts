import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CookieOptions, SessionOptions } from "express-session";

vi.mock("drizzle-orm", async () => (await import("../test/fakeDb")).drizzleOrmMock);
vi.mock("@workspace/db", async () => (await import("../test/fakeDb")).dbModuleMock);
vi.mock(
  "connect-pg-simple",
  async () => (await import("../test/fakeDb")).connectPgSimpleMock,
);

const capturedOptions: SessionOptions[] = [];

vi.mock("express-session", async () => {
  const actual = (await vi.importActual("express-session")) as {
    default: (options: SessionOptions) => unknown;
  } & Record<string, unknown>;
  const sessionSpy = (options: SessionOptions) => {
    capturedOptions.push(options);
    return actual.default(options);
  };
  Object.assign(sessionSpy, actual.default);
  return { ...actual, default: sessionSpy };
});

const ENV_KEYS = ["NODE_ENV", "SESSION_SECRET"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  capturedOptions.length = 0;
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

const FOURTEEN_DAYS_MS = 1000 * 60 * 60 * 24 * 14;

function cookieOf(options: SessionOptions): CookieOptions {
  const cookie = options.cookie;
  expect(cookie).toBeDefined();
  expect(typeof cookie).not.toBe("function");
  return cookie as CookieOptions;
}

describe("buildSessionMiddleware() cookie configuration", () => {
  it("uses secure, sameSite 'none' cookies in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "a-real-session-secret";
    const { buildSessionMiddleware } = await freshAuthLib();
    buildSessionMiddleware();

    expect(capturedOptions).toHaveLength(1);
    const cookie = cookieOf(capturedOptions[0]);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe("none");
  });

  it("uses non-secure, sameSite 'lax' cookies in development", async () => {
    process.env.NODE_ENV = "development";
    const { buildSessionMiddleware } = await freshAuthLib();
    buildSessionMiddleware();

    expect(capturedOptions).toHaveLength(1);
    const cookie = cookieOf(capturedOptions[0]);
    expect(cookie.secure).toBe(false);
    expect(cookie.sameSite).toBe("lax");
  });

  it("always sets httpOnly and a 14-day maxAge", async () => {
    for (const env of ["production", "development"] as const) {
      capturedOptions.length = 0;
      process.env.NODE_ENV = env;
      process.env.SESSION_SECRET =
        env === "production" ? "a-real-session-secret" : undefined!;
      if (env !== "production") delete process.env.SESSION_SECRET;
      const { buildSessionMiddleware } = await freshAuthLib();
      buildSessionMiddleware();

      expect(capturedOptions).toHaveLength(1);
      const cookie = cookieOf(capturedOptions[0]);
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.maxAge).toBe(FOURTEEN_DAYS_MS);
    }
  });

  it("does not persist sessions unnecessarily (resave/saveUninitialized off)", async () => {
    process.env.NODE_ENV = "development";
    const { buildSessionMiddleware } = await freshAuthLib();
    buildSessionMiddleware();

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].resave).toBe(false);
    expect(capturedOptions[0].saveUninitialized).toBe(false);
    expect(capturedOptions[0].name).toBe("sageoak.sid");
  });
});
