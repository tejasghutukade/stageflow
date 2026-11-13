import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperatorEvalGate } from "../src/operatorAgent/evalGate.js";

describe("operator eval gate: function tests", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("denies a real guide function test before the project is touched", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "sf-guide-eval-"));
    dirs.push(project);
    const marker = path.join(project, "tree-before-real-test.txt");
    await writeFile(marker, "untouched");
    const source = "export default function execute() { return { ok: true }; }\n";
    let turn = 0;
    const gate = createOperatorEvalGate({ policy: { tools: "read_only", mocks: {} }, turn: () => turn });
    const result = gate.decide("test_function", { id: "score", real: true, source });
    const record = gate.records()[0]!;
    expect(record).toMatchObject({ policyOutcome: "denied", status: "not_run" });
    expect(result).toMatchObject({ ok: false, error: "eval.tool_not_run" });
    expect(await readFile(marker, "utf8")).toBe("untouched");
  });
});
