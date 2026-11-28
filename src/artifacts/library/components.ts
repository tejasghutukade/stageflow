import { z } from "zod/v4";
import { action, defineComponent, markReactive } from "./langCore.js";

const tone = z.enum(["ok", "needs", "fail", "running", "neutral"]);

function optEnum<const T extends [string, ...string[]]>(values: T) {
  return z.enum(values).nullable().optional();
}

const optString = z.string().nullable().optional();
const optNumber = z.number().nullable().optional();
const optAny = z.any().nullable().optional();

const flex = {
  direction: optEnum(["row", "column"]),
  gap: optEnum(["none", "xs", "s", "m", "l", "xl", "2xl"]),
  align: optEnum(["start", "center", "end", "stretch", "baseline"]),
  justify: optEnum(["start", "center", "end", "between", "around", "evenly"]),
  wrap: z.boolean().nullable().optional(),
};

const selectValue = z.string().nullable().optional();
markReactive(selectValue);
const inputValue = z.string().nullable().optional();
markReactive(inputValue);
const calloutVisible = z.boolean().nullable().optional();
markReactive(calloutVisible);

export const Stack = defineComponent({
  name: "Stack",
  description: "Column or row of children. direction row|column. gap none|xs|s|m|l|xl|2xl.",
  props: z.object({
    children: z.array(z.any()),
    ...flex,
  }),
  component: () => null,
});

export const Card = defineComponent({
  name: "Card",
  description: "Panel. variant card|sunk|clear, then the same flex props as Stack.",
  props: z.object({
    children: z.array(z.any()),
    variant: optEnum(["card", "sunk", "clear"]),
    ...flex,
  }),
  component: () => null,
});

export const CardHeader = defineComponent({
  name: "CardHeader",
  description: "Title and optional subtitle.",
  props: z.object({
    title: optString,
    subtitle: optString,
  }),
  component: () => null,
});

export const TextContent = defineComponent({
  name: "TextContent",
  description: "Plain text. size small|default|large|small-heavy|large-heavy. Text is text, not HTML.",
  props: z.object({
    text: z.string(),
    size: optEnum(["small", "default", "large", "small-heavy", "large-heavy"]),
  }),
  component: () => null,
});

export const Callout = defineComponent({
  name: "Callout",
  description: "Banner. variant info|warning|error|success|neutral.",
  props: z.object({
    variant: z.enum(["info", "warning", "error", "success", "neutral"]),
    title: z.string(),
    description: z.string(),
    visible: calloutVisible,
  }),
  component: () => null,
});

export const Col = defineComponent({
  name: "Col",
  description: "Table column. data is one value per row, or a plucked array.",
  props: z.object({
    label: z.string(),
    data: z.any(),
    type: optEnum(["string", "number", "action"]),
  }),
  component: () => null,
});

export const Table = defineComponent({
  name: "Table",
  description: "Column-oriented table. Each Col holds its own data array.",
  props: z.object({
    columns: z.array(Col.ref),
  }),
  component: () => null,
});

export const Tag = defineComponent({
  name: "Tag",
  description: "Short label. variant neutral|info|success|warning|danger. Pass null for icon.",
  props: z.object({
    text: z.string(),
    icon: optAny,
    size: optEnum(["sm", "md", "lg"]),
    variant: optEnum(["neutral", "info", "success", "warning", "danger"]),
  }),
  component: () => null,
});

export const Stat = defineComponent({
  name: "Stat",
  description: "Single KPI. tone is ok, needs, fail, running, or neutral.",
  props: z.object({
    label: z.string(),
    value: z.string(),
    tone: tone.nullable().optional(),
  }),
  component: () => null,
});

export const StatusPill = defineComponent({
  name: "StatusPill",
  description: "Status chip. tone is ok, needs, fail, running, or neutral.",
  props: z.object({
    tone: tone,
    label: z.string(),
  }),
  component: () => null,
});

export const SectionCard = defineComponent({
  name: "SectionCard",
  description: "Titled panel. title then body text.",
  props: z.object({
    title: z.string(),
    body: z.string(),
  }),
  component: () => null,
});

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
    variant: optEnum(["linear", "natural", "step"]),
    xLabel: optString,
    yLabel: optString,
    height: optNumber,
  }),
  component: () => null,
});

export const BarChart = defineComponent({
  name: "BarChart",
  description: "Bar chart. labels, series, variant grouped|stacked, xLabel, yLabel, height.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    variant: optEnum(["grouped", "stacked"]),
    xLabel: optString,
    yLabel: optString,
    height: optNumber,
  }),
  component: () => null,
});

export const HorizontalBarChart = defineComponent({
  name: "HorizontalBarChart",
  description: "Horizontal bar chart. labels, series, variant grouped|stacked, xLabel, yLabel, height.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    variant: optEnum(["grouped", "stacked"]),
    xLabel: optString,
    yLabel: optString,
    height: optNumber,
  }),
  component: () => null,
});

export const PieChart = defineComponent({
  name: "PieChart",
  description: "Pie chart. labels, series (one slice series), variant pie|donut, height.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    variant: optEnum(["pie", "donut"]),
    height: optNumber,
  }),
  component: () => null,
});

export const AreaChart = defineComponent({
  name: "AreaChart",
  description: "Area chart. labels, series, variant linear|natural|step, stacked, xLabel, yLabel, height.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    variant: optEnum(["linear", "natural", "step"]),
    stacked: z.boolean().nullable().optional(),
    xLabel: optString,
    yLabel: optString,
    height: optNumber,
  }),
  component: () => null,
});

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
  component: () => null,
});

export const RadarChart = defineComponent({
  name: "RadarChart",
  description: "Radar chart. labels, series, variant line|area, height.",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    variant: optEnum(["line", "area"]),
    height: optNumber,
  }),
  component: () => null,
});

export const SelectItem = defineComponent({
  name: "SelectItem",
  description: "Option for Select. value, then label.",
  props: z.object({
    value: z.string(),
    label: z.string(),
  }),
  component: () => null,
});

export const Select = defineComponent({
  name: "Select",
  description: "Filter bound to a $variable. name, items, placeholder, rules, value, size.",
  props: z.object({
    name: z.string(),
    items: z.array(SelectItem.ref),
    placeholder: optString,
    rules: optAny,
    value: selectValue,
    size: optEnum(["small", "medium", "large"]),
  }),
  component: () => null,
});

export const Input = defineComponent({
  name: "Input",
  description: "Read-only text field for local $variable state. Not a submit control.",
  props: z.object({
    name: z.string(),
    placeholder: optString,
    type: optEnum(["text", "email", "password", "number", "url"]),
    rules: optAny,
    value: inputValue,
  }),
  component: () => null,
});

export const Button = defineComponent({
  name: "Button",
  description: "Button. action is only @Set, @Reset, or @Run of a Query.",
  props: z.object({
    label: z.string(),
    action: action().nullable().optional(),
    variant: optEnum(["primary", "secondary", "tertiary"]),
    type: optEnum(["normal", "destructive"]),
    size: optEnum(["extra-small", "small", "medium", "large"]),
  }),
  component: () => null,
});

export const libraryComponents = [
  Stack,
  Card,
  CardHeader,
  TextContent,
  Callout,
  Table,
  Col,
  Tag,
  Stat,
  StatusPill,
  SectionCard,
  LineChart,
  BarChart,
  HorizontalBarChart,
  PieChart,
  AreaChart,
  ScatterChart,
  RadarChart,
  Series,
  ScatterSeries,
  Select,
  SelectItem,
  Input,
  Button,
];
