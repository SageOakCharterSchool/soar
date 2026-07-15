import * as am5 from "@amcharts/amcharts5";
import * as am5percent from "@amcharts/amcharts5/percent";
import type { MixSlice } from "@workspace/api-client-react";
import { useAmRoot, CHART_COLORS } from "./useAmRoot";

export function MixDonut({ data }: { data: MixSlice[] }) {
  const ref = useAmRoot(
    (root) => {
      const chart = root.container.children.push(
        am5percent.PieChart.new(root, {
          innerRadius: am5.percent(55),
          layout: root.verticalLayout,
        }),
      );

      const series = chart.series.push(
        am5percent.PieSeries.new(root, {
          valueField: "uniqueUsers",
          categoryField: "label",
        }),
      );
      series
        .get("colors")
        ?.set("colors", CHART_COLORS.map((c) => am5.color(c)));
      series.labels.template.set("visible", false);
      series.ticks.template.set("visible", false);
      series.slices.template.set("tooltipText", "{category}: {value} ({valuePercentTotal.formatNumber('0.0')}%)");
      series.data.setAll(data);

      const legend = chart.children.push(
        am5.Legend.new(root, {
          centerX: am5.p50,
          x: am5.p50,
          layout: root.horizontalLayout,
        }),
      );
      legend.labels.template.setAll({ fontSize: 12 });
      legend.valueLabels.template.set("visible", false);
      legend.data.setAll(series.dataItems);

      series.appear(600, 50);
    },
    [JSON.stringify(data)],
  );

  return <div ref={ref} className="w-full h-64" />;
}
