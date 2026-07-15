import { useLayoutEffect, useRef } from "react";
import * as am5 from "@amcharts/amcharts5";
import am5themes_Animated from "@amcharts/amcharts5/themes/Animated";

export const CHART_COLORS = [
  "#5b7f5b",
  "#a9744f",
  "#7d9d72",
  "#c9a35c",
  "#4f6e8c",
  "#8c5b6e",
  "#6b8f8a",
  "#b0885e",
];

export function useAmRoot(
  build: (root: am5.Root) => void,
  deps: unknown[],
) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const root = am5.Root.new(ref.current);
    root.setThemes([am5themes_Animated.new(root)]);
    root._logo?.dispose();
    build(root);
    return () => root.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
