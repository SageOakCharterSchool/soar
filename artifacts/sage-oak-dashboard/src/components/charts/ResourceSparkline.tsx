import { LineChart, Line, Tooltip, ResponsiveContainer, YAxis } from "recharts";

type Point = { snapshotDate: string; uniqueUsers: number; totalAccesses: number };

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
