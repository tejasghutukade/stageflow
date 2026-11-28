import { defineComponent } from "@openuidev/react-lang";
import { AreaChartCondensed } from "@sf-openui-ui/Charts/AreaChart/AreaChartCondensed.js";
import { BarChartCondensed } from "@sf-openui-ui/Charts/BarChart/BarChartCondensed.js";
import { HorizontalBarChart as HorizontalBarChartView } from "@sf-openui-ui/Charts/BarChart/HorizontalBarChart.js";
import { LineChartCondensed } from "@sf-openui-ui/Charts/LineChart/LineChartCondensed.js";
import { PieChart as PieChartView } from "@sf-openui-ui/Charts/PieChart/PieChart.js";
import { RadarChart as RadarChartView } from "@sf-openui-ui/Charts/RadarChart/RadarChart.js";
import { ScatterChart as ScatterChartView } from "@sf-openui-ui/Charts/ScatterChart/ScatterChart.js";
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

export const HorizontalBarChart = defineComponent({
  name: "HorizontalBarChart",
  description: "Horizontal bar chart. labels, series, variant grouped|stacked, xLabel, yLabel, height.",
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
    if (data.length === 0 || count === 0) return <NoChart name="HorizontalBarChart" />;
    return (
      <div data-sf-component="HorizontalBarChart">
        <HorizontalBarChartView
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

/** Slice labels use a key no series name can take, so a series called "category" cannot overwrite them. */
const PIE_LABEL_KEY = "__sf_slice_label";

export function pieRows(labels: unknown, series: unknown): { rows: Array<Record<string, string | number>>; dataKey: string | undefined } {
  const names = Array.isArray(labels) ? labels.map((label) => String(label)) : [];
  const nodes = seriesNodes(series);
  const first = nodes[0];
  const dataKey = typeof first?.props?.category === "string" ? first.props.category : undefined;
  const values = Array.isArray(first?.props?.values) ? first!.props!.values : [];
  if (names.length === 0 || !dataKey) return { rows: [], dataKey: undefined };
  const rows = names.flatMap((label, index) => {
    const value = index < values.length && typeof values[index] === "number" ? values[index] : undefined;
    if (value === undefined) return [];
    return [{ [PIE_LABEL_KEY]: label, [dataKey]: value }];
  });
  return { rows, dataKey };
}

export const PieChart = defineComponent({
  name: "PieChart",
  description: "Pie chart. labels, series (one slice series), variant pie|donut, height.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    variant: z.enum(["pie", "donut"]).nullable().optional(),
    height: optNumber,
  }),
  component: ({ props }) => {
    const { rows, dataKey } = pieRows(props.labels, props.series);
    if (rows.length === 0 || !dataKey) return <NoChart name="PieChart" />;
    return (
      <div data-sf-component="PieChart">
        <PieChartView
          data={rows}
          categoryKey={PIE_LABEL_KEY}
          dataKey={dataKey}
          variant={props.variant ?? undefined}
          height={props.height ?? 240}
          isAnimationActive={false}
          customPalette={chartPaletteForSeries(rows.length)}
        />
      </div>
    );
  },
});

export const AreaChart = defineComponent({
  name: "AreaChart",
  description: "Area chart. labels, series, variant linear|natural|step, stacked, xLabel, yLabel, height.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    variant: z.enum(["linear", "natural", "step"]).nullable().optional(),
    stacked: z.boolean().nullable().optional(),
    xLabel: optString,
    yLabel: optString,
    height: optNumber,
  }),
  component: ({ props }) => {
    const data = chartRows(props.labels, props.series);
    const count = seriesNodes(props.series).length;
    if (data.length === 0 || count === 0) return <NoChart name="AreaChart" />;
    return (
      <div data-sf-component="AreaChart">
        <AreaChartCondensed
          data={data}
          categoryKey="category"
          variant={props.variant ?? undefined}
          stacked={props.stacked ?? undefined}
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

type ScatterSeriesNode = { props?: { name?: unknown; x?: unknown; y?: unknown } };

function scatterSeriesNodes(value: unknown): ScatterSeriesNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object") as ScatterSeriesNode[];
}

function scatterDatasets(series: unknown): Array<{ name: string; data: Array<{ x: number; y: number }> }> {
  return scatterSeriesNodes(series).flatMap((node) => {
    const name = typeof node.props?.name === "string" ? node.props.name : "";
    const xs = Array.isArray(node.props?.x) ? node.props.x : [];
    const ys = Array.isArray(node.props?.y) ? node.props.y : [];
    if (!name) return [];
    const data: Array<{ x: number; y: number }> = [];
    const len = Math.min(xs.length, ys.length);
    for (let index = 0; index < len; index += 1) {
      if (typeof xs[index] === "number" && typeof ys[index] === "number") {
        data.push({ x: xs[index] as number, y: ys[index] as number });
      }
    }
    return data.length > 0 ? [{ name, data }] : [];
  });
}

export const ScatterSeries = defineComponent({
  name: "ScatterSeries",
  description: "One scatter series: name, parallel x and y value arrays.",
  props: z.object({
    name: z.string(),
    x: z.array(z.number()),
    y: z.array(z.number()),
  }),
  component: () => null,
});

export const ScatterChart = defineComponent({
  name: "ScatterChart",
  description: "Scatter plot. series (ScatterSeries refs), xLabel, yLabel, height.",
  props: z.object({
    series: z.array(ScatterSeries.ref),
    xLabel: optString,
    yLabel: optString,
    height: optNumber,
  }),
  component: ({ props }) => {
    const data = scatterDatasets(props.series);
    if (data.length === 0) return <NoChart name="ScatterChart" />;
    return (
      <div data-sf-component="ScatterChart">
        <ScatterChartView
          data={data}
          xAxisLabel={props.xLabel ?? undefined}
          yAxisLabel={props.yLabel ?? undefined}
          height={props.height ?? 240}
          isAnimationActive={false}
          customPalette={chartPaletteForSeries(data.length)}
        />
      </div>
    );
  },
});

export const RadarChart = defineComponent({
  name: "RadarChart",
  description: "Radar chart. labels, series, variant line|area, height.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    variant: z.enum(["line", "area"]).nullable().optional(),
    height: optNumber,
  }),
  component: ({ props }) => {
    const data = chartRows(props.labels, props.series);
    const count = seriesNodes(props.series).length;
    if (data.length === 0 || count === 0) return <NoChart name="RadarChart" />;
    return (
      <div data-sf-component="RadarChart">
        <RadarChartView
          data={data}
          categoryKey="category"
          variant={props.variant ?? undefined}
          height={props.height ?? 240}
          isAnimationActive={false}
          customPalette={chartPaletteForSeries(count)}
        />
      </div>
    );
  },
});
