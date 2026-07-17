import { useEffect, useState } from "react";

/**
 * Persist a small piece of UI state in localStorage. `parse` validates the
 * raw stored string and returns null for stale/garbage values, in which case
 * the default is used. Storing the default removes the key.
 */
export function getStoredValue<T>(
  key: string,
  parse: (raw: string) => T | null,
): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return parse(raw);
  } catch {
    return null;
  }
}

export function useStoredValue<T>(
  key: string,
  defaultValue: T,
  parse: (raw: string) => T | null,
  serialize: (value: T) => string = String,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(
    () => getStoredValue(key, parse) ?? defaultValue,
  );

  useEffect(() => {
    try {
      if (value === defaultValue) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, serialize(value));
      }
    } catch {
      // localStorage unavailable; the value just won't persist
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value]);

  return [value, setValue];
}

/** Parser for a fixed set of allowed string values (e.g. sort keys). */
export function oneOf<T extends string>(allowed: readonly T[]) {
  return (raw: string): T | null =>
    (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** Parser for booleans stored as "true"/"false". */
export function parseBool(raw: string): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}
