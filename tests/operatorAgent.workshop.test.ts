import { describe, expect, it } from "vitest";
import {
  createWorkshopDraftContext,
  createWorkshopOperatorHost,
  emptyDraftPackage,
  readDraftFromContext,
  withDraft,
  WORKSHOP_AUTHOR_GREETING,
  WORKSHOP_AUTHOR_PROFILE_ID,
} from "../src/operatorAgent/index.js";
import {
  createDraftPackage,
  validateDraftPackage,
  type DraftPackage,
} from "../src/config/draftPackage.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const MODEL = "anthropic/claude-sonnet-4-5";
const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

describe("Operator Agent Host — Workshop Author", () => {
  it("registers Workshop Author as the first profile", () => {
    const host = createWorkshopOperatorHost();
    const profiles = host.listProfiles();
    expect(profiles.map((p) => p.id)).toEqual([WORKSHOP_AUTHOR_PROFILE_ID]);
    expect(profiles[0]!.greeting).toBe(WORKSHOP_AUTHOR_GREETING);
  });

  it("create_stage tool mutates the draft immediately via emit path", async () => {
    const host = createWorkshopOperatorHost([
      {
        type: "call_tool",
        name: "create_stage",
        args: {
          id: "intake",
          system_prompt: "Collect intake",
          summary: "intake form review",
        },
        message: "Added intake stage.",
      },
    ]);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("add intake");
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.some((e) => e.type === "proposal")).toBe(true);

    const draft = readDraftFromContext(session.getContext());
    expect(draft.pipeline.stages.length).toBe(1);
    expect(draft.pipeline.stages[0]!.id).toBe("intake");
    expect(draft.stages?.[0]?.body.id).toBe("intake");
    expect(session.getPendingProposal()?.summary).toMatch(/Add stage/i);

    expect(session.undoMutation()).toEqual({ ok: true });
    expect(readDraftFromContext(session.getContext()).pipeline.stages).toEqual(
      [],
    );
  });

  it("save writes a valid package and blocks invalid without allowInvalid", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      const valid: DraftPackage = {
        pipeline: {
          id: "workshop-save",
          stages: [{ id: "clarify", uses: "./clarify.yaml", entry: true }],
        },
        stages: [
          {
            path: "./clarify.yaml",
            body: {
              id: "clarify",
              system_prompt: "Clarify",
              model: MODEL,
              ...REQUIRED_IO,
            },
          },
        ],
      };

      const host = createWorkshopOperatorHost([
        {
          type: "call_tool",
          name: "save",
          args: { directory: "pipelines", mode: "create" },
        },
      ]);
      const session = host.openSession({
        profileId: WORKSHOP_AUTHOR_PROFILE_ID,
        context: createWorkshopDraftContext(valid, {
          destination: { directory: "pipelines" },
          projectRoot: root,
        }),
      });

      const events = await session.send("save this");
      const toolEvent = events.find((e) => e.type === "tool_result");
      expect(toolEvent?.type).toBe("tool_result");
      if (toolEvent?.type !== "tool_result") return;
      expect(toolEvent.name).toBe("save");
      expect(toolEvent.result.ok).toBe(true);
      const yaml = await readFile(
        path.join(root, "pipelines", "workshop-save.pipeline.yaml"),
        "utf8",
      );
      expect(yaml).toContain("workshop-save");

      const invalidHost = createWorkshopOperatorHost([
        {
          type: "call_tool",
          name: "save",
          args: { directory: "pipelines", mode: "create" },
        },
      ]);
      const invalidSession = invalidHost.openSession({
        profileId: WORKSHOP_AUTHOR_PROFILE_ID,
        context: createWorkshopDraftContext(
          {
            pipeline: {
              id: "broken-save",
              stages: [{ id: "plan", system_prompt: "x", model: MODEL }],
            },
          },
          {
            destination: { directory: "pipelines" },
            projectRoot: root,
          },
        ),
      });
      const blocked = await invalidSession.send("save invalid");
      const blockedTool = blocked.find((e) => e.type === "tool_result");
      expect(blockedTool?.type).toBe("tool_result");
      if (blockedTool?.type !== "tool_result") return;
      expect(blockedTool.result.ok).toBe(false);
      expect(String(blockedTool.result.error)).toMatch(/validation|io|schema/i);
    } finally {
      await cleanup();
    }
  });

  it("save without destination fails clearly", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const host = createWorkshopOperatorHost([
        { type: "call_tool", name: "save", args: {} },
      ]);
      const session = host.openSession({
        profileId: WORKSHOP_AUTHOR_PROFILE_ID,
        context: createWorkshopDraftContext(emptyDraftPackage("demo"), {
          projectRoot: root,
        }),
      });
      const events = await session.send("save");
      const toolEvent = events.find((e) => e.type === "tool_result");
      expect(toolEvent?.type).toBe("tool_result");
      if (toolEvent?.type !== "tool_result") return;
      expect(toolEvent.result.ok).toBe(false);
      expect(toolEvent.result.error).toMatch(/destination is required/i);
    } finally {
      await cleanup();
    }
  });

  it("mutates the draft immediately; Reject / undoMutation restores when unchanged", async () => {
    const host = createWorkshopOperatorHost([{ type: "propose_stage" }]);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    expect(readDraftFromContext(session.getContext()).pipeline.stages).toEqual(
      [],
    );

    const events = await session.send("intake form review");
    expect(events.some((e) => e.type === "proposal")).toBe(true);

    const draftAfter = readDraftFromContext(session.getContext());
    expect(draftAfter.pipeline.stages.length).toBe(1);
    expect(draftAfter.stages?.length).toBe(1);

    const mutation = session.getPendingProposal();
    expect(mutation).not.toBeNull();
    expect(mutation!.summary).toMatch(/Add stage/i);
    expect(mutation!.artifacts?.length).toBeGreaterThan(0);
    expect(mutation!.affectedStageIds?.length).toBeGreaterThan(0);
    expect(mutation!.appliedFingerprint).toBeTruthy();

    expect(session.rejectProposal(mutation!.id)).toEqual({ ok: true });
    expect(session.getPendingProposal()).toBeNull();
    expect(readDraftFromContext(session.getContext()).pipeline.stages).toEqual(
      [],
    );

    await session.send("intake form review");
    expect(readDraftFromContext(session.getContext()).pipeline.stages.length).toBe(
      1,
    );
    const again = session.getPendingProposal();
    expect(again).not.toBeNull();
    expect(session.acceptProposal(again!.id)).toEqual({ ok: true });
    expect(session.getPendingProposal()).toBeNull();
    expect(readDraftFromContext(session.getContext()).pipeline.stages.length).toBe(
      1,
    );
  });

  it("undoMutation fails closed when the draft changed after apply", async () => {
    const host = createWorkshopOperatorHost([{ type: "propose_stage" }]);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    await session.send("intake form review");
    const mutation = session.getPendingProposal();
    expect(mutation).not.toBeNull();
    expect(readDraftFromContext(session.getContext()).pipeline.stages.length).toBe(
      1,
    );

    const edited = emptyDraftPackage("demo");
    edited.pipeline.stages = [
      { id: "manual", uses: "./manual.yaml", entry: true },
    ];
    edited.stages = [
      {
        path: "./manual.yaml",
        body: {
          id: "manual",
          system_prompt: "manual edit",
          model: MODEL,
          ...REQUIRED_IO,
        },
      },
    ];
    session.setContext(withDraft(session.getContext(), edited));

    const result = session.undoMutation(mutation!.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("conflict");
    expect(result.notice).toMatch(/draft changed/i);

    const draft = readDraftFromContext(session.getContext());
    expect(draft.pipeline.stages).toEqual(edited.pipeline.stages);
    expect(draft.pipeline.stages[0]!.id).toBe("manual");
  });

  it("fake model create_stage path puts a stage on the draft before Accept", async () => {
    const host = createWorkshopOperatorHost([{ type: "propose_stage" }]);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    await session.send("intake form review");
    expect(session.getPendingProposal()).not.toBeNull();
    expect(readDraftFromContext(session.getContext()).pipeline.stages.length).toBe(
      1,
    );
    expect(typeof readDraftFromContext(session.getContext()).pipeline.stages[0]!
      .id).toBe("string");
  });

  it("mutates task drafts immediately; undo restores prior task state", async () => {
    const host = createWorkshopOperatorHost([{ type: "propose_task" }]);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    expect(readDraftFromContext(session.getContext()).task).toBeUndefined();

    await session.send('create a task "release brief"');
    const mutation = session.getPendingProposal();
    expect(mutation).not.toBeNull();
    expect(mutation!.summary).toMatch(/Create task/i);
    expect(readDraftFromContext(session.getContext()).task?.filename).toBe(
      "release-brief.task.yaml",
    );

    expect(session.undoMutation(mutation!.id)).toEqual({ ok: true });
    expect(readDraftFromContext(session.getContext()).task).toBeUndefined();

    await session.send('create a task "release brief"');
    const again = session.getPendingProposal();
    expect(again).not.toBeNull();
    expect(session.acceptProposal(again!.id)).toEqual({ ok: true });

    const draft = readDraftFromContext(session.getContext());
    expect(draft.task?.filename).toBe("release-brief.task.yaml");
    expect(draft.task?.body.id).toBe("release-brief");
    expect(draft.task?.body.goal).toBe("release brief");
    expect(draft.pipeline.stages).toEqual([]);
  });

  it("is distinct from stage-execution AgentPort (no openStage/runStage)", () => {
    const host = createWorkshopOperatorHost();
    expect("openStage" in host).toBe(false);
    expect("runStage" in host).toBe(false);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(),
    });
    expect("openStage" in session).toBe(false);
    expect("runStage" in session).toBe(false);
  });
});

describe("createDraftPackage (first Save)", () => {
  it("creates a new package after validate and refuses when invalid", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await mkdir(path.join(root, "pipelines"), { recursive: true });

      const invalid: DraftPackage = {
        pipeline: {
          id: "broken",
          stages: [{ id: "plan", system_prompt: "x", model: MODEL }],
        },
      };
      const refused = await createDraftPackage(root, {
        directory: "pipelines",
        draft: invalid,
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.status).toBe(422);

      const valid: DraftPackage = {
        pipeline: {
          id: "workshop-demo",
          stages: [
            {
              id: "clarify",
              uses: "./clarify.yaml",
              entry: true,
            },
          ],
        },
        stages: [
          {
            path: "./clarify.yaml",
            body: {
              id: "clarify",
              system_prompt: "Clarify the task",
              model: MODEL,
              ...REQUIRED_IO,
            },
          },
        ],
      };

      const validation = await validateDraftPackage(valid, {
        cwd: root,
        projectRoot: root,
        strict: true,
      });
      expect(validation.ok).toBe(true);

      const created = await createDraftPackage(root, {
        directory: "pipelines",
        draft: valid,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.pipelinePath).toBe("pipelines/workshop-demo.pipeline.yaml");
      const yaml = await readFile(
        path.join(root, "pipelines", "workshop-demo.pipeline.yaml"),
        "utf8",
      );
      expect(yaml).toContain("workshop-demo");
      expect(yaml).toContain("clarify");

      const collision = await createDraftPackage(root, {
        directory: "pipelines",
        draft: valid,
      });
      expect(collision.ok).toBe(false);
      if (collision.ok) return;
      expect(collision.status).toBe(409);
    } finally {
      await cleanup();
    }
  });

  it("writes the task file when the draft includes a task", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await mkdir(path.join(root, "pipelines"), { recursive: true });
      const withTask: DraftPackage = {
        pipeline: {
          id: "with-task",
          stages: [
            {
              id: "clarify",
              uses: "./clarify.yaml",
              entry: true,
            },
          ],
        },
        stages: [
          {
            path: "./clarify.yaml",
            body: {
              id: "clarify",
              system_prompt: "Clarify the task",
              model: MODEL,
              ...REQUIRED_IO,
            },
          },
        ],
        task: {
          filename: "with-task.task.yaml",
          body: { id: "with-task", goal: "Run the packaged workflow" },
        },
      };

      const created = await createDraftPackage(root, {
        directory: "pipelines",
        draft: withTask,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.taskPath).toBe("pipelines/with-task.task.yaml");
      const taskYaml = await readFile(
        path.join(root, "pipelines", "with-task.task.yaml"),
        "utf8",
      );
      expect(taskYaml).toContain("Run the packaged workflow");
      expect(taskYaml).toContain("with-task");
    } finally {
      await cleanup();
    }
  });
});
