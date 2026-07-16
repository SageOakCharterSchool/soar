import { useLocation } from "wouter";
import type { RaciBoardPerson } from "@workspace/api-client-react";

export const RACI_CHIP_CLASSES: Record<string, string> = {
  R: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
  A: "bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200",
  C: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  I: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
};

export const RACI_CHIP_LABELS: Record<string, string> = {
  R: "Responsible",
  A: "Accountable",
  C: "Consulted",
  I: "Informed",
};

export function RaciChips({
  people,
  applicationId,
}: {
  people: RaciBoardPerson[];
  applicationId?: number;
}) {
  const [, setLocation] = useLocation();
  if (people.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1">
      {people.map((p) => {
        const className = `inline-flex items-center rounded px-1 py-px text-[10px] font-medium ${RACI_CHIP_CLASSES[p.value] ?? "bg-muted text-muted-foreground"}`;
        const label = `${p.name}: ${RACI_CHIP_LABELS[p.value] ?? p.value} (from the RACI matrix)`;
        if (applicationId == null) {
          return (
            <span key={`${p.name}-${p.value}`} className={className} title={label}>
              {p.value} · {p.name}
            </span>
          );
        }
        return (
          <button
            key={`${p.name}-${p.value}`}
            type="button"
            className={`${className} cursor-pointer hover:ring-1 hover:ring-current`}
            title={`${label} — click to see this row in the RACI matrix`}
            onClick={() => setLocation(`/raci?app=${applicationId}`)}
          >
            {p.value} · {p.name}
          </button>
        );
      })}
    </div>
  );
}
