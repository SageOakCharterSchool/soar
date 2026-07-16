/**
 * Regression tests: the archive dialog uses useInfiniteQuery so previously
 * loaded pages stay cached. Re-applying the same filters must reuse cached
 * data instead of refetching, and loaded pages must survive filter toggles.
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

const archiveCalls: Array<Record<string, unknown>> = [];

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    getRosteringActivityArchive: vi.fn(
      async (params: { search?: string; offset?: number; limit?: number }) => {
        archiveCalls.push({ ...params });
        const offset = Number(params.offset ?? 0);
        const limit = Number(params.limit ?? 500);
        if (params.search) {
          return [
            makeRow(9000, `Filtered ${params.search}`),
          ];
        }
        // Full first page so "Load more" appears; short second page ends it.
        const count = offset === 0 ? limit : 3;
        return Array.from({ length: count }, (_, i) =>
          makeRow(offset + i, `App ${offset + i}`),
        );
      },
    ),
  };
});

function makeRow(id: number, appName: string) {
  return {
    id,
    appName,
    detail: "archived event",
    createdAt: "2024-01-15T00:00:00.000Z",
    actorName: "Alice",
  };
}

import { ArchiveDialog } from "@/pages/Rostering";

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ArchiveDialog />
    </QueryClientProvider>,
  );
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /archived history/i }));
  await screen.findByText("Archived activity history");
}

function searchInput() {
  return screen.getByPlaceholderText("Search by app, actor, or detail…");
}

beforeEach(() => {
  archiveCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("ArchiveDialog caching", () => {
  it("serves cached results without a new request when a filter is cleared", async () => {
    renderDialog();
    await openDialog();

    await screen.findByText("App 0");
    expect(archiveCalls.length).toBe(1);

    // Apply a search filter (debounced 300ms) and wait for filtered results.
    fireEvent.change(searchInput(), { target: { value: "zeta" } });
    await screen.findByText(
      "Filtered zeta",
      undefined,
      { timeout: 3000 },
    );
    expect(archiveCalls.length).toBe(2);

    // Clear the filter: cached unfiltered results must appear instantly.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => {
      expect(screen.getByText("App 0")).toBeInTheDocument();
    });

    // Wait past the debounce window to be sure no refetch fires.
    await new Promise((r) => setTimeout(r, 500));
    expect(archiveCalls.length).toBe(2);
  });

  it("keeps both loaded pages after toggling a filter and back", async () => {
    renderDialog();
    await openDialog();

    await screen.findByText("App 0");
    expect(archiveCalls.length).toBe(1);

    // Load the second page.
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("App 500");
    expect(archiveCalls.length).toBe(2);
    expect(archiveCalls[1].offset).toBe(500);

    // Toggle a filter on…
    fireEvent.change(searchInput(), { target: { value: "zeta" } });
    await screen.findByText(
      "Filtered zeta",
      undefined,
      { timeout: 3000 },
    );
    expect(archiveCalls.length).toBe(3);

    // …and back off. Both cached pages must reappear without refetching.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => {
      expect(screen.getByText("App 0")).toBeInTheDocument();
      expect(screen.getByText("App 500")).toBeInTheDocument();
    });

    await new Promise((r) => setTimeout(r, 500));
    expect(archiveCalls.length).toBe(3);
  });
});
