import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { globalStageflowHome, resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";

describe("stage worker home", () => {
  const prevHome = process.env.STAGEFLOW_HOME;
  const prevWorker = process.env.SF_WORKER_STAGEFLOW_HOME;
  const prevStage = process.env.SF_STAGE_WORKER;

  afterEach(() => {
    if (prevHome === undefined) delete process.env.STAGEFLOW_HOME;
    else process.env.STAGEFLOW_HOME = prevHome;
    if (prevWorker === undefined) delete process.env.SF_WORKER_STAGEFLOW_HOME;
    else process.env.SF_WORKER_STAGEFLOW_HOME = prevWorker;
    if (prevStage === undefined) delete process.env.SF_STAGE_WORKER;
    else process.env.SF_STAGE_WORKER = prevStage;
    resetGlobalStageflowHomeForTests();
  });

  it("passes the home in the worker env and not in argv", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-home-"));
    const recordPath = path.join(root, "spawn.json");
    const workerPath = path.join(root, "record.mjs");
    await writeFile(
      workerPath,
      [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.RECORD_PATH, JSON.stringify({ argv: process.argv, home: process.env.SF_WORKER_STAGEFLOW_HOME }));",
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf8",
    );
    const launcher = new StageProcessLauncher({
      cliEntry: workerPath,
      env: { RECORD_PATH: recordPath },
    });
    await launcher.launch({ runId: "r1", stageId: "s1", rootDir: root });
    const recorded = JSON.parse(await readFile(recordPath, "utf8")) as {
      argv: string[];
      home?: string;
    };
    expect(recorded.argv.join(" ")).not.toContain(globalStageflowHome());
    expect(recorded.argv).not.toContain("--stageflow-home");
    expect(recorded.home).toBe(globalStageflowHome());
  });

  it("pins the worker home and drops both env vars", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-pin-home-"));
    resetGlobalStageflowHomeForTests();
    delete process.env.STAGEFLOW_HOME;
    process.env.SF_WORKER_STAGEFLOW_HOME = home;
    try {
      await main(["node", "sf", "internal", "run-stage", "--run-id", "r", "--stage-id", "s"]);
    } catch {
      // The stage has no run. The home is pinned before that lookup.
    }
    expect(globalStageflowHome()).toBe(home);
    expect(process.env.SF_WORKER_STAGEFLOW_HOME).toBeUndefined();
    expect(process.env.STAGEFLOW_HOME).toBeUndefined();
  });
});
