import { defineComponent } from "@openuidev/react-lang";
import { Card as OpenUICard } from "@openuidev/react-ui/Card";
import { z } from "zod/v4";

function optEnum<const T extends [string, ...string[]]>(values: T) {
  return z.enum(values).nullable().optional();
}

const flex = {
  direction: optEnum(["row", "column"]),
  gap: optEnum(["none", "xs", "s", "m", "l", "xl", "2xl"]),
  align: optEnum(["start", "center", "end", "stretch", "baseline"]),
  justify: optEnum(["start", "center", "end", "between", "around", "evenly"]),
  wrap: z.boolean().nullable().optional(),
};

const gapMap: Record<string, string> = {
  none: "0",
  xs: "var(--openui-space-xs, 4px)",
  s: "var(--openui-space-s, 8px)",
  m: "var(--openui-space-m, 12px)",
  l: "var(--openui-space-l, 16px)",
  xl: "var(--openui-space-xl, 24px)",
  "2xl": "var(--openui-space-2xl, 32px)",
};

const alignMap: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};

const justifyMap: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};

export const Stack = defineComponent({
  name: "Stack",
  description: "Column or row of children. direction row|column. gap none|xs|s|m|l|xl|2xl.",
  props: z.object({
    children: z.array(z.any()),
    ...flex,
  }),
  component: ({ props, renderNode }) => {
    const justify = props.wrap && props.justify === "between" ? "start" : props.justify;
    const stretch = props.align === "stretch";
    return (
      <div
        data-sf-component="Stack"
        data-sf-align={props.align ?? ""}
        style={{
          display: "flex",
          flexDirection: props.direction ?? "column",
          gap: gapMap[props.gap || "m"] || gapMap.m,
          alignItems: props.align ? alignMap[props.align] : undefined,
          justifyContent: justify ? justifyMap[justify] : undefined,
          flexWrap: props.wrap ? "wrap" : undefined,
          minWidth: 0,
          maxWidth: "100%",
          ...(stretch ? { "--sf-live-align": "stretch", "--sf-live-item-width": "auto" } : {}),
        }}
      >
        {renderNode(props.children)}
      </div>
    );
  },
});

export const Card = defineComponent({
  name: "Card",
  description: "Panel. variant card|sunk|clear, then the same flex props as Stack.",
  props: z.object({
    children: z.array(z.any()),
    variant: optEnum(["card", "sunk", "clear"]),
    ...flex,
  }),
  component: ({ props, renderNode }) => {
    const panel = props.variant !== "sunk" && props.variant !== "clear";
    const stretch = props.align === "stretch";
    return (
      <div
        data-sf-component="Card"
        data-sf-card={panel ? "panel" : props.variant}
        data-sf-align={props.align ?? ""}
        style={panel ? { background: "var(--sf-panel)", border: "1px solid var(--sf-hairline)", borderRadius: "8px", padding: "16px", minWidth: 0, maxWidth: "100%" } : { minWidth: 0, maxWidth: "100%" }}
      >
        <OpenUICard
          variant={props.variant === "sunk" || props.variant === "clear" ? props.variant : "card"}
          width="full"
          style={{
            display: "flex",
            flexDirection: props.direction || "column",
            flexWrap: props.wrap ? "wrap" : "nowrap",
            gap: gapMap[props.gap || "m"] || gapMap.m,
            alignItems: alignMap[props.align || "stretch"] || "stretch",
            justifyContent: justifyMap[props.justify || "start"] || "flex-start",
            ...(stretch ? { "--sf-live-align": "stretch", "--sf-live-item-width": "auto" } : {}),
            ...(panel ? { background: "transparent", border: "none", boxShadow: "none" } : {}),
          }}
        >
          {renderNode(props.children)}
        </OpenUICard>
      </div>
    );
  },
});
