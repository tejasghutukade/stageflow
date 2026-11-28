import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AreaChart,
  BarChart,
  HorizontalBarChart,
  LineChart,
  PieChart,
  pieRows,
  RadarChart,
  ScatterChart,
  ScatterSeries,
} from "./charts";

function markup(component: { component: unknown }, props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(component.component as never, { props, renderNode: () => null }));
}

const labelProps = {
  labels: ["North", "South"],
  series: [{ props: { category: "Sales", values: [120, 95] } }],
};

describe("live chart renderers", () => {
  it.each([
    ["LineChart", LineChart, labelProps],
    ["BarChart", BarChart, labelProps],
    ["HorizontalBarChart", HorizontalBarChart, labelProps],
    ["AreaChart", AreaChart, labelProps],
    ["RadarChart", RadarChart, labelProps],
    ["PieChart", PieChart, labelProps],
  ] as const)("renders %s with data", (_name, component, props) => {
    const html = markup(component, { ...props, height: 200 });
    expect(html).toContain(`data-sf-component="${_name}"`);
    expect(html).not.toContain('data-sf-state="no-data"');
  });

  it.each([
    ["LineChart", LineChart],
    ["BarChart", BarChart],
    ["HorizontalBarChart", HorizontalBarChart],
    ["AreaChart", AreaChart],
    ["RadarChart", RadarChart],
    ["PieChart", PieChart],
    ["ScatterChart", ScatterChart],
  ] as const)("shows No data for empty %s", (name, component) => {
    const props =
      name === "ScatterChart"
        ? { series: [], height: 200 }
        : name === "PieChart"
          ? { labels: [], series: [], height: 200 }
          : { labels: [], series: [], height: 200 };
    const html = markup(component, props);
    expect(html).toContain(`data-sf-component="${name}"`);
    expect(html).toContain('data-sf-state="no-data"');
    expect(html).toContain("No data");
  });

  it("renders ScatterChart with ScatterSeries data", () => {
    const series = [{ props: { name: "A", x: [1, 2], y: [3, 4] } }];
    const html = markup(ScatterChart, { series, height: 200 });
    expect(html).toContain('data-sf-component="ScatterChart"');
    expect(html).not.toContain('data-sf-state="no-data"');
  });

  it("keeps pie slice labels even when the series is called category", () => {
    const { rows, dataKey } = pieRows(["Water", "Land"], [{ props: { category: "category", values: [71, 29] } }]);
    expect(dataKey).toBe("category");
    expect(rows.map((row) => Object.values(row))).toEqual([["Water", 71], ["Land", 29]]);
  });

  it("exports ScatterSeries as a program-only stub", () => {
    expect(ScatterSeries.name).toBe("ScatterSeries");
    expect(markup(ScatterSeries, { name: "x", x: [1], y: [2] })).toBe("");
  });
});