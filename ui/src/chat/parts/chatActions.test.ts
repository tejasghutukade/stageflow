import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "../../api/artifacts";
import { artifactDetailMeta } from "../../redesign/artifacts/artifactDetailModel";
import { ArtifactViewContent } from "../../redesign/artifacts/ArtifactView";
import { previewFromContent } from "../../redesign/artifacts/renderers/previewModel";
import { liveQueryFromChat, postChatAction, resetChatActionsForTests } from "./chatActions";

function record(): ArtifactRecord {
  return {
    key: "agent:helper/weekly",
    id: "weekly",
    title: "Weekly",
    description: null,
    tags: [],
    kind: "static.markdown",
    origin: "indexed",
    owner: { kind: "agent", agent: "helper" },
    source: { run_id: null, stage_id: null, attempt: null, session_id: null },
    version: 1,
    size_bytes: 5,
    content_type: "text/markdown",
    created_at: "2026-11-24T12:00:00.000Z",
    updated_at: "2026-11-24T13:00:00.000Z",
    expires_at: null,
    status: "available",
    expired_at: null,
    expired_reason: null,
    project: { id: "workspace", registered: true },
  };
}

vi.mock("../../api/agents", () => ({
  AgentApiError: class AgentApiError extends Error {
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.status = status;
    }
  },
  agentsApi: {
    uiEvent: vi.fn(async (_agent: string, _session: string, body: { id: string; kind: string; action: string; args?: unknown }) => ({
      id: body.id,
      kind: body.kind,
      action: body.action,
      args: body.args,
      binding_id: body.action,
      snapshot: { value: { weeks: 4 }, status: "ok" },
      errors: [],
    })),
  },
}));

import { agentsApi } from "../../api/agents";

afterEach(() => {
  resetChatActionsForTests();
  vi.mocked(agentsApi.uiEvent).mockClear();
});

describe("chat action bridge", () => {
  it("sends a select change through the binding query event", async () => {
    const query = liveQueryFromChat({ agentId: "helper", sessionId: "ses" }, "agent:helper/weekly", 3);
    const [first, second] = await Promise.all([
      query({ bindingId: "rows", args: { weeks: 4 } }),
      query({ bindingId: "rows", args: { weeks: 4 } }),
    ]);
    expect(agentsApi.uiEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentsApi.uiEvent).mock.calls[0]?.[2]).toMatchObject({
      key: "agent:helper/weekly",
      version: 3,
      kind: "query",
      action: "rows",
      args: { weeks: 4 },
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("keeps a second click on the same action on the first event", async () => {
    let release: () => void = () => undefined;
    vi.mocked(agentsApi.uiEvent).mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({ id: "held", kind: "tool" });
      }),
    );
    const target = { agentId: "helper", sessionId: "ses" };
    const first = postChatAction(target, { key: "agent:helper/weekly", kind: "tool", action: "archive" });
    const second = postChatAction(target, { key: "agent:helper/weekly", kind: "tool", action: "archive" });
    expect(agentsApi.uiEvent).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(agentsApi.uiEvent).toHaveBeenCalledTimes(1);
  });

  it("renders declared actions on the inline artifact", () => {
    const row = record();
    const preview = previewFromContent({ record: row, text: "hello", binary: false });
    const meta = artifactDetailMeta(row);
    const actions = [{ id: "archive", type: "tool" as const, label: "Archive the weekly report", template: "Archive the weekly report", tool: "web.fetch" }];
    const html = renderToStaticMarkup(
      createElement(ArtifactViewContent, {
        density: "inline",
        meta,
        preview,
        actions,
        onAction: () => undefined,
      }),
    );
    expect(html).toContain("Archive the weekly report");
    const page = renderToStaticMarkup(
      createElement(ArtifactViewContent, {
        density: "page",
        meta,
        preview,
        actions,
        onAction: () => undefined,
      }),
    );
    expect(page).not.toContain("Archive the weekly report");
  });
});
