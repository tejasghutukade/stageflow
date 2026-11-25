import { defineComponent } from "@openuidev/react-lang";
import { BarChartCondensed } from "@sf-openui-ui/Charts/BarChart/BarChartCondensed.js";
import { LineChartCondensed } from "@sf-openui-ui/Charts/LineChart/LineChartCondensed.js";
import { z } from "zod/v4";
import { chartPaletteForSeries } from "./theme";

const optString = z.string().nullable().optional();
const optNumber = z.number().nullable().optional();

type SeriesNode = { props?: { category?: unknown; values?: unknown } };

function seriesNodes(value: unknown): SeriesNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object") as SeriesNode[];
}

function chartRows(labels: unknown, series: unknown): Array<Record<string, string | number>> {
  const names = Array.isArray(labels) ? labels.map((label) => String(label)) : [];
  const nodes = seriesNodes(series);
  return names.map((label, index) => {
    const point: Record<string, string | number> = { category: label };
    for (const node of nodes) {
      const category = node.props?.category;
      const values = node.props?.values;
      if (typeof category === "string" && Array.isArray(values) && index < values.length && typeof values[index] === "number") {
        point[category] = values[index];
      }
    }
    return point;
  });
}

export const LIVE_BAR_MAX_WIDTH = 120;

function NoChart({ name }: { name: string }) {
  return (
    <p data-sf-component={name} data-sf-state="no-data" className="text-[13px] text-[var(--sf-text-2)]">
      No data
    </p>
  );
}

export const Series = defineComponent({
  name: "Series",
  description: "One chart series: category name, then numeric values.",
  props: z.object({
    category: z.string(),
    values: z.array(z.number()),
  }),
  component: () => null,
});

export const LineChart = defineComponent({
  name: "LineChart",
  description: "Line chart. labels, series, variant linear|natural|step, xLabel, yLabel, height.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    variant: z.enum(["linear", "natural", "step"]).nullable().optional(),
    xLabel: optString,
    yLabel: optString,
    height: optNumber,
  }),
  component: ({ props }) => {
    const data = chartRows(props.labels, props.series);
    const count = seriesNodes(props.series).length;
    if (data.length === 0 || count === 0) return <NoChart name="LineChart" />;
    return (
      <div data-sf-component="LineChart">
        <LineChartCondensed
          data={data}
          categoryKey="category"
          variant={props.variant ?? undefined}
          xAxisLabel={props.xLabel ?? undefined}
          yAxisLabel={props.yLabel ?? undefined}
          height={props.height ?? 240}
          isAnimationActive={false}
          customPalette={chartPaletteForSeries(count)}
        />
      </div>
    );
  },
});

export const BarChart = defineComponent({
  name: "BarChart",
  description: "Bar chart. labels, series, variant grouped|stacked, xLabel, yLabel, height.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    variant: z.enum(["grouped", "stacked"]).nullable().optional(),
    xLabel: optString,
    yLabel: optString,
    height: optNumber,
  }),
  component: ({ props }) => {
    const data = chartRows(props.labels, props.series);
    const count = seriesNodes(props.series).length;
    if (data.length === 0 || count === 0) return <NoChart name="BarChart" />;
    return (
      <div data-sf-component="BarChart">
        <BarChartCondensed
          data={data}
          categoryKey="category"
          variant={props.variant ?? undefined}
          xAxisLabel={props.xLabel ?? undefined}
          yAxisLabel={props.yLabel ?? undefined}
          height={props.height ?? 240}
          isAnimationActive={false}
          maxBarWidth={LIVE_BAR_MAX_WIDTH}
          customPalette={chartPaletteForSeries(count)}
        />
      </div>
    );
  },
});
