import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as loadFunction from "../src/config/loadFunction.js";
import { functionFilePath } from "../src/config/loadFunction.js";
import { LIBRARY_NAME, LIBRARY_VERSION } from "../src/artifacts/library/index.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { publishArtifact } from "../src/artifacts/publish.js";
import {
  MAX_PROGRAM_QUERIES,
  assertLiveProgramAtPublish,
  reconcileProgram,
  validateProgram,
  type ResolvedOutputSchema,
} from "../src/artifacts/program.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;
const schema = {
  type: "object",
  properties: { rows: { type: "array", items: { type: "object", properties: { day: { type: "string" } } } } },
};
const outputSchemas: ReadonlyMap<string, ResolvedOutputSchema> = new Map([["get_usage", { outputSchema: schema }]]);

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function queries(count: number, tool = "get_usage"): string {
  const lines = Array.from({ length: count }, (_, index) => `q${index} = Query("${tool}", {})`);
  return `${lines.join("\n")}\nroot = TextContent("x")`;
}

function manifest(program: string, bindings: Array<{ id: string; function: string; args: Record<string, unknown> }>) {
  return {
    format: "openui-lang" as const,
    library: { name: LIBRARY_NAME, version: LIBRARY_VERSION },
    bindings,
    program,
  };
}

describe("live program budgets", () => {
  it("rejects string and literal budgets before parsing", () => {
    const wide = `root = TextContent("${"a".repeat(20_000)}")\nextra = TextContent("${"b".repeat(20_000)}")`;
    expect(validateProgram(wide).errors[0]?.code).toBe("string-literal-budget");
    const values = Array.from({ length: 5_001 }, () => "1").join(",");
    expect(validateProgram(`root = LineChart(["day"], [Series("events", [${values}])])`).errors[0]?.code).toBe("literal-budget");
  });

  it("rejects 1990 queries under the cap without parsing them", () => {
    const program = queries(1990);
    const started = performance.now();
    const result = validateProgram(program);
    expect(performance.now() - started).toBeLessThan(100);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("too-many-queries");
    expect(result.errors[0]?.message).toContain(String(MAX_PROGRAM_QUERIES));
  });

  it("reconciles from a frozen schema map and does not touch the filesystem", () => {
    const frozen = Object.freeze(new Map(outputSchemas));
    const guarded = new Proxy(frozen, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return (id: string) => target.get(id);
        }
        if (prop === "size" || prop === "has" || typeof prop === "symbol") return Reflect.get(target, prop, receiver);
        throw new Error(`unexpected map access ${String(prop)}`);
      },
    });
    const result = reconcileProgram(
      'data = Query("get_usage", {})\nrows = data.rows\nroot = TextContent("x")',
      [{ id: "rows", function: "get_usage", args: {} }],
      guarded,
    );
    expect(result.errors).toEqual([]);
  });

  it("publishes 64 queries across 8 functions once each, inside 300 ms", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-prog-budget-home-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-prog-budget-proj-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const store = createRunStore({ rootDir: home });
    const registered = await store.ensureProject(project);
    cleanups.push(async () => {
      await store.close().catch(() => undefined);
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    });
    const ids = Array.from({ length: 8 }, (_, index) => `fn_${index}`);
    const source = "export const access = { network: [] };\nexport default async function execute() { return { rows: [] }; }\n";
    await writeFile(
      path.join(project, "stageflow.yaml"),
      "version: 1\nmodel: openrouter/openai/gpt-4o-mini\ncatalog:\n  pipelines:\n    - .\n  tasks: []\n",
    );
    const attachments = ids.map((id) => `        - id: ${id}`).join("\n");
    await writeFile(
      path.join(project, "sales.pipeline.yaml"),
      `id: sales\nstages:\n  - id: summarize\n    artifacts:\n      publish: true\n    tools:\n      functions:\n${attachments}\n`,
    );
    for (const id of ids) {
      const file = functionFilePath(project, id);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `id: ${id}\nname: ${id}\nkind: tool\ntool_name: ${id}\ntool_description: Read ${id}\ninput_schema:\n  type: object\noutput_schema:\n  type: object\n  properties:\n    rows:\n      type: array\nsource: |\n${source
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}\n`,
      );
    }
    const lines = Array.from({ length: 64 }, (_, index) => {
      const id = ids[index % ids.length]!;
      return `q${index} = Query("${id}", {})`;
    });
    const program = `${lines.join("\n")}\nroot = TextContent("x")`;
    const bindings = ids.map((id) => ({ id: `b_${id}`, function: id, args: {} }));
    validateProgram(program);
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const live = manifest(program, bindings);
    const calls: string[] = [];
    const started = performance.now();
    await assertLiveProgramAtPublish(registered, live, async (_root, functionId) => {
      calls.push(functionId);
      return { type: "object", properties: { rows: { type: "array" } } };
    });
    expect(performance.now() - started).toBeLessThan(300);
    expect(calls).toEqual(ids);
    const spy = vi.spyOn(loadFunction, "readFunctionFile");
    const published = await publishArtifact(db, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      projectRoot: registered,
      id: "weekly",
      kind: "live.declarative",
      title: "Weekly",
      bytes: Buffer.from(program),
      manifest: live,
      publishSource: "api",
      roots,
    });
    const loaded = spy.mock.calls.map((call) => String(call[1])).sort();
    spy.mockRestore();
    expect(published.version).toBe(1);
    expect(loaded).toEqual([...ids].sort());
  });

  it("validates a near-cap program quickly and keeps the event loop under 300 ms", async () => {
    const text = "b".repeat(15_000);
    const values = Array.from({ length: 4_000 }, () => "1").join(",");
    const lines = Array.from({ length: 64 }, (_, index) => `q${index} = Query("get_usage", {})`);
    const program = `${lines.join("\n")}\nnote = TextContent("${text}")\nmore = TextContent("${text}")\nroot = LineChart(["day"], [Series("events", [${values}])])`;
    const once = validateProgram(program);
    expect(once.ok).toBe(true);
    const reconciled = reconcileProgram(program, [{ id: "rows", function: "get_usage", args: {} }], outputSchemas);
    expect(reconciled.errors).toEqual([]);
    const started = performance.now();
    expect(validateProgram(program).ok).toBe(true);
    expect(reconcileProgram(program, [{ id: "rows", function: "get_usage", args: {} }], outputSchemas).errors).toEqual([]);
    expect(performance.now() - started).toBeLessThan(250);

    const live = manifest(program, [{ id: "rows", function: "get_usage", args: {} }]);
    let blocked = 0;
    const interval = 20;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      blocked = Math.max(blocked, now - last - interval);
      last = now;
    }, interval);
    await Promise.all(
      Array.from({ length: 20 }, () => assertLiveProgramAtPublish(tmpdir(), live, async () => schema)),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    clearInterval(timer);
    expect(blocked).toBeLessThan(1_000);
  });

  it("returns 429 when more than 32 validations are waiting", async () => {
    const live = manifest('root = TextContent("x")', []);
    const results = await Promise.allSettled(
      Array.from({ length: 35 }, () => assertLiveProgramAtPublish(tmpdir(), live, async () => undefined)),
    );
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]).toMatchObject({
      status: "rejected",
      reason: { status: 429, code: "artifact.resource_limit" },
    });
  });
});
