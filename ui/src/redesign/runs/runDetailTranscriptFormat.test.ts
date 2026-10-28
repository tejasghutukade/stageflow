import { describe, expect, it } from "vitest";
import type { ToolCallView } from "./runDetailTranscriptModel";
import {
  formatToolCallDuration,
  presentToolResult,
  toolCallArgSummary,
  toolCallDurationMs,
  toolResultSummary,
} from "./runDetailTranscriptFormat";

describe("toolCallArgSummary", () => {
  it("extracts bash command from JSON args", () => {
    const call: ToolCallView = {
      name: "bash",
      status: "complete",
      args: '{"command":"npm test"}',
    };
    expect(toolCallArgSummary(call)).toBe("npm test");
  });

  it("shows basename for read file_path", () => {
    const call: ToolCallView = {
      name: "read",
      status: "complete",
      args: '{"file_path":"/repo/src/foo.ts"}',
    };
    expect(toolCallArgSummary(call)).toBe("foo.ts");
  });
});

describe("presentToolResult", () => {
  it("turns a pull request payload into a title, facts, and readable body", () => {
    const view = presentToolResult(
      JSON.stringify({
        number: 98,
        title: "Guide session deep-links",
        state: "open",
        html_url: "https://github.com/tejasghutukade/stageflow/pull/98",
        node_id: "PR_kwDO",
        user: { login: "tejasghutukade", avatar_url: "https://example.test/a" },
        body: "Add Guide chat.\n\n- Fix session boot",
      }),
    );
    expect(view).toMatchObject({
      kind: "card",
      headline: "PR #98 · Guide session deep-links",
      prose: "Add Guide chat.\n\n- Fix session boot",
    });
    if (view.kind !== "card") return;
    expect(view.fields.map((field) => field.label)).toEqual([
      "State",
      "Author",
      "Link",
    ]);
    expect(view.fields.find((field) => field.label === "Link")?.href).toBe(
      "https://github.com/tejasghutukade/stageflow/pull/98",
    );
    expect(toolResultSummary(JSON.stringify({ number: 98, title: "Guide session deep-links", html_url: "https://github.com/x", user: { login: "a" } }))).toContain("PR #98");
  });

  it("lists changed files instead of a raw JSON array", () => {
    const view = presentToolResult(
      JSON.stringify([
        { sha: "fc9a", filename: "docker-compose.yml", status: "modified", additions: 2, deletions: 1 },
        { sha: "abcd", filename: "README.md", status: "added", additions: 4, deletions: 0 },
      ]),
    );
    expect(view).toEqual({
      kind: "rows",
      headline: "2 files",
      rows: [
        { primary: "docker-compose.yml", secondary: "modified", stat: "+2 −1" },
        { primary: "README.md", secondary: "added", stat: "+4 −0" },
      ],
      more: 0,
    });
  });

  it("salvages a truncated pull request payload", () => {
    const view = presentToolResult(
      '{"number": 98, "title": "Guide session deep-links", "state": "open", "body": "Line one\\nLine two…',
    );
    expect(view.kind).toBe("card");
    if (view.kind !== "card") return;
    expect(view.headline).toBe("PR #98 · Guide session deep-links");
    expect(view.prose).toContain("Line one\nLine two");
  });
});

describe("toolCallDurationMs", () => {
  it("computes elapsed time for completed tools", () => {
    const call: ToolCallView = {
      name: "bash",
      status: "complete",
      startedAt: "2020-01-01T00:00:00.000Z",
      at: "2020-01-01T00:00:05.000Z",
    };
    expect(toolCallDurationMs(call, Date.now())).toBe(5000);
    expect(formatToolCallDuration(call, Date.now())).toBe("5s");
  });
});
