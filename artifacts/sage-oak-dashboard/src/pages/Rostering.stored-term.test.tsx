/**
 * Regression tests: the Rostering page remembers the selected term in
 * localStorage (key `sageoak-rostering-term`). A stale stored id (term
 * deleted since) must fall back to the current term without errors, and a
 * valid stored id must restore that term's selection.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const terms = [
  {
    id: 10,
    label: "Fall 2025",
    schoolYear: "2025-26",
    startDate: "2025-08-01",
    endDate: "2025-12-20",
    isCurrent: false,
    sortOrder: 1,
  },
  {
    id: 11,
    label: "Spring 2026",
    schoolYear: "2025-26",
    startDate: "2026-01-05",
    endDate: "2026-06-05",
    isCurrent: true,
    sortOrder: 2,
  },
];

const boardCalls: number[] = [];

function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
}

vi.mock("@workspace/api-client-react", () => ({
  useListTerms: () => ({ data: terms }),
  useGetRosteringBoard: (params: { termId: number }) => {
    if (params?.termId != null) boardCalls.push(params.termId);
    return { data: [], isLoading: false };
  },
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

function termButton(label: string) {
  return screen.getByRole("button", { name: new RegExp(label) });
}

beforeEach(() => {
  localStorage.clear();
  boardCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("Rostering stored term selection", () => {
  it("restores a valid stored term id", () => {
    localStorage.setItem("sageoak-rostering-term", "10");
    renderPage();
    expect(boardCalls[0]).toBe(10);
    expect(termButton("Fall 2025").className).toContain("bg-primary");
    expect(termButton("Spring 2026").className).not.toContain("bg-primary");
  });

  it("falls back to the current term when the stored id no longer exists", () => {
    localStorage.setItem("sageoak-rostering-term", "999");
    renderPage();
    expect(boardCalls[0]).toBe(11);
    expect(termButton("Spring 2026").className).toContain("bg-primary");
    expect(termButton("Fall 2025").className).not.toContain("bg-primary");
  });

  it("falls back to the current term for a garbage stored value", () => {
    localStorage.setItem("sageoak-rostering-term", "garbage");
    renderPage();
    expect(boardCalls[0]).toBe(11);
    expect(termButton("Spring 2026").className).toContain("bg-primary");
  });

  it("stores the term id when a term is clicked", () => {
    renderPage();
    fireEvent.click(termButton("Fall 2025"));
    expect(localStorage.getItem("sageoak-rostering-term")).toBe("10");
    expect(termButton("Fall 2025").className).toContain("bg-primary");
  });
});
