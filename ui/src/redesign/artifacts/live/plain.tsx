import { defineComponent } from "@openuidev/react-lang";
import { Callout as OpenUICallout } from "@openuidev/react-ui/Callout";
import { Tag as OpenUITag } from "@openuidev/react-ui/Tag";
import { z } from "zod/v4";

const tone = z.enum(["ok", "needs", "fail", "running", "neutral"]);

export const liveTextWrap = {
  minWidth: 0,
  maxWidth: "100%",
  overflowWrap: "anywhere" as const,
  wordBreak: "break-word" as const,
};

const textSizeStyle: Record<string, { fontSize: string; fontWeight: number }> = {
  small: { fontSize: "12px", fontWeight: 400 },
  default: { fontSize: "13px", fontWeight: 400 },
  large: { fontSize: "20px", fontWeight: 500 },
  "small-heavy": { fontSize: "12px", fontWeight: 600 },
  "large-heavy": { fontSize: "28px", fontWeight: 600 },
};

const inlineItem = {
  alignSelf: "var(--sf-live-align, flex-start)",
  width: "var(--sf-live-item-width, fit-content)",
  maxWidth: "100%",
  minWidth: 0,
  overflowWrap: "anywhere" as const,
  wordBreak: "break-word" as const,
};

const toneVar: Record<string, string> = {
  ok: "var(--sf-ok)",
  needs: "var(--sf-needs)",
  fail: "var(--sf-fail)",
  running: "var(--sf-running)",
  neutral: "var(--sf-text-2)",
};

export const TextContent = defineComponent({
  name: "TextContent",
  description: "Plain text. size small|default|large|small-heavy|large-heavy. Text is text, not HTML.",
  props: z.object({
    text: z.string(),
    size: z.enum(["small", "default", "large", "small-heavy", "large-heavy"]).nullable().optional(),
  }),
  component: ({ props }) => {
    const size = props.size ?? "default";
    const typed = textSizeStyle[size] ?? textSizeStyle.default!;
    return (
      <p
        data-sf-component="TextContent"
        data-sf-size={size}
        className="whitespace-pre-wrap text-[var(--sf-text-1)]"
        style={{ fontFamily: "var(--sf-font-ui)", ...typed, ...liveTextWrap }}
      >
        {props.text ?? ""}
      </p>
    );
  },
});

export const Callout = defineComponent({
  name: "Callout",
  description: "Banner. variant info|warning|error|success|neutral.",
  props: z.object({
    variant: z.enum(["info", "warning", "error", "success", "neutral"]),
    title: z.string(),
    description: z.string(),
    visible: z.boolean().nullable().optional(),
  }),
  component: ({ props }) => {
    if (props.visible === false) return null;
    const variant = props.variant === "error" ? "danger" : props.variant === "success" ? "success" : props.variant === "info" || props.variant === "warning" || props.variant === "neutral" ? props.variant : "neutral";
    return (
      <div data-sf-component="Callout" data-sf-callout={props.variant ?? "neutral"} style={liveTextWrap}>
        <OpenUICallout variant={variant} title={props.title ?? ""} description={props.description ?? ""} />
      </div>
    );
  },
});

export const Tag = defineComponent({
  name: "Tag",
  description: "Short label. variant neutral|info|success|warning|danger. Pass null for icon.",
  props: z.object({
    text: z.string(),
    icon: z.any().nullable().optional(),
    size: z.enum(["sm", "md", "lg"]).nullable().optional(),
    variant: z.enum(["neutral", "info", "success", "warning", "danger"]).nullable().optional(),
  }),
  component: ({ props }) => (
    <span data-sf-component="Tag" style={inlineItem}>
      <OpenUITag text={props.text ?? ""} size={props.size ?? "sm"} variant={props.variant ?? "neutral"} />
    </span>
  ),
});

export const Stat = defineComponent({
  name: "Stat",
  description: "Single KPI. tone is ok, needs, fail, running, or neutral.",
  props: z.object({
    label: z.string(),
    value: z.string(),
    tone: tone.nullable().optional(),
  }),
  component: ({ props }) => (
    <div data-sf-component="Stat" className="rounded-lg border px-4 py-3" style={{ background: "var(--sf-panel)", borderColor: "var(--sf-hairline)", ...liveTextWrap }}>
      <div className="text-xs" style={{ color: "var(--sf-text-3)", fontFamily: "var(--sf-font-ui)" }}>
        {props.label}
      </div>
      <div className="mt-1 text-2xl font-medium" style={{ color: toneVar[props.tone ?? "neutral"] ?? toneVar.neutral, fontFamily: "var(--sf-font-ui)" }}>
        {props.value}
      </div>
    </div>
  ),
});

export const StatusPill = defineComponent({
  name: "StatusPill",
  description: "Status chip. tone is ok, needs, fail, running, or neutral.",
  props: z.object({
    tone,
    label: z.string(),
  }),
  component: ({ props }) => (
    <span
      data-sf-component="StatusPill"
      className="inline-flex h-6 items-center rounded-full px-2 text-xs font-medium"
      style={{
        ...inlineItem,
        color: toneVar[props.tone] ?? toneVar.neutral,
        background: `color-mix(in srgb, ${toneVar[props.tone] ?? toneVar.neutral} 16%, transparent)`,
        fontFamily: "var(--sf-font-ui)",
      }}
    >
      {props.label}
    </span>
  ),
});

export const SectionCard = defineComponent({
  name: "SectionCard",
  description: "Titled panel. title then body text.",
  props: z.object({
    title: z.string(),
    body: z.string(),
  }),
  component: ({ props }) => (
    <section data-sf-component="SectionCard" className="rounded-lg border px-4 py-3" style={{ background: "var(--sf-raised)", borderColor: "var(--sf-hairline)", ...liveTextWrap }}>
      <h2 className="text-sm font-medium" style={{ color: "var(--sf-text-1)", fontFamily: "var(--sf-font-ui)" }}>
        {props.title}
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--sf-text-2)", fontFamily: "var(--sf-font-ui)" }}>
        {props.body}
      </p>
    </section>
  ),
});
