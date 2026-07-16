/**
 * Snapshot-pinning tests for the archive dialog.
 *
 * The server returns an X-Archive-Snapshot header on the first page; the
 * client must echo it back as `archivedBefore` on page 2+ so offsets stay
 * stable while the retention job archives rows mid-export (no duplicates or
 * gaps).
 *
 * If the header is missing (a proxy stripped it, or an older server build is
 * deployed) the export must still run to completion — deliberately degraded
 * to unpinned offsets — and the user is warned via a toast.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ArchiveDialog } from "@/pages/Rostering";
import { Toaster } from "@/components/ui/toaster";

const SNAPSHOT = "2026-07-10T00:00:00.000Z";
const EXPORT_PAGE_SIZE = 1000;
const BROWSE_PAGE_SIZE = 500;

type RecordedCall = { params: Record<string, string> };
const calls: RecordedCall[] = [];

function makeRow(id: number, appName: string) {
  return {
    id,
    appName,
    detail: "archived event",
    createdAt: "2024-01-15T00:00:00.000Z",
    actorName: "Alice",
  };
}

function csvPage(offset: number, count: number) {
  const lines = ["id,app,detail,archived_at,actor"];
  for (let i = 0; i < count; i++) {
    lines.push(`${offset + i},App ${offset + i},archived event,2024-01-15,Alice`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Stubs fetch. Two full export pages then a short third page, so the export
 * makes 3 requests. Browsing pages: full first page, short second page.
 */
function installFetchMock({ withHeader }: { withHeader: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const params = Object.fromEntries(url.searchParams.entries());
      calls.push({ params });
      const offset = Number(params.offset ?? 0);
      const headers: Record<string, string> = {};
      if (withHeader) headers["X-Archive-Snapshot"] = SNAPSHOT;

      if (params.format === "csv") {
        const count = offset < EXPORT_PAGE_SIZE * 2 ? EXPORT_PAGE_SIZE : 7;
        headers["Content-Type"] = "text/csv";
        headers["X-Total-Count"] = String(EXPORT_PAGE_SIZE * 2 + 7);
        return new Response(csvPage(offset, count), { status: 200, headers });
      }

      const count = offset === 0 ? BROWSE_PAGE_SIZE : 3;
      const rows = Array.from({ length: count }, (_, i) =>
        makeRow(offset + i, `App ${offset + i}`),
      );
      headers["Content-Type"] = "application/json";
      return new Response(JSON.stringify(rows), { status: 200, headers });
    }),
  );
}

function exportCalls() {
  return calls.filter((c) => c.params.format === "csv");
}

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ArchiveDialog />
      <Toaster />
    </QueryClientProvider>,
  );
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /archived history/i }));
  await screen.findByText("Archived activity history");
}

let createObjectURLSpy: ReturnType<typeof vi.fn>;
let anchorClickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls.length = 0;
  createObjectURLSpy = vi.fn(() => "blob:mock");
  vi.stubGlobal("URL", Object.assign(URL, {}));
  URL.createObjectURL = createObjectURLSpy as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  // jsdom can't navigate to blob: URLs; the click is the "download happened" signal.
  anchorClickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  anchorClickSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("ArchiveDialog snapshot pinning", () => {
  it("pins CSV export pages 2+ to the first page's X-Archive-Snapshot", async () => {
    installFetchMock({ withHeader: true });
    renderDialog();
    await openDialog();
    await screen.findByText("App 0");

    fireEvent.click(screen.getByRole("button", { name: /download csv/i }));

    await waitFor(() => {
      expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    });

    const pages = exportCalls();
    expect(pages.length).toBe(3);
    // First page establishes the snapshot; it must not send archivedBefore.
    expect(pages[0].params.archivedBefore).toBeUndefined();
    // Every later page must be pinned to the snapshot the server returned.
    expect(pages[1].params.archivedBefore).toBe(SNAPSHOT);
    expect(pages[1].params.offset).toBe(String(EXPORT_PAGE_SIZE));
    expect(pages[2].params.archivedBefore).toBe(SNAPSHOT);
    expect(pages[2].params.offset).toBe(String(EXPORT_PAGE_SIZE * 2));

    // No degraded-mode warning when the header is present.
    expect(
      screen.queryByText(/without a consistency snapshot/i),
    ).not.toBeInTheDocument();
  });

  it("still completes the export and warns when the snapshot header is missing", async () => {
    installFetchMock({ withHeader: false });
    renderDialog();
    await openDialog();
    await screen.findByText("App 0");

    fireEvent.click(screen.getByRole("button", { name: /download csv/i }));

    // Degraded-mode warning surfaces to the user.
    await screen.findByText(/without a consistency snapshot/i);

    // The export still runs to completion and triggers the download.
    await waitFor(() => {
      expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    });

    const pages = exportCalls();
    expect(pages.length).toBe(3);
    // Unpinned fallback: no page ever sends archivedBefore.
    for (const page of pages) {
      expect(page.params.archivedBefore).toBeUndefined();
    }
  });

  it("pins the browsing infinite query's next page to the snapshot", async () => {
    installFetchMock({ withHeader: true });
    renderDialog();
    await openDialog();
    await screen.findByText("App 0");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText(`App ${BROWSE_PAGE_SIZE}`);

    expect(calls.length).toBe(2);
    expect(calls[0].params.archivedBefore).toBeUndefined();
    expect(calls[1].params.archivedBefore).toBe(SNAPSHOT);
    expect(calls[1].params.offset).toBe(String(BROWSE_PAGE_SIZE));
  });
});
