import * as am5 from "@amcharts/amcharts5";
import * as am5xy from "@amcharts/amcharts5/xy";
import type { DailyUsageRow } from "@workspace/api-client-react";
import { useAmRoot, CHART_COLORS } from "./useAmRoot";

export function DailyUsageChart({ data }: { data: DailyUsageRow[] }) {
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

      const rows = data.map((d) => ({
        date: new Date(d.date + "T00:00:00").getTime(),
        studentUsers: d.studentUsers,
        teacherUsers: d.teacherUsers,
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
              labelText: "{name}: {valueY}",
            }),
          }),
        );
        series.strokes.template.setAll({ strokeWidth: 2.5 });
        series.fills.template.setAll({ fillOpacity: 0.08, visible: true });
        series.data.setAll(rows);
        return series;
      };

      mk("Students", "studentUsers", CHART_COLORS[0]);
      mk("Teachers", "teacherUsers", CHART_COLORS[1]);

      chart.set(
        "cursor",
        am5xy.XYCursor.new(root, { behavior: "none" }),
      );

      const legend = chart.children.push(
        am5.Legend.new(root, { centerX: am5.p50, x: am5.p50 }),
      );
      legend.data.setAll(chart.series.values);
      chart.appear(600, 50);
    },
    [JSON.stringify(data)],
  );

  return <div ref={ref} className="w-full h-72" />;
}
