import * as am5 from "@amcharts/amcharts5";
import * as am5xy from "@amcharts/amcharts5/xy";
import type { AppUsageRow } from "@workspace/api-client-react";
import { useAmRoot, CHART_COLORS } from "./useAmRoot";

export function TopAppsChart({
  data,
  metric,
}: {
  data: AppUsageRow[];
  metric: "uniqueUsers" | "adoptionPct";
}) {
  const ref = useAmRoot(
    (root) => {
      const top = [...data]
        .sort((a, b) => b[metric] - a[metric])
        .slice(0, 15)
        .reverse();

      const chart = root.container.children.push(
        am5xy.XYChart.new(root, {
          panX: false,
          panY: false,
          wheelX: "none",
          wheelY: "none",
          paddingLeft: 0,
        }),
      );

      const yRenderer = am5xy.AxisRendererY.new(root, {
        minGridDistance: 10,
      });
      yRenderer.labels.template.setAll({ fontSize: 12, oversizedBehavior: "truncate", maxWidth: 160 });
      const yAxis = chart.yAxes.push(
        am5xy.CategoryAxis.new(root, {
          categoryField: "application",
          renderer: yRenderer,
        }),
      );
      const xAxis = chart.xAxes.push(
        am5xy.ValueAxis.new(root, {
          min: 0,
          renderer: am5xy.AxisRendererX.new(root, {}),
        }),
      );

      const series = chart.series.push(
        am5xy.ColumnSeries.new(root, {
          xAxis,
          yAxis,
          valueXField: metric,
          categoryYField: "application",
          tooltip: am5.Tooltip.new(root, {
            labelText:
              metric === "adoptionPct"
                ? "{categoryY}: {valueX}%"
                : "{categoryY}: {valueX}",
          }),
        }),
      );
      series.columns.template.setAll({
        cornerRadiusTR: 4,
        cornerRadiusBR: 4,
        height: am5.percent(70),
        fill: am5.color(CHART_COLORS[0]),
        stroke: am5.color(CHART_COLORS[0]),
      });

      yAxis.data.setAll(top);
      series.data.setAll(top);
      series.appear(600);
      chart.appear(600, 50);
    },
    [JSON.stringify(data), metric],
  );

  return <div ref={ref} className="w-full h-96" />;
}
