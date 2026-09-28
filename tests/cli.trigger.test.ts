import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { runTriggerCommand } from "../src/cli/triggerCommand.js";
import { runRunsCommand } from "../src/cli/runsCommand.js";
import { alreadyUp, startTestService } from "./helpers/testInProcessService.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const triggerFixture = path.join(fixtures, "triggers", "manual-hello-world.trigger.yaml");
const stageFixture = path.join(fixtures, "stages", "clarify.yaml");

async function seedCatalog(root: string): Promise<void> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await mkdir(path.join(root, "triggers"), { recursive: true });

  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n  triggers:\n    - triggers\n",
  );
  await writeFile(
    path.join(root, "pipelines", "hello.pipeline.yaml"),
    "id: hello\nstages:\n  - id: clarify\n    uses: ../stages/clarify.yaml\n",
  );
  await writeFile(path.join(root, "stages", "clarify.yaml"), await readFile(stageFixture, "utf8"));
  await writeFile(
    path.join(root, "tasks", "my-task.task.yaml"),
    "id: my-task\ngoal: Say hello\n",
  );
  await writeFile(
    path.join(root, "triggers", "manual-hello-world.trigger.yaml"),
    await readFile(triggerFixture, "utf8"),
  );
}

function successEnvelope(summary: string) {
  return {
    type: "emit" as const,
    envelope: {
      status: "success" as const,
      summary,
      artifacts: [],
      payload: {},
    },
  };
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      log: (line: string) => {
        stdout.push(line);
      },
      error: (line: string) => {
        stderr.push(line);
      },
    },
  };
}

describe("runTriggerCommand", () => {
  it("list/show/fire against the manual-hello-world fixture through the real Host", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-cli-home-"));
      const store = createRunStore({ rootDir: homeRoot });
      const agent = scriptedFakeAgent([successEnvelope("clarified")]);
      const service = await startTestService(store, agent, root);
      try {
        const listCap = captureIo();
        const listCode = await runTriggerCommand(["list", "--json"], {
          io: listCap.io,
          hostBaseUrl: service.baseUrl,
          ensureService: alreadyUp,
        });
        expect(listCode).toBe(0);
        const listed = JSON.parse(listCap.stdout.join("\n")) as {
          triggers: Array<{ id: string }>;
        };
        expect(listed.triggers.map((t) => t.id)).toEqual(["manual-hello-world"]);

        const showCap = captureIo();
        const showCode = await runTriggerCommand(
          ["show", "manual-hello-world", "--json"],
          { io: showCap.io, hostBaseUrl: service.baseUrl, ensureService: alreadyUp },
        );
        expect(showCode).toBe(0);
        const shown = JSON.parse(showCap.stdout.join("\n")) as { id: string; pipeline: string };
        expect(shown).toMatchObject({ id: "manual-hello-world", pipeline: "hello" });

        const fireCap = captureIo();
        const fireCode = await runTriggerCommand(
          ["fire", "manual-hello-world", "--json"],
          { io: fireCap.io, hostBaseUrl: service.baseUrl, ensureService: alreadyUp },
        );
        expect(fireCode).toBe(0);
        const fired = JSON.parse(fireCap.stdout.join("\n")) as {
          ok: boolean;
          outcome: string;
          runId: string;
        };
        expect(fired.ok).toBe(true);
        expect(fired.outcome).toBe("succeeded");

        const trigger = await store.getTrigger("manual-hello-world");
        expect(trigger?.last_run_id).toBe(fired.runId);

        const runsShowCap = captureIo();
        const runsShowCode = await runRunsCommand(["show", "--run", fired.runId, "--json"], {
          store,
          cwd: root,
          io: runsShowCap.io,
        });
        expect(runsShowCode).toBe(0);
        const shownRun = JSON.parse(runsShowCap.stdout.join("\n")) as {
          run_id: string;
          pipeline_id: string;
        };
        expect(shownRun.run_id).toBe(fired.runId);
        expect(shownRun.pipeline_id).toBe("hello");
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("fire on an unknown trigger id exits 1 with a JSON error", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-cli-missing-home-"));
      const store = createRunStore({ rootDir: homeRoot });
      const service = await startTestService(store, scriptedFakeAgent([]), root);
      try {
        const cap = captureIo();
        const code = await runTriggerCommand(
          ["fire", "no-such-trigger", "--json"],
          { io: cap.io, hostBaseUrl: service.baseUrl, ensureService: alreadyUp },
        );
        expect(code).toBe(1);
        const payload = JSON.parse(cap.stdout.join("\n")) as { reason: string };
        expect(payload.reason).toContain("no-such-trigger");
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("fire on a disabled trigger exits 1 with a JSON error", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      await writeFile(
        path.join(root, "triggers", "manual-disabled.trigger.yaml"),
        "id: manual-disabled\npipeline: hello\ntask: my-task\nkind: manual\nenabled: false\n",
      );
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-cli-disabled-"));
      const store = createRunStore({ rootDir: homeRoot });
      const service = await startTestService(store, scriptedFakeAgent([]), root);
      try {
        const cap = captureIo();
        const code = await runTriggerCommand(
          ["fire", "manual-disabled", "--json"],
          { io: cap.io, hostBaseUrl: service.baseUrl, ensureService: alreadyUp },
        );
        expect(code).toBe(1);
        const payload = JSON.parse(cap.stdout.join("\n")) as { reason: string };
        expect(payload.reason).toMatch(/disabled/i);
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("show on an unknown trigger id exits 1", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedCatalog(root);
      clearFindProjectRootCacheForTests();

      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-trigger-cli-show-missing-"));
      const store = createRunStore({ rootDir: homeRoot });
      const service = await startTestService(store, scriptedFakeAgent([]), root);
      try {
        const cap = captureIo();
        const code = await runTriggerCommand(
          ["show", "no-such-trigger", "--json"],
          { io: cap.io, hostBaseUrl: service.baseUrl, ensureService: alreadyUp },
        );
        expect(code).toBe(1);
        const payload = JSON.parse(cap.stdout.join("\n")) as { error: string };
        expect(payload.error).toContain("no-such-trigger");
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
