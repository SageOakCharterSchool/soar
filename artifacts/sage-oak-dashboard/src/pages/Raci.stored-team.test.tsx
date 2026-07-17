/**
 * Regression tests: the RACI page remembers the selected team in localStorage
 * (key `sageoak-raci-team`). A stale stored id (team deleted since) must fall
 * back to the first team without errors, and a valid stored id must restore
 * that team's selection.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const teams = [
  {
    id: 1,
    name: "Infrastructure",
    rows: [] as unknown[],
    members: [] as unknown[],
  },
  {
    id: 2,
    name: "Curriculum",
    rows: [] as unknown[],
    members: [] as unknown[],
  },
];

function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
}

vi.mock("@workspace/api-client-react", () => ({
  useGetRaciMatrix: () => ({ data: { teams }, isLoading: false }),
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

vi.mock("wouter", () => ({
  useSearch: () => "",
  useLocation: () => ["/raci", vi.fn()],
}));

vi.mock("@/hooks/useActivityEventRefresh", () => ({
  useActivityEventRefresh: () => {},
}));

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({ isAdmin: false, user: { name: "Staff" } }),
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

function teamButton(name: string) {
  return screen.getByRole("button", { name });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("RACI stored team selection", () => {
  it("restores a valid stored team id", () => {
    localStorage.setItem("sageoak-raci-team", "2");
    renderPage();
    // The selected team button uses the default (filled) variant; others are outlined.
    expect(teamButton("Curriculum").className).toContain("bg-primary");
    expect(teamButton("Infrastructure").className).not.toContain("bg-primary");
  });

  it("falls back to the first team when the stored id no longer exists", () => {
    localStorage.setItem("sageoak-raci-team", "999");
    renderPage();
    expect(teamButton("Infrastructure").className).toContain("bg-primary");
    expect(teamButton("Curriculum").className).not.toContain("bg-primary");
  });

  it("falls back to the first team for a garbage stored value", () => {
    localStorage.setItem("sageoak-raci-team", "garbage");
    renderPage();
    expect(teamButton("Infrastructure").className).toContain("bg-primary");
  });

  it("stores the team id when a team is clicked", () => {
    renderPage();
    fireEvent.click(teamButton("Curriculum"));
    expect(localStorage.getItem("sageoak-raci-team")).toBe("2");
    expect(teamButton("Curriculum").className).toContain("bg-primary");
  });
});
