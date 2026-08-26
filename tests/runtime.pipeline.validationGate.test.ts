import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      readFileMock(...args);
      return actual.readFile(...args);
    },
  };
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import * as loadPipelineModule from "../src/config/loadPipeline.js";
import {
  PipelineValidationError,
  runPipeline,
  startPipeline,
} from "../src/runtime/pipelineRunner.js";
import { createRunStore } from "../src/runstore/createStore.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const sampleTaskPath = SAMPLE_TASK;

describe("preparePipeline validation gate", () => {
  afterEach(() => {
    readFileMock.mockClear();
    vi.restoreAllMocks();
  });

  it("AE-S3-1: broken pipeline rejects before task read and createRun", async () => {
    const loadSpy = vi.spyOn(loadPipelineModule, "loadPipelineValidated");
    const root = await mkdtemp(path.join(tmpdir(), "sf-val-gate-"));
    const store = createRunStore({ rootDir: root });
    const createRunSpy = vi.spyOn(store, "createRun");
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);

    await expect(
      runPipeline({
        agent,
        store,
        taskPath: sampleTaskPath,
        pipeline: pipelinePath("broken"),
        cwd: fixtures,
      }),
    ).rejects.toBeInstanceOf(PipelineValidationError);

    expect(createRunSpy).not.toHaveBeenCalled();
    expect(
      readFileMock.mock.calls.some(([filePath]) => filePath === sampleTaskPath),
    ).toBe(false);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("AE-S3-1: PipelineValidationError carries error findings for broken pipeline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-val-gate-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([]);

    let caught: PipelineValidationError | undefined;
    try {
      await runPipeline({
        agent,
        store,
        taskPath: sampleTaskPath,
        pipeline: pipelinePath("broken"),
        cwd: fixtures,
      });
    } catch (err) {
      caught = err as PipelineValidationError;
    }

    expect(caught).toBeInstanceOf(PipelineValidationError);
    expect(caught!.result.findings.length).toBeGreaterThan(0);
    expect(caught!.result.findings.some((f) => f.severity === "error")).toBe(true);
    expect(
      caught!.result.findings.some(
        (f) => f.severity === "error" && /missing stage/i.test(f.message),
      ),
    ).toBe(true);
  });

  it("AE-S3-2: docs-only succeeds despite broken sibling pipeline", async () => {
    const loadSpy = vi.spyOn(loadPipelineModule, "loadPipelineValidated");
    const root = await mkdtemp(path.join(tmpdir(), "sf-val-gate-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "c1", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "c2", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "c3", artifacts: [] },
      },
    ]);

    const result = await runPipeline({
      agent,
      store,
      taskPath: sampleTaskPath,
      pipeline: pipelinePath("docs-only"),
      cwd: fixtures,
    });

    expect(result.ok).toBe(true);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("AE-S3-4: startPipeline throws before createRun when pipeline is invalid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-val-gate-"));
    const store = createRunStore({ rootDir: root });
    const createRunSpy = vi.spyOn(store, "createRun");
    const agent = scriptedFakeAgent([]);

    await expect(
      startPipeline({
        agent,
        store,
        taskYaml: "id: t\ngoal: g\n",
        pipeline: pipelinePath("broken"),
        cwd: fixtures,
      }),
    ).rejects.toBeInstanceOf(PipelineValidationError);

    expect(createRunSpy).not.toHaveBeenCalled();
  });
});
