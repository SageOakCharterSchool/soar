/**
 * Regression tests: the RACI page remembers its task search filter in
 * localStorage (key `sageoak-raci-search`) alongside the already-persisted
 * team selection (`sageoak-raci-team`). Stale/garbage stored values must
 * fall back to defaults without errors.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const matrix = {
  teams: [
    {
      id: 1,
      name: "Infrastructure",
      members: [{ id: 10, name: "Ann" }],
      rows: [
        {
          id: 100,
          name: "Patch servers",
          category: "Operations",
          applicationId: null,
          appName: null,
          assignments: [{ memberId: 10, value: "A" }],
        },
        {
          id: 101,
          name: "Renew licenses",
          category: "Operations",
          applicationId: null,
          appName: null,
          assignments: [{ memberId: 10, value: "A" }],
        },
      ],
    },
    {
      id: 2,
      name: "Applications",
      members: [{ id: 20, name: "Bob" }],
      rows: [
        {
          id: 200,
          name: "Review app requests",
          category: null,
          applicationId: null,
          appName: null,
          assignments: [{ memberId: 20, value: "A" }],
        },
      ],
    },
  ],
};

function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
}

vi.mock("@workspace/api-client-react", () => ({
  useGetRaciMatrix: () => ({ data: matrix, isLoading: false }),
  getGetRaciMatrixQueryKey: () => ["raci-matrix"],
  useCreateRaciRow: mutation,
  useUpdateRaciRow: mutation,
  useDeleteRaciRow: mutation,
  useCreateRaciMember: mutation,
  useUpdateRaciMember: mutation,
  useDeleteRaciMember: mutation,
  useSetRaciCell: mutation,
  useRenameRaciCategory: mutation,
  useListUserOptions: () => ({ data: [], isLoading: false }),
  useGetPublicAppSettings: () => ({ data: undefined }),
}));

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({ isAdmin: false, user: { name: "Staff" } }),
}));

vi.mock("@/hooks/useActivityEventRefresh", () => ({
  useActivityEventRefresh: () => {},
}));

import Raci from "@/pages/Raci";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Raci />
    </QueryClientProvider>,
  );
}

const SEARCH_PLACEHOLDER = "Search tasks, categories, or people...";

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
});

describe("RACI stored filters", () => {
  it("restores a stored search filter", () => {
    localStorage.setItem("sageoak-raci-search", "patch");
    renderPage();
    expect(
      (screen.getByPlaceholderText(SEARCH_PLACEHOLDER) as HTMLInputElement)
        .value,
    ).toBe("patch");
    expect(screen.getByText("Patch servers")).toBeTruthy();
    expect(screen.queryByText("Renew licenses")).toBeNull();
  });

  it("renders the empty state, not an error, for a stale stored search", () => {
    localStorage.setItem("sageoak-raci-search", "task deleted long ago");
    renderPage();
    expect(screen.getByText("No tasks match your search.")).toBeTruthy();
  });

  it("stores the search when typed and clears the key when emptied", () => {
    renderPage();
    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.change(input, { target: { value: "renew" } });
    expect(localStorage.getItem("sageoak-raci-search")).toBe("renew");
    expect(screen.queryByText("Patch servers")).toBeNull();
    expect(screen.getByText("Renew licenses")).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect(localStorage.getItem("sageoak-raci-search")).toBeNull();
    expect(screen.getByText("Patch servers")).toBeTruthy();
  });

  it("keeps the stored search when switching teams", () => {
    localStorage.setItem("sageoak-raci-search", "patch");
    renderPage();
    fireEvent.click(screen.getByText("Applications"));
    expect(
      (screen.getByPlaceholderText(SEARCH_PLACEHOLDER) as HTMLInputElement)
        .value,
    ).toBe("patch");
    expect(localStorage.getItem("sageoak-raci-search")).toBe("patch");
  });

  it("still restores the stored team selection", () => {
    localStorage.setItem("sageoak-raci-team", "2");
    renderPage();
    expect(screen.getByText("Review app requests")).toBeTruthy();
    expect(screen.queryByText("Patch servers")).toBeNull();
  });

  it("falls back to the first team for a stale stored team id", () => {
    localStorage.setItem("sageoak-raci-team", "999");
    renderPage();
    expect(screen.getByText("Patch servers")).toBeTruthy();
  });
});
