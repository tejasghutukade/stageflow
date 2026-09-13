import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  runGraphCommand,
  GRAPH_USAGE,
  parseGraphArgs,
  MISSING_PIPELINE_MESSAGE,
} from "../src/cli/graphCommand.js";
import { VALIDATION_CHECKS } from "../src/cli/validateOutput.js";
import { REPO_ROOT, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const FEATURE_LOOP_PIPELINE = path.join(
  REPO_ROOT,
  "examples",
  "feature-loop",
  "feature-loop.pipeline.yaml",
);

function runCli(args: string[], cwd = root) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("runGraphCommand", () => {
  it("prints the human diagram for the feature-loop fixture and exits 0", async () => {
    const logs: string[] = [];
    const code = await runGraphCommand(["--pipeline", FEATURE_LOOP_PIPELINE], {
      cwd: root,
      io: { log: (line) => logs.push(line), error: () => undefined },
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/ENTRY/);
    expect(logs.join("\n")).toMatch(/send_back/);
  });

  it("--json exits 0 with ResolvedPipelineDag shape", async () => {
    const logs: string[] = [];
    const code = await runGraphCommand(["--pipeline", FEATURE_LOOP_PIPELINE, "--json"], {
      cwd: root,
      io: { log: (line) => logs.push(line), error: () => undefined },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0]!) as {
      nodes: Array<{ id: string; entry?: boolean; feedback_loop?: { target: string; max_replays?: number } }>;
      roots: string[];
      childrenOf: Record<string, string[]>;
    };
    expect(Object.keys(parsed).sort()).toEqual(["childrenOf", "nodes", "roots"]);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        "decompose",
        "plan",
        "align",
        "implement",
        "verify",
        "review",
        "address-feedback",
        "publish",
      ]),
    );
    expect(parsed.roots).toEqual(["decompose"]);
    expect(Object.keys(parsed.childrenOf).sort()).toEqual(
      parsed.nodes.map((n) => n.id).sort(),
    );
    expect(parsed.childrenOf["decompose"]).toEqual(["plan"]);
    expect(parsed.childrenOf["address-feedback"]).toEqual(["publish"]);
    expect(parsed.childrenOf["address-feedback"]).not.toContain("review");
    expect(parsed.childrenOf["review"]).toEqual(
      expect.arrayContaining(["address-feedback"]),
    );
    const addressFeedback = parsed.nodes.find((n) => n.id === "address-feedback");
    expect(addressFeedback?.feedback_loop).toEqual(
      expect.objectContaining({ target: "review", max_replays: 2 }),
    );
    expect(parsed.nodes.find((n) => n.id === "decompose")?.entry).toBe(true);
  });

  it("parseGraphArgs([]) throws Missing required --pipeline <path> (no early return)", () => {
    expect(() => parseGraphArgs([])).toThrow(MISSING_PIPELINE_MESSAGE);
  });

  it("parseGraphArgs([--json]) throws the same Missing required message", () => {
    expect(() => parseGraphArgs(["--json"])).toThrow(MISSING_PIPELINE_MESSAGE);
  });

  it("bare graph (empty argv) exits 1 with Missing required --pipeline <path>", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand([], {
      cwd: root,
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors[0]).toBe(MISSING_PIPELINE_MESSAGE);
    expect(errors.join("\n")).not.toMatch(/TypeError|Cannot read properties|paths\[1\]/);
  });

  it("--json without --pipeline exits 1 with the same Missing required message", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand(["--json"], {
      cwd: root,
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors[0]).toBe(MISSING_PIPELINE_MESSAGE);
    expect(errors.join("\n")).not.toMatch(/TypeError|Cannot read properties|paths\[1\]/);
  });

  it("--pipeline pointing at a nonexistent file exits 1 without throwing", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand(["--pipeline", "/tmp/does-not-exist.pipeline.yaml"], {
      cwd: root,
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("--pipeline pointing at a broken pipeline exits 1 with findings surfaced", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand(["--pipeline", BROKEN_PIPELINE], {
      cwd: root,
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors.join("\n").length).toBeGreaterThan(0);
  });

  it("--pipeline pointing at a cyclic pipeline exits 1", async () => {
    expect(CYCLE_PIPELINE).toBe(path.join(root, "tests/fixtures/pipelines/cycle.pipeline.yaml"));
    const errors: string[] = [];
    const code = await runGraphCommand(["--pipeline", CYCLE_PIPELINE], {
      cwd: root,
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/dependency cycle detected/i);
    expect(errors.join("\n")).not.toMatch(/Missing value for --pipeline/);
  });

  it("--json on load/validation failure prints validate-shaped JSON to stdout", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runGraphCommand(["--pipeline", BROKEN_PIPELINE, "--json"], {
      cwd: root,
      io: { log: (line) => logs.push(line), error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors).toEqual([]);
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]!) as {
      ok: boolean;
      scope: string;
      checks: string;
      summary: { errors: number; warnings: number };
      findings: Array<{ severity: string; code: string; file: string; message: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.scope).toBe("pipeline");
    expect(parsed.checks).toBe(VALIDATION_CHECKS);
    expect(parsed.findings.length).toBeGreaterThan(0);
    expect(parsed.summary.errors).toBeGreaterThan(0);
    expect(parsed.findings.every((f) => typeof f.file === "string" && f.file.length > 0)).toBe(
      true,
    );
    expect(parsed.findings.some((f) => f.code === "pipeline.missing_stage")).toBe(true);
  });

  it("GRAPH_USAGE documents validate-shaped --json failure output", () => {
    expect(GRAPH_USAGE).toMatch(/validate-shaped JSON/i);
    expect(GRAPH_USAGE).toMatch(/sf validate --json/);
  });

  it("unknown flag exits 1 with an Unknown flag message", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand(["--pipeline", FEATURE_LOOP_PIPELINE, "--bogus"], {
      cwd: root,
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/Unknown flag/);
  });

  it("unexpected positional arg exits 1", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand(
      ["--pipeline", FEATURE_LOOP_PIPELINE, "extra-positional"],
      {
        cwd: root,
        io: { log: () => undefined, error: (line) => errors.push(line) },
      },
    );
    expect(code).toBe(1);
  });

  it("--help exits 0 and prints usage", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand(["--help"], {
      cwd: root,
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(0);
    expect(errors.join("\n")).toMatch(/sf graph/);
  });
});

describe("sf graph integration", { timeout: 30_000 }, () => {
  it("exits 0 and stdout shows entry, clone band, and send_back", () => {
    const result = runCli([
      "graph",
      "--pipeline",
      "examples/feature-loop/feature-loop.pipeline.yaml",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/ENTRY/);
    expect(result.stdout).toMatch(/up to 8/);
    expect(result.stdout).toMatch(/send_back/);
  });

  it("--json exits 0 with ResolvedPipelineDag shape on stdout", () => {
    const result = runCli([
      "graph",
      "--pipeline",
      "examples/feature-loop/feature-loop.pipeline.yaml",
      "--json",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      nodes: Array<{ id: string; entry?: boolean; feedback_loop?: { target: string; max_replays?: number } }>;
      roots: string[];
      childrenOf: Record<string, string[]>;
    };
    expect(Object.keys(parsed).sort()).toEqual(["childrenOf", "nodes", "roots"]);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        "decompose",
        "plan",
        "align",
        "implement",
        "verify",
        "review",
        "address-feedback",
        "publish",
      ]),
    );
    expect(parsed.roots).toEqual(["decompose"]);
    expect(Object.keys(parsed.childrenOf).sort()).toEqual(
      parsed.nodes.map((n) => n.id).sort(),
    );
    expect(parsed.childrenOf["decompose"]).toEqual(["plan"]);
    expect(parsed.childrenOf["address-feedback"]).toEqual(["publish"]);
    expect(parsed.childrenOf["address-feedback"]).not.toContain("review");
    expect(parsed.childrenOf["review"]).toEqual(
      expect.arrayContaining(["address-feedback"]),
    );
    const addressFeedback = parsed.nodes.find((n) => n.id === "address-feedback");
    expect(addressFeedback?.feedback_loop).toEqual(
      expect.objectContaining({ target: "review", max_replays: 2 }),
    );
    expect(parsed.nodes.find((n) => n.id === "decompose")?.entry).toBe(true);
  });

  it("bare sf graph exits 1 with Missing required --pipeline <path> on stderr", () => {
    const result = runCli(["graph"]);
    expect(result.status).toBe(1);
    expect(result.stderr.split("\n")[0]).toBe(MISSING_PIPELINE_MESSAGE);
    expect(result.stderr).not.toMatch(/TypeError|Cannot read properties|paths\[1\]/);
  });

  it("sf graph --json without --pipeline exits 1 with the same message", () => {
    const result = runCli(["graph", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr.split("\n")[0]).toBe(MISSING_PIPELINE_MESSAGE);
    expect(result.stderr).not.toMatch(/TypeError|Cannot read properties|paths\[1\]/);
  });

  it("--json on broken pipeline prints validate-shaped JSON to stdout only", () => {
    const result = runCli([
      "graph",
      "--pipeline",
      "tests/fixtures/pipelines/broken.pipeline.yaml",
      "--json",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      scope: string;
      checks: string;
      summary: { errors: number; warnings: number };
      findings: Array<{ severity: string; code: string; file: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.scope).toBe("pipeline");
    expect(parsed.checks).toBe(VALIDATION_CHECKS);
    expect(parsed.summary.errors).toBeGreaterThan(0);
    expect(parsed.findings.some((f) => f.code === "pipeline.missing_stage")).toBe(true);
  });

  it("cyclic pipeline exits 1 with dependency-cycle finding on stderr", () => {
    const result = runCli([
      "graph",
      "--pipeline",
      "tests/fixtures/pipelines/cycle.pipeline.yaml",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/dependency cycle detected/i);
    expect(result.stderr).not.toMatch(/Missing value for --pipeline/);
  });

  it("sf --help includes a sf graph usage line", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sf graph/);
  });

  it("sf graph --help exits 0 and prints usage", () => {
    const result = runCli(["graph", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/sf graph/);
  });
});
