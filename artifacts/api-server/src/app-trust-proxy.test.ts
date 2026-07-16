import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("drizzle-orm", async () => (await import("./test/fakeDb")).drizzleOrmMock);
vi.mock("@workspace/db", async () => (await import("./test/fakeDb")).dbModuleMock);
vi.mock(
  "connect-pg-simple",
  async () => (await import("./test/fakeDb")).connectPgSimpleMock,
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

/** Import a fresh copy of the app so module-level setup re-runs. */
async function freshApp() {
  vi.resetModules();
  return (await import("./app")).default;
}

describe("Express app proxy trust", () => {
  it("trusts the first proxy hop in production so secure cookies survive", async () => {
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "a-real-session-secret";
    const app = await freshApp();

    expect(app.get("trust proxy")).toBe(1);
  });

  it("trusts the first proxy hop in development too", async () => {
    process.env.NODE_ENV = "development";
    const app = await freshApp();

    expect(app.get("trust proxy")).toBe(1);
  });
});
