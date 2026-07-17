import { useLayoutEffect, useRef } from "react";
import * as am5 from "@amcharts/amcharts5";
import am5themes_Animated from "@amcharts/amcharts5/themes/Animated";

// Official Sage Oak 2025-26 brand palette (plus derived tints for longer series).
export const CHART_COLORS = [
  "#687664", // deep green (primary)
  "#c98d4b", // warm gold (darkened from brand gold for contrast)
  "#8d9e88", // sage
  "#1c476c", // navy
  "#f2ce8a", // brand gold
  "#374f59", // slate
  "#a9b8a4", // light sage tint
  "#5c7a9a", // navy tint
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
