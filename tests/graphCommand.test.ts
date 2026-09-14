import { describe, it, expect } from "vitest";
import { runGraphCommand } from "../src/cli/graphCommand.js";

describe("graphCommand", () => {
  it("should show help when no arguments provided", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    
    const exitCode = await runGraphCommand([], {
      io: {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
    });
    
    expect(exitCode).toBe(0);
    expect(errors.join("\n")).toContain("Usage:");
  });

  it("should show help with --help flag", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    
    const exitCode = await runGraphCommand(["--help"], {
      io: {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
    });
    
    expect(exitCode).toBe(0);
    expect(errors.join("\n")).toContain("Usage:");
  });

  it("should require --pipeline argument", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    
    const exitCode = await runGraphCommand(["--json"], {
      io: {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
    });
    
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--pipeline is required");
  });

  it("should generate graph visualization for valid pipeline", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    
    const exitCode = await runGraphCommand([
      "--pipeline", 
      "tests/fixtures/pipelines/graph-example.pipeline.yaml"
    ], {
      io: {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
    });
    
    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Pipeline Graph Visualization:");
    expect(output).toContain("[ENTRY] start"); // Entry stage marker
    expect(output).toContain("child~3"); // Clone chain
    expect(output).toContain("send_back to: process-item"); // Loop marker
    expect(errors).toHaveLength(0);
  });

  it("should generate JSON output with --json flag", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    
    const exitCode = await runGraphCommand([
      "--pipeline", 
      "tests/fixtures/pipelines/graph-example.pipeline.yaml",
      "--json"
    ], {
      io: {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
    });
    
    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain('"nodes":');
    expect(output).toContain('"id": "start"');
    expect(output).toContain('"id": "process-item"');
    expect(errors).toHaveLength(0);
  });

  it("should reject pipeline paths outside project root", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    
    const exitCode = await runGraphCommand([
      "--pipeline", 
      "/etc/passwd"
    ], {
      cwd: "/tmp",
      projectRoot: "/tmp",
      io: {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
    });
    
    expect(exitCode).toBe(1);
    const errorOutput = errors.join("\n");
    expect(errorOutput).toContain("Pipeline path must be within project root");
  });
});