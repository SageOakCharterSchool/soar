/**
 * Unit tests for the localStorage-backed selection hook that remembers the
 * RACI team and Rostering term across refreshes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

import { useStoredId, getStoredId } from "@/hooks/useStoredId";

const KEY = "test-stored-id";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("getStoredId", () => {
  it("returns null when nothing is stored", () => {
    expect(getStoredId(KEY)).toBeNull();
  });

  it("returns the stored integer", () => {
    localStorage.setItem(KEY, "42");
    expect(getStoredId(KEY)).toBe(42);
  });

  it("returns null for non-numeric stored values", () => {
    localStorage.setItem(KEY, "not-a-number");
    expect(getStoredId(KEY)).toBeNull();
  });

  it("returns null for non-integer stored values", () => {
    localStorage.setItem(KEY, "3.14");
    expect(getStoredId(KEY)).toBeNull();
  });

  it("returns null when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });
    expect(getStoredId(KEY)).toBeNull();
  });
});

describe("useStoredId", () => {
  it("initializes from a valid stored value", () => {
    localStorage.setItem(KEY, "7");
    const { result } = renderHook(() => useStoredId(KEY));
    expect(result.current[0]).toBe(7);
  });

  it("initializes to null for an invalid stored value", () => {
    localStorage.setItem(KEY, "garbage");
    const { result } = renderHook(() => useStoredId(KEY));
    expect(result.current[0]).toBeNull();
  });

  it("persists a new id to localStorage", () => {
    const { result } = renderHook(() => useStoredId(KEY));
    act(() => result.current[1](12));
    expect(result.current[0]).toBe(12);
    expect(localStorage.getItem(KEY)).toBe("12");
  });

  it("removes the stored value when set to null", () => {
    localStorage.setItem(KEY, "5");
    const { result } = renderHook(() => useStoredId(KEY));
    expect(result.current[0]).toBe(5);
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("still works in-memory when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });
    const { result } = renderHook(() => useStoredId(KEY));
    expect(result.current[0]).toBeNull();
    act(() => result.current[1](3));
    expect(result.current[0]).toBe(3);
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
  });
});
