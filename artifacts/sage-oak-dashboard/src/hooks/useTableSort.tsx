import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";

export type SortDir = "asc" | "desc";
export type SortValue = string | number | boolean | null | undefined;
export type SortState<K extends string = string> = { key: K; dir: SortDir } | null;

/**
 * Client-side column sorting for tables. `accessors` must be a stable
 * reference (module-level constant or useMemo) to avoid re-sorting on
 * every render.
 */
export function useTableSort<T, K extends string>(
  rows: T[] | undefined,
  accessors: Record<K, (row: T) => SortValue>,
  defaultSort: SortState<K> = null,
) {
  const [sort, setSort] = useState<SortState<K>>(defaultSort);

  const toggle = (key: K, firstDir: SortDir = "asc") =>
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: firstDir },
    );

  const sorted = useMemo(() => {
    const list = [...(rows ?? [])];
    if (!sort) return list;
    const acc = accessors[sort.key];
    const mul = sort.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const va = acc(a);
      const vb = acc(b);
      const aEmpty = va == null || va === "";
      const bEmpty = vb == null || vb === "";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1; // empty values always last
      if (bEmpty) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
      if (typeof va === "boolean" && typeof vb === "boolean")
        return ((va ? 1 : 0) - (vb ? 1 : 0)) * mul;
      return (
        String(va).localeCompare(String(vb), undefined, {
          sensitivity: "base",
          numeric: true,
        }) * mul
      );
    });
    return list;
  }, [rows, sort, accessors]);

  return { sorted, sort, toggle };
}

export function SortableHead({
  label,
  sortKey,
  sort,
  onToggle,
  firstDir = "asc",
  align = "left",
  className,
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onToggle: (key: never, firstDir?: SortDir) => void;
  firstDir?: SortDir;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort?.key === sortKey;
  const Icon = active ? (sort!.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead
      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`${align === "right" ? "text-right " : ""}${className ?? ""}`}
    >
      <button
        type="button"
        onClick={() => (onToggle as (k: string, d?: SortDir) => void)(sortKey, firstDir)}
        className={`inline-flex items-center gap-1 select-none cursor-pointer hover:text-foreground ${
          align === "right" ? "justify-end" : ""
        } ${active ? "text-foreground font-semibold" : ""}`}
        title={`Sort by ${label}`}
        data-testid={`sort-${sortKey}`}
      >
        {label}
        <Icon className={`h-3 w-3 shrink-0 ${active ? "" : "opacity-50"}`} />
      </button>
    </TableHead>
  );
}
