import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import {
  countLineChanges,
  createDraftPackage,
  type DraftPackage,
} from "../src/config/draftPackage.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const MODEL = "anthropic/claude-sonnet-4-5";

const CATALOG_MANIFEST = [
  "version: 1",
  "catalog:",
  "  pipelines:",
  "    - examples",
  "  tasks:",
  "    - examples",
  "",
].join("\n");

function packageDraft(id: string, prompt = "Plan the work."): DraftPackage {
  return {
    pipeline: {
      id,
      stages: [{ id: "plan", uses: "./plan.yaml", entry: true }],
    },
    stages: [
      {
        path: "plan.yaml",
        body: {
          id: "plan",
          system_prompt: prompt,
          model: MODEL,
          io: {
            input: { schema: { type: "object" } },
            output: { schema: { type: "object" } },
          },
        },
      },
    ],
    task: {
      filename: `${id}.task.yaml`,
      body: { id: `${id}-task`, input: { goal: "ship" } },
    },
  };
}

async function withDraftServer(root: string) {
  const store = createRunStore({ rootDir: root });
  await store.ensureProject(root);
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: root,
    rootDir: root,
    store,
    port: 0,
    uiDistDir: path.join(root, "missing-ui"),
  });
  const address = started.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close();
    },
  };
}

async function postPlan(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/drafts/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function withRepo(
  fn: (ctx: { root: string; base: string }) => Promise<void>,
): Promise<void> {
  const { root, cleanup } = await initTempGitRepo();
  await writeFile(path.join(root, "stageflow.yaml"), CATALOG_MANIFEST, "utf8");
  const server = await withDraftServer(root);
  try {
    await fn({ root, base: server.base });
  } finally {
    await server.close();
    await cleanup();
  }
}

describe("countLineChanges", () => {
  it("counts added and removed lines with an LCS diff", () => {
    expect(countLineChanges("a\nb\nc\n", "a\nb\nc\n")).toEqual({ added: 0, removed: 0 });
    expect(countLineChanges("a\nb\nc\n", "a\nx\nc\n")).toEqual({ added: 1, removed: 1 });
    expect(countLineChanges("a\nc\n", "a\nb\nc\nd\n")).toEqual({ added: 2, removed: 0 });
    expect(countLineChanges("a\nb\nc\n", "c\n")).toEqual({ added: 0, removed: 2 });
    expect(countLineChanges("", "a\nb\n")).toEqual({ added: 2, removed: 0 });
  });
});

describe("POST /api/drafts/plan", () => {
  it("plans a new package with the paths create writes", async () => {
    await withRepo(async ({ root, base }) => {
      const draft = packageDraft("fresh");
      const plan = await postPlan(base, {
        project_root: root,
        directory: "workshop/fresh",
        draft,
      });
      expect(plan.status).toBe(200);
      expect(plan.body.pipelinePath).toBe("workshop/fresh/fresh.pipeline.yaml");
      expect(plan.body.directory).toBe("workshop/fresh");
      expect(plan.body.pipelineIdTaken).toBe(false);
      expect(plan.body.files.map((f: { kind: string }) => f.kind)).toEqual([
        "pipeline",
        "stage",
        "task",
      ]);
      for (const file of plan.body.files) {
        expect(file.action).toBe("new");
        expect(file.removed).toBe(0);
        expect(file.added).toBeGreaterThan(0);
      }

      const created = await createDraftPackage(root, {
        directory: "workshop/fresh",
        draft,
        allowInvalid: true,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(plan.body.files.map((f: { path: string }) => f.path)).toEqual([
        created.pipelinePath,
        ...created.stagePaths,
        created.taskPath,
      ]);
      const pipelineText = await readFile(path.join(root, created.pipelinePath), "utf8");
      expect(plan.body.files[0].added).toBe(pipelineText.trimEnd().split("\n").length);
    });
  });

  it("reports unchanged and overwrite files with line counts", async () => {
    await withRepo(async ({ root, base }) => {
      const created = await createDraftPackage(root, {
        directory: "examples/edit",
        draft: packageDraft("edit"),
        allowInvalid: true,
      });
      expect(created.ok).toBe(true);

      const same = await postPlan(base, {
        project_root: root,
        directory: "examples/edit",
        draft: packageDraft("edit"),
        mode: "overwrite",
      });
      expect(same.status).toBe(200);
      for (const file of same.body.files) {
        expect(file).toEqual(
          expect.objectContaining({ action: "unchanged", added: 0, removed: 0 }),
        );
      }

      const edited = await postPlan(base, {
        project_root: root,
        directory: "examples/edit",
        draft: packageDraft("edit", "Plan the work carefully."),
        mode: "overwrite",
      });
      expect(edited.status).toBe(200);
      expect(edited.body.pipelineIdTaken).toBe(false);
      const byKind = Object.fromEntries(
        edited.body.files.map((f: { kind: string }) => [f.kind, f]),
      );
      expect(byKind.pipeline.action).toBe("unchanged");
      expect(byKind.task.action).toBe("unchanged");
      expect(byKind.stage).toEqual({
        path: "examples/edit/plan.yaml",
        kind: "stage",
        action: "overwrite",
        added: 1,
        removed: 1,
      });
    });
  });

  it("flags pipelineIdTaken when the id lives at another path in create mode", async () => {
    await withRepo(async ({ root, base }) => {
      const created = await createDraftPackage(root, {
        directory: "examples/dup",
        draft: packageDraft("dup"),
        allowInvalid: true,
      });
      expect(created.ok).toBe(true);

      const elsewhere = await postPlan(base, {
        project_root: root,
        directory: "examples/dup-copy",
        draft: packageDraft("dup"),
      });
      expect(elsewhere.status).toBe(200);
      expect(elsewhere.body.pipelineIdTaken).toBe(true);

      const samePath = await postPlan(base, {
        project_root: root,
        directory: "examples/dup",
        draft: packageDraft("dup"),
        mode: "create",
      });
      expect(samePath.body.pipelineIdTaken).toBe(false);

      const overwrite = await postPlan(base, {
        project_root: root,
        directory: "examples/dup-copy",
        draft: packageDraft("dup"),
        mode: "overwrite",
      });
      expect(overwrite.body.pipelineIdTaken).toBe(false);
    });
  });

  it("rejects invalid bodies like create does", async () => {
    await withRepo(async ({ root, base }) => {
      const badMode = await postPlan(base, {
        project_root: root,
        directory: "workshop/x",
        draft: packageDraft("x"),
        mode: "auto",
      });
      expect(badMode.status).toBe(400);

      const outside = await postPlan(base, {
        project_root: root,
        directory: "../outside",
        draft: packageDraft("x"),
      });
      expect(outside.status).toBe(400);

      const escaping = packageDraft("x");
      escaping.stages![0]!.path = "../escape.yaml";
      const escaped = await postPlan(base, {
        project_root: root,
        directory: "workshop/x",
        draft: escaping,
      });
      expect(escaped.status).toBe(400);
      expect(escaped.body.error).toMatch(/escapes package directory/);
    });
  });
});
