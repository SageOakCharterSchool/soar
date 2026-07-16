/**
 * Live-badge stream check: verifies the server-sent events stream that powers
 * the Rostering "new updates" badge keeps working when the app runs behind a
 * proxy (Replit/Railway deployments buffer or time out long-lived responses
 * unless the stream is set up correctly). Runs against any base URL and
 * checks, step by step, that:
 *
 *   1. Login succeeds and a session cookie is issued
 *   2. GET /api/rostering/events opens with the proper SSE headers and the
 *      initial "retry:" line arrives unbuffered
 *   3. The connection stays open long enough to receive a heartbeat ping
 *      (sent every 25s server-side) — proves the proxy is not killing or
 *      buffering the idle stream
 *   4. Triggering a real status change delivers an "activity" event over the
 *      already-open stream within a few seconds
 *
 * The trigger step makes a status edit and immediately reverts it (it flips
 * the "owner" field on one rostering row and flips it back). Two entries
 * appear in the rostering activity feed as a result. To run the read-only
 * portion (steps 1–3) without writing anything, set SSE_TRIGGER=0.
 *
 * Usage (against the published app):
 *   PROD_APP_URL=https://<app>.replit.app \
 *   SMOKE_EMAIL=<admin email> SMOKE_PASSWORD=<password> \
 *   pnpm --filter @workspace/scripts run sse-stream-check
 *
 *   or: pnpm --filter @workspace/scripts run sse-stream-check -- https://<app>.replit.app
 *
 * Credentials fall back to ADMIN_EMAIL / ADMIN_PASSWORD if SMOKE_* are unset.
 * The trigger step requires an admin account.
 *
 * If this check fails at the heartbeat or activity step in production, the
 * badge is NOT broken — the client falls back to refreshing the unseen count
 * every 60 seconds (and on window focus). The stream only makes it instant.
 */

export {};

const urlArg = process.argv.slice(2).find((a) => a !== "--");
const rawUrl = urlArg ?? process.env.PROD_APP_URL;

if (!rawUrl) {
  console.error(
    "SSE STREAM CHECK ERRORED: no base URL provided.\n" +
      "Set PROD_APP_URL or pass the URL as an argument, e.g.\n" +
      "  pnpm --filter @workspace/scripts run sse-stream-check -- https://<app>.replit.app",
  );
  process.exit(1);
}

const base = `${rawUrl.replace(/\/+$/, "")}/api`;

const EMAIL = process.env.SMOKE_EMAIL ?? process.env.ADMIN_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD ?? process.env.ADMIN_PASSWORD;
const runTrigger = process.env.SSE_TRIGGER !== "0";

if (!EMAIL || !PASSWORD) {
  console.error(
    "SSE STREAM CHECK ERRORED: no credentials provided.\n" +
      "Set SMOKE_EMAIL and SMOKE_PASSWORD (or ADMIN_EMAIL and ADMIN_PASSWORD) " +
      "to the credentials of an admin account on the target app.",
  );
  process.exit(1);
}

const email: string = EMAIL;
const password: string = PASSWORD;

// Heartbeats are sent every 25s server-side; allow one missed interval plus
// generous network slack before declaring the stream dead.
const HEARTBEAT_TIMEOUT_MS = 65_000;
const ACTIVITY_TIMEOUT_MS = 10_000;

type StepName = "login" | "stream open" | "heartbeat" | "activity event" | "cleanup";

function stepFail(step: StepName, detail: string): never {
  console.error(`\nFAIL at step "${step}": ${detail}`);
  console.error("SSE STREAM CHECK FAILED");
  process.exit(1);
}

function stepPass(step: StepName, detail: string) {
  console.log(`  ok [${step}]: ${detail}`);
}

async function tryFetch(step: StepName, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "manual" });
  } catch (err) {
    stepFail(step, `network error reaching ${url}: ${(err as Error).message}`);
  }
}

/** Reads the SSE byte stream and resolves waiters when matching lines arrive. */
class SseWatcher {
  private buffer = "";
  private waiters: { match: (line: string) => boolean; resolve: (line: string) => void }[] = [];
  closed = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    void this.consume(stream);
  }

  private async consume(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, idx).trimEnd();
          this.buffer = this.buffer.slice(idx + 1);
          if (line.length === 0) continue;
          for (let i = this.waiters.length - 1; i >= 0; i--) {
            const waiter = this.waiters[i]!;
            if (waiter.match(line)) {
              this.waiters.splice(i, 1);
              waiter.resolve(line);
            }
          }
        }
      }
    } catch {
      // Stream aborted or reset; waiters will time out with a clear message.
    }
    this.closed = true;
  }

  waitFor(match: (line: string) => boolean, timeoutMs: number, what: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            this.closed
              ? `stream closed before ${what} arrived (proxy or server dropped the connection)`
              : `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        match,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  }
}

async function main() {
  console.log(`Live-badge stream check against ${base}`);
  console.log(`Account: ${email}\n`);

  // Step 1: login
  const loginRes = await tryFetch("login", `${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    stepFail("login", `POST /auth/login -> HTTP ${loginRes.status}. Check SMOKE_EMAIL/SMOKE_PASSWORD.`);
  }
  const setCookie = loginRes.headers.get("set-cookie");
  if (!setCookie) stepFail("login", "login succeeded but no session cookie was returned.");
  const cookie = setCookie.split(";")[0]!;
  stepPass("login", `POST /auth/login -> ${loginRes.status}`);

  // Step 2: open the stream
  const streamController = new AbortController();
  const openedAt = Date.now();
  const streamRes = await tryFetch("stream open", `${base}/rostering/events`, {
    headers: { Cookie: cookie, Accept: "text/event-stream" },
    signal: streamController.signal,
  });
  if (!streamRes.ok) {
    stepFail("stream open", `GET /rostering/events -> HTTP ${streamRes.status}`);
  }
  const contentType = streamRes.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    stepFail(
      "stream open",
      `expected Content-Type text/event-stream, got "${contentType}". A proxy or middleware is rewriting the response.`,
    );
  }
  if (!streamRes.body) stepFail("stream open", "response had no body stream.");
  const watcher = new SseWatcher(streamRes.body);

  try {
    await watcher.waitFor((l) => l.startsWith("retry:"), 10_000, 'the initial "retry:" line');
  } catch (err) {
    stepFail(
      "stream open",
      `${(err as Error).message}. The proxy is likely buffering the response instead of streaming it.`,
    );
  }
  stepPass(
    "stream open",
    `stream opened with text/event-stream and the initial retry hint arrived after ${Date.now() - openedAt}ms (not buffered)`,
  );

  // Step 3: heartbeat — proves the proxy keeps the idle connection alive.
  console.log("  ... waiting up to 65s for a heartbeat ping (sent every 25s) ...");
  try {
    await watcher.waitFor((l) => l.startsWith(":"), HEARTBEAT_TIMEOUT_MS, "a heartbeat ping");
  } catch (err) {
    stepFail(
      "heartbeat",
      `${(err as Error).message}. The proxy is buffering or terminating the idle stream; the badge will rely on 60s polling instead.`,
    );
  }
  stepPass("heartbeat", `heartbeat received ${Math.round((Date.now() - openedAt) / 1000)}s after opening — connection stays alive through the proxy`);

  // Step 4: trigger a status change and expect an "activity" event.
  if (!runTrigger) {
    console.log("  -- [activity event]: skipped (SSE_TRIGGER=0); read-only run.");
  } else {
    const terms = (await (await tryFetch("activity event", `${base}/terms`, { headers: { Cookie: cookie } })).json()) as {
      id: number;
    }[];
    if (!Array.isArray(terms) || terms.length === 0) {
      stepFail("activity event", "no terms exist on the target app; cannot trigger a status change.");
    }
    let statusRow: { statusId: number; owner: string | null } | undefined;
    for (const term of terms) {
      const board = (await (
        await tryFetch("activity event", `${base}/rostering/board?termId=${term.id}`, {
          headers: { Cookie: cookie },
        })
      ).json()) as { statusId: number; owner: string | null }[];
      if (Array.isArray(board) && board.length > 0) {
        statusRow = board[0];
        break;
      }
    }
    if (!statusRow) {
      stepFail("activity event", "no rostering status rows exist on the target app; cannot trigger a status change.");
    }
    const originalOwner = statusRow.owner ?? null;
    const tempOwner = "SSE check (temporary)";
    const patch = async (owner: string | null) => {
      const res = await tryFetch("activity event", `${base}/rostering/status/${statusRow.statusId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ owner }),
      });
      if (!res.ok) {
        stepFail(
          "activity event",
          `PATCH /rostering/status/${statusRow.statusId} -> HTTP ${res.status}. The account may not be an admin.`,
        );
      }
    };

    const activityPromise = watcher.waitFor(
      (l) => l.startsWith("event: activity"),
      ACTIVITY_TIMEOUT_MS,
      'an "activity" event',
    );
    const triggeredAt = Date.now();
    await patch(tempOwner);
    try {
      await activityPromise;
    } catch (err) {
      await patch(originalOwner).catch(() => undefined);
      stepFail(
        "activity event",
        `${(err as Error).message}. Note: on autoscale deployments with more than one instance, the change may land on a different instance than the stream — the 60s polling fallback covers that case.`,
      );
    }
    stepPass("activity event", `"activity" event arrived ${Date.now() - triggeredAt}ms after the status change`);
    // Revert the temporary edit.
    await patch(originalOwner);
    console.log(`  ok [cleanup]: reverted the temporary owner edit on status row ${statusRow.statusId}`);
  }

  streamController.abort();
  await tryFetch("cleanup", `${base}/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
  console.log("\nSSE STREAM CHECK PASSED: the live badge stream works through this proxy.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`SSE STREAM CHECK ERRORED: ${(err as Error).message}`);
  process.exit(1);
});
