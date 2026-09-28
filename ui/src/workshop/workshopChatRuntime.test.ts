import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  isProposalToolInteractive,
  WORKSHOP_PROPOSAL_TOOL_NAME,
  type ChatMessage,
  type ProposalArtifactDiff,
} from "./draft";
import { WorkshopProposalCard } from "./WorkshopProposalCard";
import {
  convertChatMessage,
  extractAppendText,
} from "./workshopChatRuntime";

const sampleArtifacts: ProposalArtifactDiff[] = [
  {
    path: "demo.pipeline.yaml",
    kind: "modified",
    before: "stages: []",
    after: "stages: [{ id: fetch }]",
  },
];

describe("workshopChatRuntime proposal tool-call", () => {
  it("maps ChatMessage roles and text into ThreadMessageLike", () => {
    const messages: ChatMessage[] = [
      { id: "a1", role: "assistant", text: "Hello **world**" },
      { id: "u1", role: "user", text: "add a stage" },
      { id: "s1", role: "system", text: "Accepted: stage foo" },
    ];
    expect(messages.map((m) => convertChatMessage(m))).toEqual([
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "Hello **world**" }],
      },
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "add a stage" }],
      },
      {
        id: "s1",
        role: "system",
        content: [{ type: "text", text: "Accepted: stage foo" }],
      },
    ]);
  });

  it("emits a workshop_proposal tool-call when proposalId is set", () => {
    const message: ChatMessage = {
      id: "p1",
      role: "assistant",
      text: "I propose: add fetch stage.",
      artifacts: sampleArtifacts,
      proposalId: "prop-1",
      proposalSummary: "add fetch stage",
    };

    expect(convertChatMessage(message, { pendingId: "prop-1" })).toEqual({
      id: "p1",
      role: "assistant",
      content: [
        { type: "text", text: "I propose: add fetch stage." },
        {
          type: "tool-call",
          toolCallId: "prop-1",
          toolName: WORKSHOP_PROPOSAL_TOOL_NAME,
          args: {
            proposalId: "prop-1",
            summary: "add fetch stage",
            artifacts: sampleArtifacts,
          },
        },
      ],
    });
  });

  it("marks the tool-call settled when pendingId no longer matches", () => {
    const message: ChatMessage = {
      id: "p1",
      role: "assistant",
      text: "I propose: add fetch stage.",
      artifacts: sampleArtifacts,
      proposalId: "prop-1",
      proposalSummary: "add fetch stage",
    };

    const converted = convertChatMessage(message, { pendingId: null });
    const toolPart = (
      converted.content as readonly { type: string; result?: unknown }[]
    ).find((p) => p.type === "tool-call");
    expect(toolPart).toMatchObject({
      type: "tool-call",
      toolName: WORKSHOP_PROPOSAL_TOOL_NAME,
      result: { status: "settled" },
    });
  });

  it("does not emit a tool-call for auto-applied messages (artifacts only)", () => {
    const message: ChatMessage = {
      id: "a1",
      role: "assistant",
      text: "Applied to draft: add fetch stage.",
      artifacts: sampleArtifacts,
    };
    expect(convertChatMessage(message)).toEqual({
      id: "a1",
      role: "assistant",
      content: [
        { type: "text", text: "Applied to draft: add fetch stage." },
      ],
    });
  });

  it("extracts trimmed text from AppendMessage for onNew → parent send", () => {
    expect(
      extractAppendText({
        content: [{ type: "text", text: "  propose a stage  " }],
      }),
    ).toBe("propose a stage");
    expect(
      extractAppendText({ content: [{ type: "text", text: "   " }] }),
    ).toBeNull();
    expect(extractAppendText({ content: [] })).toBeNull();
  });
});

describe("WorkshopProposalCard Accept/Reject", () => {
  it("renders interactive Accept/Reject when pending matches", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    expect(isProposalToolInteractive("prop-1", "prop-1")).toBe(true);

    const html = renderToStaticMarkup(
      createElement(WorkshopProposalCard, {
        summary: "add fetch stage",
        artifacts: sampleArtifacts,
        interactive: true,
        onAccept,
        onReject,
      }),
    );

    expect(html).toContain("Pending proposal");
    expect(html).toContain("add fetch stage");
    expect(html).toContain("Accept");
    expect(html).toContain("Reject");
    expect(html).toContain("demo.pipeline.yaml");
  });

  it("hides Accept/Reject once settled (fake host cleared pending)", () => {
    expect(isProposalToolInteractive(null, "prop-1")).toBe(false);

    const html = renderToStaticMarkup(
      createElement(WorkshopProposalCard, {
        summary: "add fetch stage",
        artifacts: sampleArtifacts,
        interactive: false,
        onAccept: () => {},
        onReject: () => {},
      }),
    );

    expect(html).toContain('aria-label="Proposal"');
    expect(html).not.toContain("Pending proposal");
    expect(html).not.toContain(">Accept</button>");
    expect(html).not.toContain(">Reject</button>");
    expect(html).toContain("demo.pipeline.yaml");
  });
});
