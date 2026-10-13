import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DraftPackagePayload, ValidationFinding } from "../../../api";
import { WorkshopInspectorPanel, type WorkshopInspectorPanelProps } from "./WorkshopInspectorPanel";

const draft: DraftPackagePayload = {
  pipeline: {
    id: "feature-ship",
    stages: [
      { id: "implement", uses: "./stages/implement.yaml", entry: true, route: [{ to: "security-scan" }] },
      {
        id: "security-scan",
        uses: "./stages/security-scan.yaml",
        on_verify_fail: { mode: "manual", retry_safety: "side_effecting" },
      },
    ],
  },
  stages: [
    {
      path: "stages/implement.yaml",
      body: {
        id: "implement",
        system_prompt: "Implement it.",
        io: { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } },
      },
    },
    {
      path: "stages/security-scan.yaml",
      body: {
        id: "security-scan",
        system_prompt: "You are a security reviewer.\nRun semgrep.",
        gate_kinds: ["confirm"],
        io: {
          input: { schema: { type: "object", required: ["diff_patch"], properties: { diff_patch: { type: "string" } } } },
          output: { schema: { type: "object", properties: { findings: { type: "array" } } } },
        },
        verify: [
          { id: "report", type: "artifact", basename: "security-report.md", when: ["emit"] },
          { id: "semgrep", type: "command", run: "semgrep --config auto --error" },
        ],
      },
    },
  ],
};

const findings: ValidationFinding[] = [
  {
    severity: "error",
    code: "pipeline.io_incompatible",
    path: "feature-ship.pipeline.yaml",
    message: 'Pipeline feature-ship: stage "security-scan" io.input is not a structural subset of "implement" io.output',
    category: "pipeline",
  },
];

function render(overrides: Partial<WorkshopInspectorPanelProps>): string {
  const props: WorkshopInspectorPanelProps = {
    draft,
    baseline: null,
    selectedStageId: null,
    tab: "stage",
    onTabChange: () => {},
    onDraftChange: () => {},
    onDeleteStage: () => {},
    onRenameStage: () => {},
    findings,
    models: ["anthropic/claude-sonnet-4-5"],
    defaultModel: "anthropic/claude-sonnet-4-5",
    focusField: null,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(WorkshopInspectorPanel, props));
}

describe("WorkshopInspectorPanel render", () => {
  it("renders the empty state with the Pipeline hint card", () => {
    const html = render({ draft: { pipeline: { id: "untitled", stages: [] } } });
    expect(html).toContain("Select a stage to edit its fields");
    expect(html).toContain("Pipeline tab");
    expect(html).toContain("needs attention");
  });

  it("renders the stage form with inline io error and delete control", () => {
    const html = render({ selectedStageId: "security-scan" });
    expect(html).toContain("stages/security-scan.yaml · unsaved");
    expect(html).toContain("Delete stage security-scan");
    expect(html).toContain("diff_patch");
    expect(html).toContain("is not a structural subset");
    expect(html).toContain("semgrep --config auto --error");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("security-report.md");
    expect(html).toContain("findings[]");
    expect(html).not.toContain("needs attention");
  });

  it("renders the pipeline form with needs chips", () => {
    const html = render({ tab: "pipeline", baseline: draft });
    expect(html).toContain("feature-ship.yaml");
    expect(html).toContain("default model");
    expect(html).toContain("Add a stage security-scan needs");
    expect(html).not.toContain(" · unsaved");
  });

  it("renders the real pipeline path when saved", () => {
    const html = render({
      tab: "pipeline",
      baseline: draft,
      pipelinePath: "pipelines/feature-ship.pipeline.yaml",
    });
    expect(html).toContain("pipelines/feature-ship.pipeline.yaml");
  });
});
