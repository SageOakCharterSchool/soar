import { useEffect, useState } from "react";

export function getStoredId(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function useStoredId(key: string): [number | null, (id: number | null) => void] {
  const [id, setId] = useState<number | null>(() => getStoredId(key));

  useEffect(() => {
    try {
      if (id == null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, String(id));
      }
    } catch {
      // localStorage unavailable; selection just won't persist
    }
  }, [key, id]);

  return [id, setId];
}
