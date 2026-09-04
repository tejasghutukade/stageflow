import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";

async function writePipeline(source: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-completion-contract-"));
  await writeFile(
    path.join(dir, "implement.yaml"),
    [
      "id: implement",
      "system_prompt: Implement the requested change.",
      "model: test/model",
      "gate_kinds:",
      "  - confirm",
      "payload_schema:",
      "  type: object",
      "  properties:",
      "    changed_files:",
      "      type: array",
      "      items:",
      "        type: string",
      "  required: [changed_files]",
      "",
    ].join("\n"),
  );
  const pipelinePath = path.join(dir, "verified.pipeline.yaml");
  await writeFile(pipelinePath, source);
  return pipelinePath;
}

describe("pipeline completion contracts", () => {
  it("loads a pipeline-owned completion and recovery policy into the frozen DAG", async () => {
    const pipelinePath = await writePipeline([
      "id: verified",
      "stages:",
      "  - id: implement",
      "    uses: ./implement.yaml",
      "    completion:",
      "      mode: all",
      "      checks:",
      "        - id: unit-tests",
      "          type: command",
      "          run: npm test",
      "          timeout_ms: 600000",
      "        - id: report",
      "          type: artifact",
      "          path: implementation-report.md",
      "          nonempty: true",
      "        - id: self-review",
      "          type: checklist",
      "          items:",
      "            - Implementation matches the approved plan",
      "            - Unrelated files were not changed",
      "        - id: output",
      "          type: payload_schema",
      "        - id: approval",
      "          type: gate",
      "          kind: confirm",
      "        - id: changed-files",
      "          type: checkout_changes",
      "          path_fields: [changed_files]",
      "    recovery:",
      "      mode: repair",
      "      max_attempts: 3",
      "      retry_safety: idempotent",
      "      include_failed_checks: true",
      "",
    ].join("\n"));

    const loaded = await loadPipeline(pipelinePath);
    const node = loaded.dag.nodes[0];
    expect(node?.completion).toEqual({
      mode: "all",
      checks: [
        { id: "unit-tests", type: "command", run: "npm test", timeout_ms: 600000 },
        { id: "report", type: "artifact", path: "implementation-report.md", nonempty: true },
        {
          id: "self-review",
          type: "checklist",
          items: [
            "Implementation matches the approved plan",
            "Unrelated files were not changed",
          ],
        },
        { id: "output", type: "payload_schema" },
        { id: "approval", type: "gate", kind: "confirm" },
        { id: "changed-files", type: "checkout_changes", path_fields: ["changed_files"] },
      ],
    });
    expect(node?.recovery).toEqual({
      mode: "repair",
      max_attempts: 3,
      retry_safety: "idempotent",
      include_failed_checks: true,
    });
    expect(buildPipelineDagSnapshotFromLoaded(loaded).nodes[0]).toMatchObject({
      completion: node?.completion,
      recovery: node?.recovery,
    });
  });

  it("rejects malformed completion checks before a stage runs", async () => {
    const pipelinePath = await writePipeline([
      "id: invalid-completion",
      "stages:",
      "  - id: implement",
      "    uses: ./implement.yaml",
      "    completion:",
      "      checks:",
      "        - id: unit-tests",
      "          type: command",
      "",
    ].join("\n"));

    await expect(loadPipeline(pipelinePath)).rejects.toThrow(
      /command check requires a non-empty run/,
    );
  });

  it("rejects an empty checklist", async () => {
    const pipelinePath = await writePipeline([
      "id: invalid-checklist",
      "stages:",
      "  - id: implement",
      "    uses: ./implement.yaml",
      "    completion:",
      "      checks:",
      "        - id: self-review",
      "          type: checklist",
      "          items: []",
      "",
    ].join("\n"));

    await expect(loadPipeline(pipelinePath)).rejects.toThrow(
      /checklist requires a non-empty items array of strings/,
    );
  });

  it("requires an explicit idempotent policy for automatic repair", async () => {
    const pipelinePath = await writePipeline([
      "id: unsafe-repair",
      "stages:",
      "  - id: implement",
      "    uses: ./implement.yaml",
      "    completion:",
      "      checks:",
      "        - id: output",
      "          type: payload_schema",
      "    recovery:",
      "      mode: repair",
      "      max_attempts: 2",
      "      retry_safety: side_effecting",
      "",
    ].join("\n"));

    await expect(loadPipeline(pipelinePath)).rejects.toThrow(
      /automatic repair requires retry_safety: idempotent/,
    );
  });

  it("requires supporting stage declarations for payload, gate, and checkout checks", async () => {
    const pipelinePath = await writePipeline([
      "id: incompatible-contract",
      "stages:",
      "  - id: implement",
      "    uses: ./implement.yaml",
      "    completion:",
      "      checks:",
      "        - id: approval",
      "          type: gate",
      "          kind: free_text",
      "",
    ].join("\n"));

    await expect(loadPipeline(pipelinePath)).rejects.toThrow(
      /requires gate_kinds to include "free_text"/,
    );
  });

  it("rejects checkout path fields that are not required string arrays", async () => {
    const pipelinePath = await writePipeline([
      "id: incompatible-checkout",
      "stages:",
      "  - id: implement",
      "    uses: ./implement.yaml",
      "    completion:",
      "      checks:",
      "        - id: changed-files",
      "          type: checkout_changes",
      "          path_fields: [missing]",
      "",
    ].join("\n"));

    await expect(loadPipeline(pipelinePath)).rejects.toThrow(
      /path field "missing" must be a required array of strings/,
    );
  });
});
