import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createToolOutputBudgetExtension,
  type ToolOutputSpillEvent,
} from "../src/agent/toolOutputBudgetExtension.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

type Usage = { tokens: number | null; contextWindow: number } | undefined;

async function harness(options: { usage?: Usage; exempt?: string[] } = {}) {
  const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-tool-output-"));
  const handlers = new Map<string, Handler[]>();
  const spills: ToolOutputSpillEvent[] = [];
  let usage: Usage =
    "usage" in options ? options.usage : { tokens: 10_000, contextWindow: 200_000 };
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  await createToolOutputBudgetExtension({
    runWorkspaceDir,
    stageId: "enrich",
    attempt: 1,
    exempt: new Set(options.exempt ?? ["read"]),
    onSpill: (event) => spills.push(event),
  })(api);
  const ctx = { getContextUsage: () => usage };
  return {
    runWorkspaceDir,
    spills,
    setUsage(next: Usage) {
      usage = next;
    },
    async toolResult(event: Record<string, unknown>) {
      const [handler] = handlers.get("tool_result") ?? [];
      return handler!(
        {
          type: "tool_result",
          toolCallId: "call_1",
          toolName: "exa_web_fetch_exa",
          input: {},
          isError: false,
          details: { server: "exa" },
          ...event,
        },
        ctx,
      ) as Promise<
        | {
            content: Array<{ type: string; text?: string }>;
            details: Record<string, unknown>;
            structuredContent?: unknown;
          }
        | undefined
      >;
    },
    async assistantMessageEnd() {
      for (const handler of handlers.get("message_end") ?? []) {
        await handler({ type: "message_end", message: { role: "assistant" } }, ctx);
      }
    },
  };
}

function exaBody(bytes: number): string {
  return JSON.stringify({ results: [{ url: "https://example.com", text: "x".repeat(bytes) }] });
}

describe("tool output budget extension", () => {
  it("leaves results that fit untouched", async () => {
    const h = await harness();
    expect(await h.toolResult({ content: [{ type: "text", text: "small" }] })).toBeUndefined();
    expect(h.spills).toEqual([]);
  });

  it("spills an oversized MCP result to a stage artifact and returns a notice and preview", async () => {
    const h = await harness({ usage: { tokens: 130_000, contextWindow: 200_000 } });
    const body = exaBody(140_000);

    const result = await h.toolResult({
      content: [{ type: "text", text: body }],
      structuredContent: { results: [] },
    });

    const relative =
      "stages/enrich/attempts/1/artifacts/tool-output/call_1-exa_web_fetch_exa.json";
    const absolute = path.join(h.runWorkspaceDir, relative);
    expect(JSON.parse(await readFile(absolute, "utf8"))).toEqual(JSON.parse(body));

    const text = result!.content[0]!.text!;
    expect(text).toContain(`[Tool output saved as stage artifact: ${relative}`);
    expect(text).toContain(`Read path: ${absolute}`);
    expect(text).toContain("Do not copy it.");
    expect(text).toContain("page them with bash (jq, cut -c)");
    expect(text).toContain("Shape: JSON object { results: array(1) }");
    expect(text).not.toContain(tmpdir() + path.sep + "pi-");
    expect(Buffer.byteLength(text)).toBeLessThan(4_096);
    expect(result).not.toHaveProperty("structuredContent");
    expect(result!.details).toEqual({
      server: "exa",
      stageflowToolOutput: expect.objectContaining({
        spilled: true,
        path: relative,
        originalBytes: Buffer.byteLength(body),
        reason: "exceeds_remaining",
      }),
    });
    expect(h.spills).toEqual([
      expect.objectContaining({ toolName: "exa_web_fetch_exa", runRelativePath: relative }),
    ]);
  });

  it("keeps image blocks alongside the notice", async () => {
    const h = await harness({ usage: undefined });
    const image = { type: "image", data: "aGk=", mimeType: "image/png" };
    const result = await h.toolResult({
      content: [{ type: "text", text: "y".repeat(60_000) }, image],
    });
    expect(result!.content).toHaveLength(2);
    expect(result!.content[1]).toEqual(image);
  });

  it("skips exempt tools and nested calls", async () => {
    const h = await harness({ usage: { tokens: 190_000, contextWindow: 200_000 } });
    const big = [{ type: "text", text: "z".repeat(100_000) }];
    expect(await h.toolResult({ toolName: "read", content: big })).toBeUndefined();
    expect(
      await h.toolResult({ parentToolCallId: "outer", content: big }),
    ).toBeUndefined();
  });

  it("spills a later parallel result once earlier ones fill the turn", async () => {
    const h = await harness({ usage: { tokens: 60_000, contextWindow: 200_000 } });
    // remaining = 200k − 60k − 50k = 90k tokens; each 150 KB result ≈ 50k tokens.
    const first = await h.toolResult({
      toolCallId: "a",
      content: [{ type: "text", text: "a".repeat(150_000) }],
    });
    const second = await h.toolResult({
      toolCallId: "b",
      content: [{ type: "text", text: "b".repeat(150_000) }],
    });
    expect(first).toBeUndefined();
    expect(second!.details.stageflowToolOutput).toMatchObject({ reason: "exceeds_remaining" });

    await h.assistantMessageEnd();
    const third = await h.toolResult({
      toolCallId: "c",
      content: [{ type: "text", text: "c".repeat(150_000) }],
    });
    expect(third).toBeUndefined();
  });

  it("falls back to a truncated inline result when the artifact write fails", async () => {
    const runWorkspaceDir = await mkdtemp(path.join(tmpdir(), "sf-tool-output-"));
    let handler: Handler | undefined;
    const api = {
      on(event: string, next: Handler) {
        if (event === "tool_result") handler = next;
      },
    } as unknown as ExtensionAPI;
    await createToolOutputBudgetExtension({
      runWorkspaceDir,
      stageId: "../bad",
      attempt: 1,
      exempt: new Set(),
    })(api);

    const result = (await handler!(
      {
        type: "tool_result",
        toolCallId: "c",
        toolName: "fetch",
        input: {},
        isError: false,
        details: undefined,
        content: [{ type: "text", text: "q".repeat(70_000) }],
      },
      { getContextUsage: () => undefined },
    )) as { content: Array<{ text: string }>; details: Record<string, unknown> };

    const text = result.content[0]!.text;
    expect(text).toContain("[Tool output truncated: original 70000 bytes.");
    expect(Buffer.byteLength(text)).toBeLessThan(51_500);
    expect(result.details.stageflowToolOutput).toMatchObject({ spilled: false });
  });
});
