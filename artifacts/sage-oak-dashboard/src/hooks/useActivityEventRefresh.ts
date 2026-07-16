import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

// Any rostering activity event (including issue reports and RACI changes) is
// pushed on this single SSE stream; callers pass the query key to refetch.
export function useActivityEventRefresh(queryKey: readonly unknown[]) {
  const qc = useQueryClient();
  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    const source = new EventSource(`${base}api/rostering/events`, {
      withCredentials: true,
    });
    const refresh = () => {
      qc.invalidateQueries({ queryKey });
    };
    source.addEventListener("activity", refresh);
    return () => {
      source.removeEventListener("activity", refresh);
      source.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);
}
