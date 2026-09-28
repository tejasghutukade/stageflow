import { describe, expect, it } from "vitest";
import {
  canOfferRunShortcut,
  emptyDraftPackage,
  isTaskProposalIntent,
  proposeTaskFromMessage,
} from "./draft";
import {
  createTaskInDraft,
  detachTaskFromDraft,
  setTaskInDraft,
} from "./draftEdits";
import { newRunPath, parseHash } from "../routes";

describe("workshop task draft helpers", () => {
  it("creates and detaches a task on the virtual draft", () => {
    const base = emptyDraftPackage("demo");
    const withTask = createTaskInDraft(base, {
      id: "demo-task",
      goal: "Ship the package",
    });
    expect(withTask.task).toEqual({
      filename: "demo-task.task.yaml",
      body: { id: "demo-task", goal: "Ship the package" },
    });
    expect(detachTaskFromDraft(withTask).task).toBeUndefined();
  });

  it("attaches an existing task artifact into the draft", () => {
    const draft = setTaskInDraft(emptyDraftPackage("demo"), {
      filename: "existing.task.yaml",
      body: { id: "existing", goal: "From catalog" },
    });
    expect(draft.task?.filename).toBe("existing.task.yaml");
    expect(draft.task?.body.goal).toBe("From catalog");
  });

  it("routes task create/fill proposals from NL intent", () => {
    expect(isTaskProposalIntent("create a task for release")).toBe(true);
    expect(isTaskProposalIntent("fill task goal: review PR")).toBe(true);
    expect(isTaskProposalIntent("add an intake stage")).toBe(false);

    const proposal = proposeTaskFromMessage(
      emptyDraftPackage("demo"),
      'create a task "ops brief"',
    );
    expect(proposal.summary).toMatch(/Create task/i);
    expect(proposal.nextDraft.task?.body.id).toBe("ops-brief");
    expect(proposal.nextDraft.task?.body.goal).toBe("ops brief");
    expect(proposal.artifacts.some((a) => a.kind === "added")).toBe(true);
    expect(proposal.affectedStageIds).toEqual([]);
  });

  it("offers Run shortcut only after Save with a task still attached", () => {
    expect(
      canOfferRunShortcut({
        savedPipelinePath: "pipelines/demo.pipeline.yaml",
        savedTaskPath: "pipelines/demo.task.yaml",
        hasTaskInDraft: true,
      }),
    ).toBe(true);
    expect(
      canOfferRunShortcut({
        savedPipelinePath: "pipelines/demo.pipeline.yaml",
        savedTaskPath: null,
        hasTaskInDraft: true,
      }),
    ).toBe(false);
    expect(
      canOfferRunShortcut({
        savedPipelinePath: "pipelines/demo.pipeline.yaml",
        savedTaskPath: "pipelines/demo.task.yaml",
        hasTaskInDraft: false,
      }),
    ).toBe(false);
  });
});

describe("Run this workflow deep-link", () => {
  it("builds New Run hash with pipeline and task paths filled", () => {
    const path = newRunPath({
      pipeline: "pipelines/demo.pipeline.yaml",
      task: "pipelines/demo.task.yaml",
    });
    expect(path).toBe(
      "/new?pipeline=pipelines%2Fdemo.pipeline.yaml&task=pipelines%2Fdemo.task.yaml",
    );
    expect(parseHash(`#${path}`)).toEqual({
      name: "new",
      pipelineId: "pipelines/demo.pipeline.yaml",
      taskPath: "pipelines/demo.task.yaml",
    });
  });
});
