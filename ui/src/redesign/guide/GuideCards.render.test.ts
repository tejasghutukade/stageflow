import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GuideUi } from "./api";
import { ChoicesCard, GuideUiCard, ToolActivity, type ToolActivityProps } from "./GuideCards";
import { GuideToolActivity, guideToolView, toolActivityState } from "./GuideTools";

type Ui<C extends GuideUi["component"]> = Extract<GuideUi, { component: C }>;

function card(ui: Exclude<GuideUi, { component: "choices" }>): string {
  return renderToStaticMarkup(createElement(GuideUiCard, { ui }));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const pipeline: Ui<"pipeline"> = {
  component: "pipeline",
  title: "Weekly release",
  pipeline: {
    id: "release",
    path: "pipelines/release.pipeline.yaml",
    model: "claude-sonnet",
    stages: [
      { id: "publish", needs: ["review"], gates: [], channels: ["slack-team"], hasVerify: false, summary: "Publish the notes" },
      { id: "draft", needs: [], gates: [], channels: [], hasVerify: true, summary: "Draft release notes" },
      { id: "review", needs: ["draft"], gates: ["approve"], channels: [], hasVerify: false },
    ],
    memories: ["style-guide"],
    task: { id: "weekly", goal: "Ship the weekly notes" },
  },
  validation: { ok: false, errors: 2, warnings: 0, messages: ["stage publish: channel slack-team is not configured"] },
  link: { kind: "pipeline", id: "release" },
};

describe("PipelineCard", () => {
  const html = card(pipeline);

  it("lists stages in dependency order with their needs", () => {
    const out = text(html);
    expect(out.indexOf("draft")).toBeLessThan(out.indexOf("review"));
    expect(out.indexOf("review")).toBeLessThan(out.indexOf("publish"));
    expect(out).toContain("after draft");
    expect(out).toContain("after review");
  });

  it("shows gate, verify and channel badges", () => {
    const out = text(html);
    expect(out).toContain("approve gate");
    expect(out).toContain("verify");
    expect(out).toContain("slack-team");
  });

  it("shows validation, task goal, memory and the console link", () => {
    const out = text(html);
    expect(out).toContain("2 errors");
    expect(out).toContain("channel slack-team is not configured");
    expect(out).toContain("Ship the weekly notes");
    expect(out).toContain("style-guide");
    expect(html).toContain('href="#/pipelines/release"');
    expect(out).toContain("Open in console");
  });

  it("shows a valid pipeline as valid", () => {
    expect(text(card({ ...pipeline, validation: { ok: true, errors: 0, warnings: 1, messages: [] } }))).toContain("Valid · 1 warning");
  });
});

describe("ResourceCard", () => {
  it("renders kind, title, status, fields and link", () => {
    const html = card({
      component: "resource",
      title: "Nightly digest",
      kind: "trigger",
      status: "enabled",
      fields: [
        { label: "Schedule", value: "Every day at 07:00" },
        { label: "Pipeline", value: "digest" },
      ],
      link: { kind: "trigger", id: "nightly" },
    });
    const out = text(html);
    expect(out).toContain("Trigger");
    expect(out).toContain("Nightly digest");
    expect(out).toContain("enabled");
    expect(out).toContain("Schedule Every day at 07:00");
    expect(html).toContain('href="#/triggers/nightly"');
  });

  it("renders no link when the kind has no console page", () => {
    const html = card({ component: "resource", title: "Run 3", kind: "eval_run", fields: [], link: { kind: "eval_run", id: "er_1" } });
    expect(html).not.toContain("href=");
  });
});

describe("PlanCard", () => {
  it("renders each step with its status", () => {
    const html = card({
      component: "plan",
      title: "Build the release flow",
      steps: [
        { title: "Write the pipeline", status: "done" },
        { title: "Add a review gate", status: "current", detail: "Approve before publish" },
        { title: "Schedule it", status: "todo" },
      ],
    });
    const out = text(html);
    expect(out).toContain("1 of 3 done");
    expect(out).toContain("Done: Write the pipeline");
    expect(out).toContain("In progress: Add a review gate");
    expect(out).toContain("Approve before publish");
    expect(out).toContain("To do: Schedule it");
    expect(html.match(/data-status="(\w+)"/g)).toEqual(['data-status="done"', 'data-status="current"', 'data-status="todo"']);
  });
});

describe("ChoicesCard", () => {
  const ui: Ui<"choices"> = {
    component: "choices",
    question: "Which should we build?",
    options: [
      { id: "p", label: "A pipeline", description: "Same steps every time" },
      { id: "a", label: "An agent" },
    ],
    allowOther: true,
  };
  const render = (disabled: boolean, allowOther = true) =>
    renderToStaticMarkup(createElement(ChoicesCard, { ui: { ...ui, allowOther }, disabled, onPick: () => {}, onOther: () => {} }));

  it("renders a button per option and Something else", () => {
    const html = render(false);
    const out = text(html);
    expect(out).toContain("Which should we build?");
    expect(out).toContain("A pipeline Same steps every time");
    expect(out).toContain("An agent");
    expect(out).toContain("Something else");
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).not.toContain('disabled=""');
  });

  it("disables every button once the thread moved on", () => {
    const html = render(true);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it("hides Something else when not allowed", () => {
    expect(text(render(false, false))).not.toContain("Something else");
  });
});

describe("EvalReportCard", () => {
  const report: Ui<"eval_report"> = {
    component: "eval_report",
    title: "Support replies",
    evalId: "support",
    runId: "er_9",
    status: "completed",
    passRate: 0.75,
    passed: false,
    cases: 8,
    failures: Array.from({ length: 7 }, (_, i) => ({ caseId: `case-${i + 1}`, reason: `Reason ${i + 1}` })),
    costUsd: 0.4321,
    link: { kind: "eval_run", id: "er_9" },
  };

  it("formats the numbers it is given", () => {
    const out = text(card(report));
    expect(out).toContain("Failed");
    expect(out).toContain("Pass rate 75.0%");
    expect(out).toContain("Cases 8");
    expect(out).toContain("Cost $0.43");
  });

  it("shows at most five failures", () => {
    const out = text(card(report));
    expect(out).toContain("case-5");
    expect(out).not.toContain("case-6");
    expect(out).toContain("2 more in the console");
  });

  it("falls back to the eval page when the run has no page", () => {
    expect(card(report)).toContain('href="#/evals/support"');
  });

  it("shows dashes for missing numbers", () => {
    const out = text(card({ ...report, passRate: null, costUsd: null, passed: null, status: "running", failures: [] }));
    expect(out).toContain("Pass rate —");
    expect(out).toContain("Cost —");
    expect(out).toContain("running");
  });
});

describe("LinksCard", () => {
  it("links kinds with a page and labels the rest", () => {
    const html = card({
      component: "links",
      title: "What I made",
      links: [
        { kind: "agent", id: "support", label: "Support agent" },
        { kind: "eval_run", id: "er_1", label: "Last eval run" },
      ],
    });
    expect(html).toContain('<a href="#/agents/support"');
    expect(text(html)).toContain("Support agent");
    expect(text(html)).toContain("Last eval run");
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});

describe("ToolActivity", () => {
  const render = (props: ToolActivityProps) => renderToStaticMarkup(createElement(ToolActivity, props));

  it("uses a plain verb while running and after", () => {
    expect(text(render({ name: "create_pipeline", state: "running", args: { id: "x" } }))).toContain("Creating pipeline");
    expect(text(render({ name: "create_pipeline", state: "complete", args: { id: "x" }, result: { ok: true } }))).toContain("Created pipeline");
    expect(render({ name: "create_pipeline", state: "running" })).toContain('role="status"');
  });

  it("keeps args and result in a collapsed details view", () => {
    const html = render({ name: "edit_stage", state: "complete", args: { id: "build" }, result: { changed: 1 } });
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(text(html)).toContain("Input");
    expect(html).toContain("&quot;id&quot;: &quot;build&quot;");
    expect(text(html)).toContain("Result");
  });

  it("shows an error in the muted error style", () => {
    const out = text(render({ name: "validate", state: "error", error: "Pipeline not found" }));
    expect(out).toContain("failed");
    expect(out).toContain("Pipeline not found");
  });

  it("falls back to the tool name", () => {
    expect(text(render({ name: "mystery", state: "complete" }))).toContain("mystery");
  });
});

const confirmResult = {
  confirmation_id: "cf_secret_123",
  tool: "delete_pipeline",
  next: "Call delete_pipeline with confirmation_id",
  ui: {
    component: "choices",
    question: "Delete the pipeline release?",
    options: [
      { id: "yes", label: "Yes, go ahead" },
      { id: "no", label: "No, don't" },
    ],
    allowOther: true,
  },
};

describe("guideToolView", () => {
  const complete = { type: "complete" } as const;

  it("draws the card of any tool whose result has a valid ui", () => {
    const ui = { component: "plan", title: "P", steps: [] };
    expect(guideToolView({ toolName: "create_pipeline", result: { path: "x", ui }, status: complete })).toEqual({ kind: "card", ui });
    expect(guideToolView({ toolName: "show_ui", result: { ui }, status: complete })).toEqual({ kind: "card", ui });
  });

  it("draws confirm_action as a confirmation", () => {
    expect(guideToolView({ toolName: "confirm_action", result: confirmResult, status: complete })).toEqual({
      kind: "choices",
      ui: confirmResult.ui,
      confirm: true,
    });
    expect(guideToolView({ toolName: "show_ui", result: { ui: confirmResult.ui }, status: complete })).toMatchObject({ kind: "choices", confirm: false });
  });

  it("falls back to an activity row while running, on error, or without a valid ui", () => {
    expect(guideToolView({ toolName: "confirm_action", result: undefined, status: { type: "running" } })).toEqual({ kind: "activity" });
    expect(guideToolView({ toolName: "show_ui", result: "boom", isError: true, status: complete })).toEqual({ kind: "activity" });
    expect(guideToolView({ toolName: "list_runs", result: [], status: complete })).toEqual({ kind: "activity" });
    expect(guideToolView({ toolName: "x", result: { ui: { component: "choices", options: [] } }, status: complete })).toEqual({ kind: "activity" });
  });
});

describe("confirm_action", () => {
  const render = (disabled: boolean) =>
    renderToStaticMarkup(
      createElement(ChoicesCard, { ui: confirmResult.ui as Ui<"choices">, confirm: true, disabled, onPick: () => {}, onOther: () => {} }),
    );

  it("shows the action to confirm with Yes as the primary button", () => {
    const html = render(false);
    const out = text(html);
    expect(html).toContain('aria-label="Confirm action"');
    expect(out).toContain("Confirm Delete the pipeline release?");
    expect(html).toMatch(/<button[^>]*data-primary=""[^>]*>Yes, go ahead<\/button>/);
    expect(html).not.toMatch(/<button[^>]*data-primary=""[^>]*>No, don&#x27;t<\/button>/);
    expect(out).toContain("Something else");
  });

  it("never shows the confirmation id", () => {
    expect(render(false)).not.toContain("cf_secret_123");
    const row = renderToStaticMarkup(
      createElement(GuideToolActivity, { toolName: "confirm_action", args: {}, result: { ...confirmResult, ui: null }, status: { type: "complete" } }),
    );
    expect(row).not.toContain("cf_secret_123");
    expect(row).not.toContain("&quot;confirmation_id&quot;");
    expect(text(row)).toContain("Asked you to confirm");
  });

  it("disables both answers once the thread moved on", () => {
    expect(render(true).match(/disabled=""/g)).toHaveLength(3);
  });
});

describe("toolActivityState", () => {
  it("reads the state from the tool-call part", () => {
    expect(toolActivityState({ isError: true, result: "x", status: { type: "complete" } })).toBe("error");
    expect(toolActivityState({ result: null, status: { type: "complete" } })).toBe("complete");
    expect(toolActivityState({ result: undefined, status: { type: "running" } })).toBe("running");
    expect(toolActivityState({ result: undefined, status: { type: "incomplete", reason: "cancelled" } })).toBe("stopped");
  });
});
