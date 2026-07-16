import * as am5 from "@amcharts/amcharts5";
import * as am5xy from "@amcharts/amcharts5/xy";
import { useAmRoot, CHART_COLORS } from "./useAmRoot";

type Point = { snapshotDate: string; uniqueUsers: number; totalAccesses: number };

export function ResourceHistoryChart({ points }: { points: Point[] }) {
  const ref = useAmRoot(
    (root) => {
      const chart = root.container.children.push(
        am5xy.XYChart.new(root, {
          panX: false,
          panY: false,
          wheelX: "none",
          wheelY: "none",
          layout: root.verticalLayout,
        }),
      );

      const xAxis = chart.xAxes.push(
        am5xy.DateAxis.new(root, {
          baseInterval: { timeUnit: "day", count: 1 },
          renderer: am5xy.AxisRendererX.new(root, { minGridDistance: 60 }),
        }),
      );
      const yAxis = chart.yAxes.push(
        am5xy.ValueAxis.new(root, {
          min: 0,
          renderer: am5xy.AxisRendererY.new(root, {}),
        }),
      );

      const rows = points.map((p) => ({
        date: new Date(p.snapshotDate + "T00:00:00").getTime(),
        uniqueUsers: p.uniqueUsers,
        totalAccesses: p.totalAccesses,
      }));

      const mk = (name: string, field: string, color: string) => {
        const series = chart.series.push(
          am5xy.LineSeries.new(root, {
            name,
            xAxis,
            yAxis,
            valueYField: field,
            valueXField: "date",
            stroke: am5.color(color),
            fill: am5.color(color),
            connect: false,
            tooltip: am5.Tooltip.new(root, {
              labelText: "{valueX.formatDate('yyyy-MM-dd')} · {name}: {valueY}",
            }),
          }),
        );
        series.strokes.template.setAll({ strokeWidth: 2.5 });
        series.fills.template.setAll({ fillOpacity: 0.08, visible: true });
        series.bullets.push(() =>
          am5.Bullet.new(root, {
            sprite: am5.Circle.new(root, {
              radius: 3.5,
              fill: am5.color(color),
            }),
          }),
        );
        series.data.setAll(rows);
        return series;
      };

      mk("Unique users", "uniqueUsers", CHART_COLORS[0]);
      mk("Total opens", "totalAccesses", CHART_COLORS[1]);

      chart.set("cursor", am5xy.XYCursor.new(root, { behavior: "none" }));

      const legend = chart.children.push(
        am5.Legend.new(root, { centerX: am5.p50, x: am5.p50 }),
      );
      legend.data.setAll(chart.series.values);
      chart.appear(600, 50);
    },
    [JSON.stringify(points)],
  );

  return <div ref={ref} className="w-full h-80" data-testid="resource-history-chart" />;
}
