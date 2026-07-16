import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import type { Server } from "http";
import { fakeDb, tables, state, resetFakeDb } from "../test/fakeDb";

vi.mock("drizzle-orm", async () => (await import("../test/fakeDb")).drizzleOrmMock);
vi.mock("@workspace/db", async () => (await import("../test/fakeDb")).dbModuleMock);
vi.mock(
  "connect-pg-simple",
  async () => (await import("../test/fakeDb")).connectPgSimpleMock,
);

process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_ALLOWED_DOMAIN = "sageoak.education";
process.env.APP_BASE_URL = "https://dashboard.example.com";

import app from "../app";

let server: Server;
let baseUrl: string;
const realFetch = globalThis.fetch;

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

beforeEach(() => {
  resetFakeDb();
  fakeDb.rows(tables.usersTable).push({
    id: 1,
    email: "admin@sageoak.education",
    passwordHash: "some-hash",
    googleId: null,
    displayName: "Administrator",
    role: "admin",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  state.idCounter = 1;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeIdToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.signature`;
}

/** Mock Google's token endpoint while passing through local requests. */
function mockGoogleTokenExchange(claims: Record<string, unknown> | null) {
  const fetchMock = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        if (claims === null) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
          });
        }
        return new Response(
          JSON.stringify({ id_token: makeIdToken(claims) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return realFetch(input, init);
    },
  );
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

class SsoClient {
  cookie: string | null = null;

  async get(path: string) {
    const res = await realFetch(`${baseUrl}/api${path}`, {
      redirect: "manual",
      headers: this.cookie ? { Cookie: this.cookie } : {},
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    return res;
  }

  /** Runs /auth/google then the callback with the issued state. */
  async completeFlow(callbackQueryOverrides?: Record<string, string>) {
    const start = await this.get("/auth/google");
    expect(start.status).toBe(302);
    const location = start.headers.get("location")!;
    const authUrl = new URL(location);
    const state = authUrl.searchParams.get("state")!;
    const params = new URLSearchParams({
      code: "auth-code",
      state,
      ...callbackQueryOverrides,
    });
    return this.get(`/auth/google/callback?${params.toString()}`);
  }

  async me() {
    const res = await realFetch(`${baseUrl}/api/auth/me`, {
      headers: this.cookie ? { Cookie: this.cookie } : {},
    });
    return { status: res.status, body: (await res.json()) as any };
  }
}

describe("GET /api/auth/config", () => {
  it("reports Google SSO enabled when configured", async () => {
    const res = await realFetch(`${baseUrl}/api/auth/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ googleEnabled: true });
  });
});

describe("GET /api/auth/google", () => {
  it("redirects to Google with client id, redirect uri, domain hint and state", async () => {
    const res = await new SsoClient().get("/auth/google");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://dashboard.example.com/api/auth/google/callback",
    );
    expect(url.searchParams.get("hd")).toBe("sageoak.education");
    expect(url.searchParams.get("state")).toBeTruthy();
  });
});

describe("GET /api/auth/google/callback", () => {
  it("auto-provisions a new staff user for an allowed-domain account", async () => {
    mockGoogleTokenExchange({
      sub: "google-sub-123",
      email: "New.Teacher@sageoak.education",
      email_verified: true,
      name: "New Teacher",
      hd: "sageoak.education",
    });
    const client = new SsoClient();
    const res = await client.completeFlow();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const me = await client.me();
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("new.teacher@sageoak.education");
    expect(me.body.role).toBe("staff");
    expect(me.body.displayName).toBe("New Teacher");

    const rows = fakeDb.rows(tables.usersTable);
    expect(rows).toHaveLength(2);
    const created = rows.find((r) => r.email === "new.teacher@sageoak.education")!;
    expect(created.googleId).toBe("google-sub-123");
    expect(created.passwordHash).toBeNull();
  });

  it("links to an existing user by email and preserves their role", async () => {
    mockGoogleTokenExchange({
      sub: "google-sub-admin",
      email: "admin@sageoak.education",
      email_verified: true,
      name: "Google Name",
      hd: "sageoak.education",
    });
    const client = new SsoClient();
    const res = await client.completeFlow();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const me = await client.me();
    expect(me.status).toBe(200);
    expect(me.body.role).toBe("admin");
    expect(me.body.displayName).toBe("Administrator");

    const rows = fakeDb.rows(tables.usersTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.googleId).toBe("google-sub-admin");
    expect(rows[0]!.passwordHash).toBe("some-hash");
  });

  it("rejects accounts outside the allowed domain and creates no user", async () => {
    mockGoogleTokenExchange({
      sub: "google-sub-outsider",
      email: "someone@gmail.com",
      email_verified: true,
      name: "Outsider",
    });
    const client = new SsoClient();
    const res = await client.completeFlow();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?ssoError=wrong_domain");

    const me = await client.me();
    expect(me.status).toBe(401);
    expect(fakeDb.rows(tables.usersTable)).toHaveLength(1);
  });

  it("rejects a mismatched hd claim even if the email domain matches", async () => {
    mockGoogleTokenExchange({
      sub: "google-sub-spoof",
      email: "spoof@sageoak.education",
      email_verified: true,
      hd: "attacker.example",
    });
    const res = await new SsoClient().completeFlow();
    expect(res.headers.get("location")).toBe("/?ssoError=wrong_domain");
    expect(fakeDb.rows(tables.usersTable)).toHaveLength(1);
  });

  it("rejects unverified emails", async () => {
    mockGoogleTokenExchange({
      sub: "google-sub-unverified",
      email: "unverified@sageoak.education",
      email_verified: false,
      hd: "sageoak.education",
    });
    const res = await new SsoClient().completeFlow();
    expect(res.headers.get("location")).toBe("/?ssoError=google_failed");
    expect(fakeDb.rows(tables.usersTable)).toHaveLength(1);
  });

  it("fails cleanly when the token exchange fails", async () => {
    mockGoogleTokenExchange(null);
    const res = await new SsoClient().completeFlow();
    expect(res.headers.get("location")).toBe("/?ssoError=google_failed");
  });

  it("rejects a state mismatch without calling Google", async () => {
    const fetchMock = mockGoogleTokenExchange({
      sub: "x",
      email: "x@sageoak.education",
      email_verified: true,
    });
    const client = new SsoClient();
    const res = await client.completeFlow({ state: "forged-state" });
    expect(res.headers.get("location")).toBe("/?ssoError=google_failed");
    expect(
      fetchMock.mock.calls.filter(([u]) =>
        String(u).startsWith("https://oauth2.googleapis.com"),
      ),
    ).toHaveLength(0);
  });

  it("rejects a callback with no session state", async () => {
    mockGoogleTokenExchange({
      sub: "x",
      email: "x@sageoak.education",
      email_verified: true,
    });
    const res = await new SsoClient().get(
      "/auth/google/callback?code=auth-code&state=whatever",
    );
    expect(res.headers.get("location")).toBe("/?ssoError=google_failed");
  });
});

describe("password login for Google-only accounts", () => {
  it("rejects password login when passwordHash is null", async () => {
    fakeDb.rows(tables.usersTable).push({
      id: 2,
      email: "ssouser@sageoak.education",
      passwordHash: null,
      googleId: "g-2",
      displayName: "SSO User",
      role: "staff",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const res = await realFetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ssouser@sageoak.education",
        password: "anything",
      }),
    });
    expect(res.status).toBe(401);
  });
});
