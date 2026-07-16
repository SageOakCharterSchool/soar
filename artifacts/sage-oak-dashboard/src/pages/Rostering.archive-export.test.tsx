/**
 * Regression tests: the archive dialog's CSV export stitches together
 * multiple paged CSV responses. The final file must contain exactly one
 * header row, every data row in order, and must not break quoted fields
 * (which can contain newlines).
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    getRosteringActivityArchive: vi.fn(async () => [
      {
        id: 1,
        appName: "App 1",
        detail: "archived event",
        createdAt: "2024-01-15T00:00:00.000Z",
        actorName: "Alice",
      },
    ]),
  };
});

import { ArchiveDialog, splitCsvRecords } from "@/pages/Rostering";

describe("splitCsvRecords", () => {
  it("splits simple newline-terminated records", () => {
    expect(splitCsvRecords("a,b\nc,d\ne,f\n")).toEqual(["a,b", "c,d", "e,f"]);
  });

  it("keeps newlines inside quoted fields within one record", () => {
    const text = 'id,detail\n1,"line one\nline two"\n2,plain\n';
    expect(splitCsvRecords(text)).toEqual([
      "id,detail",
      '1,"line one\nline two"',
      "2,plain",
    ]);
  });

  it("includes a trailing record without a final newline", () => {
    expect(splitCsvRecords("h1,h2\nlast,row")).toEqual(["h1,h2", "last,row"]);
  });

  it("handles escaped quotes inside quoted fields", () => {
    const text = 'id,detail\n1,"said ""hi""\nbye"\n';
    expect(splitCsvRecords(text)).toEqual(["id,detail", '1,"said ""hi""\nbye"']);
  });

  it("returns empty array for empty input", () => {
    expect(splitCsvRecords("")).toEqual([]);
  });
});

const PAGE_SIZE = 1000;
const HEADER = "id,appName,detail";

function makeCsvPage(offset: number, count: number): string {
  const rows = Array.from(
    { length: count },
    (_, i) => `${offset + i},"App ${offset + i}","detail\nwith newline ${offset + i}"`,
  );
  return [HEADER, ...rows].join("\n") + "\n";
}

describe("ArchiveDialog CSV export", () => {
  let capturedBlob: Blob | null = null;
  const fetchCalls: string[] = [];
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    capturedBlob = null;
    fetchCalls.length = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(String(url), "http://localhost");
        // Only the CSV export path uses raw fetch; the list view goes
        // through the mocked api client. Answer non-CSV requests with JSON
        // so an implementation change doesn't silently break this stub.
        if (parsed.searchParams.get("format") !== "csv") {
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => [
              {
                id: 1,
                appName: "App 1",
                detail: "archived event",
                createdAt: "2024-01-15T00:00:00.000Z",
                actorName: "Alice",
              },
            ],
            text: async () => "",
          } as unknown as Response;
        }
        fetchCalls.push(String(url));
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        // Page 1: full page (1000 rows) -> triggers a second fetch.
        // Page 2: partial page (5 rows) -> ends pagination.
        const count = offset === 0 ? PAGE_SIZE : 5;
        return {
          ok: true,
          headers: {
            get: (name: string) =>
              name === "X-Total-Count" ? String(PAGE_SIZE + 5) : null,
          },
          text: async () => makeCsvPage(offset, count),
        } as unknown as Response;
      }),
    );

    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return "blob:mock";
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
    vi.restoreAllMocks();
  });

  it("exports one header row and all data rows in order across pages", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ArchiveDialog />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /archived history/i }));
    await screen.findByText("Archived activity history");
    // The footer (with the download button) only renders once rows load.
    await screen.findByText("App 1");

    fireEvent.click(screen.getByRole("button", { name: /download csv/i }));

    await waitFor(() => {
      expect(capturedBlob).not.toBeNull();
    });

    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[0]).toContain("offset=0");
    expect(fetchCalls[1]).toContain(`offset=${PAGE_SIZE}`);

    const text = await capturedBlob!.text();
    const records = splitCsvRecords(text);

    // Exactly one header row, at the top.
    expect(records[0]).toBe(HEADER);
    expect(records.filter((r) => r === HEADER)).toHaveLength(1);

    // All 1005 data rows present, in order, with quoting intact.
    const dataRecords = records.slice(1);
    expect(dataRecords).toHaveLength(PAGE_SIZE + 5);
    dataRecords.forEach((record, i) => {
      expect(record).toBe(
        `${i},"App ${i}","detail\nwith newline ${i}"`,
      );
    });

    // File ends with a trailing newline.
    expect(text.endsWith("\n")).toBe(true);
  });
});
