import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { toolAnnotations, withToolDefaults } from "../src/mcp/defineTool.js";
import { recordMcpTools } from "../src/toolkit/record.js";

type Captured = { name: string; config: Record<string, unknown> };

function capture(): { server: McpServer; calls: Captured[] } {
  const calls: Captured[] = [];
  const recorder = {
    registerTool(name: string, config: Record<string, unknown>) {
      calls.push({ name, config });
    },
  };
  return { server: withToolDefaults(recorder as unknown as McpServer), calls };
}

function listedSchema(schema: unknown): Record<string, unknown> {
  const standard = (schema as { "~standard": { jsonSchema: { input: (p: { target: string }) => Record<string, unknown> } } })["~standard"];
  return standard.jsonSchema.input({ target: "draft-2020-12" });
}

describe("withToolDefaults", () => {
  it("labels a read tool as read-only, idempotent and closed-world", () => {
    expect(toolAnnotations("get_run")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it("labels a write tool as neither destructive nor open-world", () => {
    expect(toolAnnotations("start_run")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  });

  it("labels a destructive tool as destructive", () => {
    expect(toolAnnotations("delete_run")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("labels an external tool as open-world", () => {
    expect(toolAnnotations("test_connection")).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  it("attaches the annotations when a tool registers", () => {
    const { server, calls } = capture();
    server.registerTool("delete_run", { description: "Delete a run.", inputSchema: z.object({ runId: z.string() }) }, async () => ({ content: [] }));
    expect(calls[0]!.config.annotations).toEqual(toolAnnotations("delete_run"));
  });

  it("refuses a tool with no metadata", () => {
    const { server } = capture();
    expect(() => server.registerTool("not_a_tool", { description: "x" }, async () => ({ content: [] }))).toThrow(/not_a_tool/);
  });

  it("refuses a description that names a REST route", () => {
    const { server } = capture();
    expect(() =>
      server.registerTool("get_run", { description: "Poll a run (same as GET /api/runs/:id)." }, async () => ({ content: [] })),
    ).toThrow(/REST route/);
  });

  it("lists the input schema without $schema but keeps its shape and validation", async () => {
    const { server, calls } = capture();
    const schema = z.object({ runId: z.string() });
    server.registerTool("get_run", { description: "Poll a run.", inputSchema: schema }, async () => ({ content: [] }));
    const registered = calls[0]!.config.inputSchema as {
      "~standard": { validate: (v: unknown) => unknown; jsonSchema: { input: (p: { target: string }) => Record<string, unknown> } };
      safeParse: (v: unknown) => { success: boolean };
    };
    const listed = listedSchema(registered);
    expect(listed).not.toHaveProperty("$schema");
    expect(listed).toMatchObject({ type: "object", properties: { runId: { type: "string" } } });
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ runId: "r1" }).success).toBe(true);
    const reject = await registered["~standard"].validate({});
    const accept = await registered["~standard"].validate({ runId: "r1" });
    expect(reject).toMatchObject({ issues: expect.any(Array) });
    expect(accept).toEqual({ value: { runId: "r1" } });
  });

  it("wraps the same schema only once across repeated registrations", async () => {
    const { server, calls } = capture();
    const schema = z.object({ runId: z.string() });
    server.registerTool("get_run", { description: "Poll a run.", inputSchema: schema }, async () => ({ content: [] }));
    server.registerTool("get_run", { description: "Poll a run.", inputSchema: schema }, async () => ({ content: [] }));
    const first = calls[0]!.config.inputSchema as {
      "~standard": { validate: (v: unknown) => unknown; jsonSchema: { input: (p: { target: string }) => Record<string, unknown> } };
    };
    const second = calls[1]!.config.inputSchema as {
      "~standard": { validate: (v: unknown) => unknown; jsonSchema: { input: (p: { target: string }) => Record<string, unknown> } };
    };
    expect(second).toBe(first);
    expect(second["~standard"].jsonSchema.input).toBe(first["~standard"].jsonSchema.input);
    const listed = listedSchema(second);
    expect(listed).not.toHaveProperty("$schema");
    expect(listed).toMatchObject({ type: "object", properties: { runId: { type: "string" } } });
    const reject = await second["~standard"].validate({});
    const accept = await second["~standard"].validate({ runId: "r1" });
    expect(reject).toMatchObject({ issues: expect.any(Array) });
    expect(accept).toEqual({ value: { runId: "r1" } });
  });
});

describe("Host tool registrations", () => {
  const tools = recordMcpTools({ cwd: process.cwd(), store: {} as never, manager: {} as never });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  it("keeps the purpose sentence of a tool whose description used to name a route", () => {
    const description = byName.get("list_connections")!.description;
    expect(description.startsWith("List host connections.")).toBe(true);
    expect(description).not.toContain("/api/");
  });

  it("still rejects a start_run call that passes both task and task_path", () => {
    const schema = byName.get("start_run")!.inputSchema!;
    expect(schema.safeParse({ pipeline: "p.pipeline.yaml", task_path: "t.task.yaml", task: { id: "t", goal: "g" } }).success).toBe(false);
    expect(schema.safeParse({ pipeline: "p.pipeline.yaml", task_path: "t.task.yaml" }).success).toBe(true);
  });
});
