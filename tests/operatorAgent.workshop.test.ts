import { afterEach, describe, expect, it } from "vitest";
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
import { listPipelinesMultiProject } from "../src/config/multiProjectCatalog.js";
import { createRunStore } from "../src/runstore/createStore.js";
import {
  resetWorkshopChatSessionsForTests,
  runWorkshopChatTurn,
  WorkshopChatSessionRegistry,
  type WorkshopChatTurnResult,
} from "../src/workshop/chatTurn.js";
import {
  createWorkshopBuild,
  getWorkshopBuild,
  listWorkshopBuilds,
  listWorkshopPickerRows,
  resolvePickerCatalogPipelines,
  type WorkshopPickerRow,
} from "../src/workshop/buildStore.js";
import {
  createWorkshopSession,
  getWorkshopSession,
  resolveWorkshopSessionStoreRoot,
  updateWorkshopSessionActiveBuildId,
} from "../src/workshop/sessionStore.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  it("create_stage with a YAML string body stores those fields on the stage artifact", async () => {
    const host = createWorkshopOperatorHost([
      {
        type: "call_tool",
        name: "create_stage",
        args: {
          id: "review",
          body: [
            "system_prompt: Review the package carefully",
            "model: anthropic/claude-sonnet-4-5",
            "io:",
            "  input:",
            "    schema: { type: object }",
            "  output:",
            "    schema: { type: object }",
          ].join("\n"),
        },
        message: "Added review stage.",
      },
    ]);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("add review");
    const toolEvent = events.find((e) => e.type === "tool_result");
    expect(toolEvent?.type).toBe("tool_result");
    if (toolEvent?.type !== "tool_result") return;
    expect(toolEvent.result.ok).toBe(true);

    const draft = readDraftFromContext(session.getContext());
    expect(draft.pipeline.stages.length).toBe(1);
    expect(draft.stages?.[0]?.body.system_prompt).toBe(
      "Review the package carefully",
    );
    expect(draft.stages?.[0]?.body.id).toBe("review");
  });

  it("create_stage with an unparseable body string fails and does not add a stage", async () => {
    const host = createWorkshopOperatorHost([
      {
        type: "call_tool",
        name: "create_stage",
        args: {
          id: "broken",
          body: "not: [valid: yaml: {{{",
        },
        message: "failed",
      },
    ]);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("add broken");
    const toolEvent = events.find((e) => e.type === "tool_result");
    expect(toolEvent?.type).toBe("tool_result");
    if (toolEvent?.type !== "tool_result") return;
    expect(toolEvent.result.ok).toBe(false);
    expect(String(toolEvent.result.error)).toMatch(
      /body must be a JSON or YAML object/,
    );
    expect(readDraftFromContext(session.getContext()).pipeline.stages).toEqual(
      [],
    );
    expect(readDraftFromContext(session.getContext()).stages ?? []).toEqual([]);
  });

  it("propose_draft with top-level pipeline and stages succeeds", async () => {
    const host = createWorkshopOperatorHost([
      {
        type: "call_tool",
        name: "propose_draft",
        args: {
          summary: "Bulk replace",
          pipeline: {
            id: "top-level",
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
        },
        message: "Proposed draft.",
      },
    ]);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("propose");
    const toolEvent = events.find((e) => e.type === "tool_result");
    expect(toolEvent?.type).toBe("tool_result");
    if (toolEvent?.type !== "tool_result") return;
    expect(toolEvent.result.ok).toBe(true);

    const draft = readDraftFromContext(session.getContext());
    expect(draft.pipeline.id).toBe("top-level");
    expect(draft.pipeline.stages[0]!.id).toBe("clarify");
    expect(draft.stages?.[0]?.body.system_prompt).toBe("Clarify");
  });

  it("propose_draft with draft as a JSON string succeeds", async () => {
    const draftPayload = {
      pipeline: {
        id: "from-json",
        stages: [{ id: "plan", uses: "./plan.yaml", entry: true }],
      },
      stages: [
        {
          path: "./plan.yaml",
          body: {
            id: "plan",
            system_prompt: "Plan the work",
            model: MODEL,
            ...REQUIRED_IO,
          },
        },
      ],
    };
    const host = createWorkshopOperatorHost([
      {
        type: "call_tool",
        name: "propose_draft",
        args: {
          summary: "From JSON string",
          draft: JSON.stringify(draftPayload),
        },
        message: "Proposed draft.",
      },
    ]);
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("propose");
    const toolEvent = events.find((e) => e.type === "tool_result");
    expect(toolEvent?.type).toBe("tool_result");
    if (toolEvent?.type !== "tool_result") return;
    expect(toolEvent.result.ok).toBe(true);

    const draft = readDraftFromContext(session.getContext());
    expect(draft.pipeline.id).toBe("from-json");
    expect(draft.stages?.[0]?.body.system_prompt).toBe("Plan the work");
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

const DISK_PIPELINE = `id: shared-flow
stages:
  - id: step
    system_prompt: ok
    model: cursor/auto
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
`;

async function writeDiskPipeline(): Promise<{
  root: string;
  relativePath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-author-disk-"));
  const relativePath = "pipelines/one.pipeline.yaml";
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n",
    "utf8",
  );
  await writeFile(path.join(root, relativePath), DISK_PIPELINE, "utf8");
  return {
    root,
    relativePath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function toolEvent(result: WorkshopChatTurnResult) {
  const event = result.events.find((entry) => entry.type === "tool_result");
  if (!event || event.type !== "tool_result") {
    throw new Error("expected a tool_result");
  }
  return event;
}

describe("Workshop Author build tools", () => {
  afterEach(() => {
    resetWorkshopChatSessionsForTests();
  });

  it("list_builds on an unlinked chat returns the same rows the list route would, and an edit still fails", async () => {
    await withIsolatedHome(async () => {
      const fixture = await writeDiskPipeline();
      try {
        const storeRoot = resolveWorkshopSessionStoreRoot();
        createWorkshopSession(storeRoot, { id: "sess-list" });
        const untitled = createWorkshopBuild(storeRoot, {
          id: "build-notes",
          draft: {
            pipeline: {
              id: "notes",
              stages: [{ id: "scratch" }],
            },
          },
        });
        const catalog = createRunStore({ rootDir: storeRoot });
        await catalog.ensureProject(fixture.root);
        const listed = await listPipelinesMultiProject({ store: catalog });
        await catalog.close();
        const expected = listWorkshopPickerRows(
          storeRoot,
          resolvePickerCatalogPipelines(listed.items, listed.roots),
          listed.roots,
        );
        expect(expected).toContainEqual({
          id: untitled.id,
          name: "notes",
          projectRoot: null,
          relativePath: null,
        });
        expect(
          expected.some(
            (row) =>
              row.id === null && row.relativePath === fixture.relativePath,
          ),
        ).toBe(true);

        const before = listWorkshopBuilds(storeRoot);
        const host = createWorkshopOperatorHost([
          { type: "call_tool", name: "list_builds", args: {} },
          { type: "call_tool", name: "edit_pipeline", args: { id: "sneaky" } },
        ]);
        const registry = new WorkshopChatSessionRegistry(host);
        const listedTurn = await runWorkshopChatTurn({
          sessionId: "sess-list",
          draft: emptyDraftPackage("posted"),
          message: "what can I open",
          host,
          registry,
          storeRoot,
        });
        const listTool = toolEvent(listedTurn);
        expect(listTool.name).toBe("list_builds");
        expect(listTool.result.ok).toBe(true);
        const rows = (listTool.result.content as { rows: WorkshopPickerRow[] })
          .rows;
        expect(rows).toEqual(expected);
        expect(listWorkshopBuilds(storeRoot)).toEqual(before);
        expect(
          getWorkshopSession(storeRoot, "sess-list").activeBuildId,
        ).toBeUndefined();

        const editTurn = await runWorkshopChatTurn({
          sessionId: "sess-list",
          draft: emptyDraftPackage("posted"),
          message: "rename it",
          host,
          registry,
          storeRoot,
        });
        const editTool = toolEvent(editTurn);
        expect(editTool.name).toBe("edit_pipeline");
        expect(editTool.result.ok).toBe(false);
        expect(editTool.result.error).toMatch(/no build is selected/i);
        expect(listWorkshopBuilds(storeRoot)).toEqual(before);
        expect(
          getWorkshopSession(storeRoot, "sess-list").activeBuildId,
        ).toBeUndefined();
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("focus_build on a disk path creates one build, and a second call returns that id", async () => {
    await withIsolatedHome(async () => {
      const fixture = await writeDiskPipeline();
      try {
        const storeRoot = resolveWorkshopSessionStoreRoot();
        createWorkshopSession(storeRoot, { id: "sess-focus-disk" });
        const host = createWorkshopOperatorHost([
          {
            type: "call_tool",
            name: "focus_build",
            args: {
              projectRoot: fixture.root,
              relativePath: fixture.relativePath,
            },
          },
          {
            type: "call_tool",
            name: "focus_build",
            args: {
              projectRoot: fixture.root,
              relativePath: `./${fixture.relativePath}`,
            },
          },
        ]);
        const registry = new WorkshopChatSessionRegistry(host);
        const first = await runWorkshopChatTurn({
          sessionId: "sess-focus-disk",
          draft: emptyDraftPackage("posted"),
          message: "open that pipeline",
          host,
          registry,
          storeRoot,
        });
        const firstTool = toolEvent(first);
        expect(firstTool.result.ok).toBe(true);
        const firstId = (
          firstTool.result.content as { build: { id: string } }
        ).build.id;
        expect(first.buildId).toBe(firstId);
        expect(listWorkshopBuilds(storeRoot)).toHaveLength(1);
        expect(
          getWorkshopSession(storeRoot, "sess-focus-disk").activeBuildId,
        ).toBe(firstId);

        const second = await runWorkshopChatTurn({
          sessionId: "sess-focus-disk",
          draft: emptyDraftPackage("posted"),
          message: "open it again",
          host,
          registry,
          storeRoot,
        });
        const secondTool = toolEvent(second);
        expect(secondTool.result.ok).toBe(true);
        expect(
          (secondTool.result.content as { build: { id: string } }).build.id,
        ).toBe(firstId);
        expect(listWorkshopBuilds(storeRoot)).toHaveLength(1);
        expect(
          getWorkshopSession(storeRoot, "sess-focus-disk").activeBuildId,
        ).toBe(firstId);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("focus_build on a path loadDraftPackage cannot open returns the error and leaves the pointer unchanged", async () => {
    await withIsolatedHome(async () => {
      const fixture = await writeDiskPipeline();
      try {
        const storeRoot = resolveWorkshopSessionStoreRoot();
        createWorkshopSession(storeRoot, { id: "sess-focus-miss" });
        createWorkshopBuild(storeRoot, {
          id: "build-keep",
          draft: emptyDraftPackage("kept"),
        });
        updateWorkshopSessionActiveBuildId(
          storeRoot,
          "sess-focus-miss",
          "build-keep",
        );
        const host = createWorkshopOperatorHost([
          {
            type: "call_tool",
            name: "focus_build",
            args: {
              projectRoot: fixture.root,
              relativePath: "pipelines/missing.pipeline.yaml",
            },
          },
        ]);
        const registry = new WorkshopChatSessionRegistry(host);
        const result = await runWorkshopChatTurn({
          sessionId: "sess-focus-miss",
          draft: emptyDraftPackage("posted"),
          message: "open the missing one",
          host,
          registry,
          storeRoot,
        });
        const tool = toolEvent(result);
        expect(tool.name).toBe("focus_build");
        expect(tool.result.ok).toBe(false);
        expect(tool.result.error).toMatch(/does not exist/i);
        expect(listWorkshopBuilds(storeRoot).map((build) => build.id)).toEqual([
          "build-keep",
        ]);
        expect(
          getWorkshopSession(storeRoot, "sess-focus-miss").activeBuildId,
        ).toBe("build-keep");
        expect(result.buildId).toBe("build-keep");
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("create_build while another build is focused persists a new untitled build and moves the pointer", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-create-open" });
      createWorkshopBuild(storeRoot, {
        id: "build-open",
        draft: emptyDraftPackage("alpha"),
      });
      updateWorkshopSessionActiveBuildId(
        storeRoot,
        "sess-create-open",
        "build-open",
      );
      const host = createWorkshopOperatorHost([
        { type: "call_tool", name: "create_build", args: {} },
      ]);
      const registry = new WorkshopChatSessionRegistry(host);
      const result = await runWorkshopChatTurn({
        sessionId: "sess-create-open",
        draft: emptyDraftPackage("posted"),
        message: "build me a pipeline",
        host,
        registry,
        storeRoot,
      });
      const tool = toolEvent(result);
      expect(tool.name).toBe("create_build");
      expect(tool.result.ok).toBe(true);
      const created = (
        tool.result.content as {
          build: {
            id: string;
            projectRoot: string | null;
            relativePath: string | null;
            draft: DraftPackage;
          };
        }
      ).build;
      expect(created.id).not.toBe("build-open");
      expect(created.projectRoot).toBeNull();
      expect(created.relativePath).toBeNull();
      expect(created.draft.pipeline.id).toBe("untitled");
      expect(result.buildId).toBe(created.id);
      expect(
        getWorkshopSession(storeRoot, "sess-create-open").activeBuildId,
      ).toBe(created.id);
      expect(listWorkshopBuilds(storeRoot).map((build) => build.id).sort()).toEqual(
        ["build-open", created.id].sort(),
      );
      expect(getWorkshopBuild(storeRoot, "build-open").draft.pipeline.id).toBe(
        "alpha",
      );
      expect(getWorkshopBuild(storeRoot, created.id).draft.pipeline.id).toBe(
        "untitled",
      );
    });
  });
});
