/**
 * Regression tests: the Rostering board remembers the status filter, sort
 * key, and "open issues only" toggle in localStorage (keys
 * `sageoak-rostering-status`, `sageoak-rostering-sort`,
 * `sageoak-rostering-open-issues`). Stale/garbage stored values must fall
 * back to defaults without errors. Search text is intentionally ephemeral.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const terms = [
  {
    id: 11,
    label: "Spring 2026",
    schoolYear: "2025-26",
    startDate: "2026-01-05",
    endDate: "2026-06-05",
    isCurrent: true,
    sortOrder: 1,
  },
];

const board = [
  {
    applicationId: 1,
    appName: "Alpha App",
    category: "Math",
    owner: "Ann",
    studentSharingStatus: "complete",
    staffSharingStatus: "complete",
    openIssueCount: 0,
    upvoteCount: 1,
    raci: [],
    updatedAt: "2026-07-01T00:00:00Z",
  },
  {
    applicationId: 2,
    appName: "Beta App",
    category: "Reading",
    owner: "Bob",
    studentSharingStatus: "in_progress",
    staffSharingStatus: "not_started",
    openIssueCount: 2,
    upvoteCount: 5,
    raci: [],
    updatedAt: "2026-07-10T00:00:00Z",
  },
];

function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
}

vi.mock("@workspace/api-client-react", () => ({
  useListTerms: () => ({ data: terms }),
  useGetRosteringBoard: () => ({ data: board, isLoading: false }),
  useGetRosteringSummary: () => ({ data: undefined }),
  useToggleUpvote: mutation,
  useReportIssue: mutation,
  useUpdateAppTermStatus: mutation,
  useListUserOptions: () => ({ data: [] }),
  useCreateTerm: mutation,
  useUpdateTerm: mutation,
  useCopyTermStatuses: mutation,
  useGetRosteringActivity: () => ({ data: [] }),
  useMarkRosteringSeen: mutation,
  getGetRosteringUnseenCountQueryKey: () => ["rostering-unseen"],
  useGetPublicAppSettings: () => ({ data: undefined }),
}));

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({ isAdmin: false, user: { name: "Staff" } }),
}));

import Rostering from "@/pages/Rostering";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Rostering />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("Rostering stored board filters", () => {
  it("restores a valid stored status filter", () => {
    localStorage.setItem("sageoak-rostering-status", "complete");
    renderPage();
    expect(screen.getByText("Alpha App")).toBeTruthy();
    expect(screen.queryByText("Beta App")).toBeNull();
  });

  it("falls back to all statuses when the stored status no longer exists", () => {
    localStorage.setItem("sageoak-rostering-status", "deleted_status");
    renderPage();
    expect(screen.getByText("Alpha App")).toBeTruthy();
    expect(screen.getByText("Beta App")).toBeTruthy();
  });

  it("restores the stored sort key", () => {
    localStorage.setItem("sageoak-rostering-sort", "upvotes");
    renderPage();
    const rows = screen.getAllByRole("row").slice(1); // skip header
    expect(rows[0]!.textContent).toContain("Beta App");
    expect(rows[1]!.textContent).toContain("Alpha App");
  });

  it("falls back to the default sort for a garbage stored sort key", () => {
    localStorage.setItem("sageoak-rostering-sort", "garbage");
    renderPage();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]!.textContent).toContain("Alpha App");
  });

  it("restores the open-issues-only toggle", () => {
    localStorage.setItem("sageoak-rostering-open-issues", "true");
    renderPage();
    expect(screen.getByText("Beta App")).toBeTruthy();
    expect(screen.queryByText("Alpha App")).toBeNull();
  });

  it("ignores a garbage open-issues value", () => {
    localStorage.setItem("sageoak-rostering-open-issues", "banana");
    renderPage();
    expect(screen.getByText("Alpha App")).toBeTruthy();
    expect(screen.getByText("Beta App")).toBeTruthy();
  });

  it("stores the open-issues toggle when clicked", () => {
    renderPage();
    fireEvent.click(screen.getByText("Open issues only"));
    expect(localStorage.getItem("sageoak-rostering-open-issues")).toBe("true");
    expect(screen.queryByText("Alpha App")).toBeNull();
    fireEvent.click(screen.getByText("Open issues only"));
    expect(localStorage.getItem("sageoak-rostering-open-issues")).toBeNull();
    expect(screen.getByText("Alpha App")).toBeTruthy();
  });

  it("does not persist search text", () => {
    renderPage();
    fireEvent.change(
      screen.getByPlaceholderText("Search apps, category, owner..."),
      { target: { value: "alpha" } },
    );
    const stored = Object.keys(localStorage).filter((k) =>
      k.startsWith("sageoak-rostering"),
    );
    expect(stored).toEqual([]);
  });
});
