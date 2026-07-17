import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "sageoak-theme";

function getStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // localStorage unavailable; fall through
  }
  return null;
}

function getSystemTheme(): Theme {
  try {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
  } catch {
    // matchMedia unavailable; fall through to light
  }
  return "light";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(
    () => getStoredTheme() ?? getSystemTheme(),
  );

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    if (getStoredTheme() !== null) return;
    let media: MediaQueryList;
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent) => {
      if (getStoredTheme() === null) {
        setTheme(e.matches ? "dark" : "light");
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // localStorage unavailable; theme just won't persist
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
