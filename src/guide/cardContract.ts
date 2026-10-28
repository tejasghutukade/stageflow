export const GUIDE_LINK_KINDS = [
  "pipeline",
  "stage",
  "task",
  "agent",
  "trigger",
  "eval",
  "eval_run",
  "dataset",
  "connection",
  "memory",
  "run",
] as const;

export const GUIDE_RESOURCE_KINDS = ["agent", "trigger", "eval", "connection", "memory", "task"] as const;

export const GUIDE_UI_COMPONENTS = ["pipeline", "resource", "plan", "choices", "eval_report", "links"] as const;

export const GUIDE_UI_MAX_TEXT = 300;
export const GUIDE_UI_MAX_PLAN_STEPS = 12;
export const GUIDE_UI_MAX_CHOICES = 6;
export const GUIDE_UI_MAX_LINKS = 8;
export const GUIDE_UI_MAX_FAILURES = 5;
export const GUIDE_UI_MAX_MESSAGES = 5;

export type GuideLinkKind = (typeof GUIDE_LINK_KINDS)[number];
export type GuideUiComponent = (typeof GUIDE_UI_COMPONENTS)[number];

export type GuideLink = { kind: GuideLinkKind; id: string; path?: string; projectRoot?: string; label?: string };

export type GuidePipelineStage = {
  id: string;
  summary?: string;
  model?: string;
  needs: string[];
  gates: string[];
  channels: string[];
  hasVerify: boolean;
};

export type GuideUi =
  | {
      component: "pipeline";
      title: string;
      pipeline: {
        id: string;
        path: string;
        model?: string;
        stages: GuidePipelineStage[];
        memories: string[];
        task?: { id: string; goal: string };
      };
      validation: { ok: boolean; errors: number; warnings: number; messages: string[] };
      link: GuideLink;
    }
  | {
      component: "resource";
      title: string;
      kind: GuideLinkKind;
      fields: Array<{ label: string; value: string }>;
      status?: string;
      link: GuideLink;
    }
  | { component: "plan"; title: string; steps: Array<{ title: string; detail?: string; status: "todo" | "current" | "done" }> }
  | { component: "choices"; question: string; options: Array<{ id: string; label: string; description?: string }>; allowOther: boolean }
  | {
      component: "eval_report";
      title: string;
      evalId: string;
      runId: string;
      status: string;
      passRate: number | null;
      passed: boolean | null;
      cases: number;
      failures: Array<{ caseId: string; reason: string }>;
      costUsd: number | null;
      link: GuideLink;
    }
  | { component: "links"; title?: string; links: GuideLink[] };

export type GuideChoicesUi = Extract<GuideUi, { component: "choices" }>;
export type GuidePlanUi = Extract<GuideUi, { component: "plan" }>;
export type GuideLinksUi = Extract<GuideUi, { component: "links" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasArrays(value: unknown, keys: string[]): boolean {
  return isRecord(value) && keys.every((key) => Array.isArray(value[key]));
}

function isLinkKind(value: unknown): value is GuideLinkKind {
  return typeof value === "string" && (GUIDE_LINK_KINDS as readonly string[]).includes(value);
}

function clipText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > GUIDE_UI_MAX_TEXT ? `${trimmed.slice(0, GUIDE_UI_MAX_TEXT - 1)}…` : trimmed;
}

function requireText(value: string, code = "guide.ui_invalid_args"): string {
  const text = clipText(value);
  if (!text) throw new GuideCardError(code);
  return text;
}

export class GuideCardError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Structural check for a Guide card payload. Returns the same value when valid. */
export function validateGuideUi(value: unknown): GuideUi | null {
  if (!isRecord(value) || typeof value.component !== "string") return null;
  if (!(GUIDE_UI_COMPONENTS as readonly string[]).includes(value.component)) return null;
  switch (value.component) {
    case "pipeline": {
      if (!hasArrays(value.pipeline, ["stages"]) || !isRecord(value.validation) || !isRecord(value.link)) return null;
      const stages = (value.pipeline as { stages: unknown[] }).stages;
      if (!stages.every((stage) => isRecord(stage) && typeof stage.id === "string")) return null;
      break;
    }
    case "resource":
      if (!Array.isArray(value.fields) || !isRecord(value.link)) return null;
      break;
    case "plan":
      if (!Array.isArray(value.steps)) return null;
      break;
    case "choices":
      if (typeof value.question !== "string" || !Array.isArray(value.options)) return null;
      if (!value.options.every((option) => isRecord(option) && typeof option.id === "string" && typeof option.label === "string")) {
        return null;
      }
      break;
    case "eval_report":
      if (!Array.isArray(value.failures) || !isRecord(value.link)) return null;
      break;
    case "links":
      if (!Array.isArray(value.links)) return null;
      break;
    default:
      return null;
  }
  return value as GuideUi;
}

/** Card payload from a `show_ui` / confirm tool result, or null when the console cannot draw it. */
export function readGuideUi(result: unknown): GuideUi | null {
  if (!isRecord(result)) return null;
  return validateGuideUi(result.ui);
}

export function buildChoicesUi(input: {
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowOther?: boolean;
}): GuideChoicesUi {
  const question = requireText(input.question);
  if (input.options.length < 1 || input.options.length > GUIDE_UI_MAX_CHOICES) {
    throw new GuideCardError("guide.ui_invalid_args");
  }
  const options = input.options.map((option) => {
    const id = requireText(option.id);
    const label = requireText(option.label);
    const description = option.description !== undefined ? clipText(option.description) : undefined;
    return description ? { id, label, description } : { id, label };
  });
  return {
    component: "choices",
    question,
    options,
    allowOther: input.allowOther ?? false,
  };
}

export function buildPlanUi(input: {
  title: string;
  steps: Array<{ title: string; detail?: string; status: "todo" | "current" | "done" }>;
}): GuidePlanUi {
  const title = requireText(input.title);
  if (input.steps.length < 1 || input.steps.length > GUIDE_UI_MAX_PLAN_STEPS) {
    throw new GuideCardError("guide.ui_invalid_args");
  }
  return {
    component: "plan",
    title,
    steps: input.steps.map((step) => {
      const detail = step.detail !== undefined ? clipText(step.detail) : undefined;
      return {
        title: requireText(step.title),
        ...(detail ? { detail } : {}),
        status: step.status,
      };
    }),
  };
}

export function buildLinksUi(input: { title?: string; links: GuideLink[] }): GuideLinksUi {
  if (input.links.length < 1 || input.links.length > GUIDE_UI_MAX_LINKS) {
    throw new GuideCardError("guide.ui_invalid_args");
  }
  const title = input.title !== undefined ? requireText(input.title) : undefined;
  return {
    component: "links",
    ...(title ? { title } : {}),
    links: input.links.map((link) => {
      if (!isLinkKind(link.kind)) throw new GuideCardError("guide.ui_invalid_args");
      const next: GuideLink = { kind: link.kind, id: requireText(link.id) };
      if (link.path) next.path = requireText(link.path);
      if (link.projectRoot) next.projectRoot = requireText(link.projectRoot);
      if (link.label) next.label = requireText(link.label);
      return next;
    }),
  };
}
