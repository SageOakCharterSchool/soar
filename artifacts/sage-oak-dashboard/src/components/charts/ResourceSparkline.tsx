import { LineChart, Line, Tooltip, ResponsiveContainer, YAxis } from "recharts";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

type Point = { snapshotDate: string; uniqueUsers: number; totalAccesses: number };

const FLAT_THRESHOLD_PCT = 2;

function baselineIndex(points: Point[]): number {
  const latest = new Date(points[points.length - 1].snapshotDate).getTime();
  const weekAgo = latest - 7 * 24 * 60 * 60 * 1000;
  for (let i = points.length - 2; i >= 0; i--) {
    if (new Date(points[i].snapshotDate).getTime() <= weekAgo) return i;
  }
  return 0;
}

export function ResourceTrendBadge({ points }: { points: Point[] }) {
  if (points.length < 2) return null;

  const latest = points[points.length - 1];
  const baseline = points[baselineIndex(points)];

  let state: "up" | "down" | "flat";
  let label: string;
  if (baseline.uniqueUsers === 0) {
    if (latest.uniqueUsers === 0) {
      state = "flat";
      label = "0%";
    } else {
      state = "up";
      label = "new";
    }
  } else {
    const pctChange = ((latest.uniqueUsers - baseline.uniqueUsers) / baseline.uniqueUsers) * 100;
    state = Math.abs(pctChange) < FLAT_THRESHOLD_PCT ? "flat" : pctChange > 0 ? "up" : "down";
    label =
      state === "flat"
        ? "flat"
        : `${pctChange > 0 ? "+" : ""}${Math.abs(pctChange) >= 10 ? Math.round(pctChange) : pctChange.toFixed(1)}%`;
  }

  const styles =
    state === "up"
      ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
      : state === "down"
        ? "text-red-700 dark:text-red-400 bg-red-500/10"
        : "text-muted-foreground bg-muted";
  const Icon = state === "up" ? ArrowUpRight : state === "down" ? ArrowDownRight : Minus;

  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium tabular-nums whitespace-nowrap ${styles}`}
      title={`Unique users: ${latest.uniqueUsers.toLocaleString()} on ${latest.snapshotDate} vs ${baseline.uniqueUsers.toLocaleString()} on ${baseline.snapshotDate}`}
      data-testid="resource-trend-badge"
      data-trend={state}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

export function ResourceSparkline({ points }: { points: Point[] }) {
  if (points.length < 2) {
    return (
      <span className="text-xs text-muted-foreground italic">not enough history</span>
    );
  }
  return (
    <div className="h-8 w-28" data-testid="resource-sparkline">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as Point;
              return (
                <div className="rounded-md border bg-popover px-2 py-1 text-xs shadow-md">
                  <div className="font-medium">{p.snapshotDate}</div>
                  <div className="tabular-nums">
                    {p.uniqueUsers.toLocaleString()} users · {p.totalAccesses.toLocaleString()} opens
                  </div>
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="uniqueUsers"
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
