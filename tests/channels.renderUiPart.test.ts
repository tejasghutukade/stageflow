import { describe, expect, it } from "vitest";
import {
  assistantMessageTextForChannel,
  renderUiPartForChannel,
  webChatVisitorAssistantText,
  webChatVisitorParts,
} from "../src/channels/renderUiPart.js";
import { CHANNEL_PROVIDER_UI_CAPABILITY, WEB_CHAT_UI_CAPABILITY } from "../src/channels/uiCapability.js";
import { channelProviders } from "../src/channels/providers.js";
import {
  UI_PART_KIND_APPROVAL,
  UI_PART_KIND_ARTIFACT_REF,
  UI_PART_KIND_CARD,
  UI_PART_KIND_FORM,
  UI_PART_SCHEMA_VERSION,
} from "../src/artifacts/uiPart.js";

const part = {
  v: UI_PART_SCHEMA_VERSION,
  kind: UI_PART_KIND_ARTIFACT_REF,
  key: "agent:helper/weekly",
  title: "Weekly report",
  fallback: { text: "Weekly report", url: "http://127.0.0.1:3847/#/artifacts/agent%3Ahelper/weekly" },
};

describe("renderUiPartForChannel", () => {
  it("renders title and console URL for link capability", () => {
    expect(renderUiPartForChannel(part, "link")).toBe(`Weekly report\n${part.fallback.url}`);
  });

  it("omits the console URL when the reader has no console access", () => {
    expect(renderUiPartForChannel(part, "link", { consoleAccess: false })).toBe("Weekly report");
  });

  it("falls back to link without a snapshot for image capability", () => {
    expect(renderUiPartForChannel(part, "image")).toBe(`Weekly report\n${part.fallback.url}`);
    expect(renderUiPartForChannel(part, "image", { snapshotUrl: "https://cdn/snap.png" })).toContain("https://cdn/snap.png");
  });

  it("never serializes raw ui JSON in channel body text", () => {
    const body = assistantMessageTextForChannel({ text: "Here", parts: [part] }, "agentmail");
    expect(body).toContain("Weekly report");
    expect(body).toContain(part.fallback.url);
    expect(body).not.toContain('"type":"ui"');
    expect(body).not.toContain('"kind":"artifact-ref"');
  });

  it("summarizes ui for protected web-chat visitors", () => {
    const body = webChatVisitorAssistantText({ text: "Here", parts: [part] });
    expect(body).toBe("Here\n\nWeekly report");
    expect(body).not.toContain("http");
  });
});

const formPart = {
  v: UI_PART_SCHEMA_VERSION,
  kind: UI_PART_KIND_FORM,
  id: "contact",
  title: "Your details",
  fields: [{ id: "email", label: "Email", type: "string", required: true }],
  submit: { template: "Email: {{email}}" },
  fallback: { text: "Reply in the console", url: "http://127.0.0.1:3847/#/agents" },
};

const approvalPart = {
  v: UI_PART_SCHEMA_VERSION,
  kind: UI_PART_KIND_APPROVAL,
  approvalId: "ap1",
  title: "Approve fetch",
  tool: "web.fetch",
  summary: "Download the weekly CSV.",
  fallback: { text: "Decide in the console", url: "http://127.0.0.1:3847/#/agents" },
};

describe("form and approval channel fallbacks", () => {
  it("summarizes a form for link providers", () => {
    const body = assistantMessageTextForChannel({ text: "Please fill in", parts: [formPart] }, "slack");
    expect(body).toContain("Your details");
    expect(body).toContain("Email");
    expect(body).not.toContain('"kind":"form"');
  });

  it("summarizes an approval card for visitors without console access", () => {
    expect(renderUiPartForChannel(approvalPart, "link", { consoleAccess: false })).toContain("Download the weekly CSV");
    expect(renderUiPartForChannel(approvalPart, "link", { consoleAccess: false })).not.toContain("http");
  });
});

describe("provider ui capabilities", () => {
  it("declares ui on every built-in provider meta", () => {
    for (const provider of channelProviders().filter((entry) => entry.id !== "fake")) {
      expect(provider.meta.ui).toBe(CHANNEL_PROVIDER_UI_CAPABILITY[provider.id as keyof typeof CHANNEL_PROVIDER_UI_CAPABILITY]);
    }
  });

  it("documents web chat as interactive", () => {
    expect(WEB_CHAT_UI_CAPABILITY).toBe("interactive");
  });

  it("sends a card's fallback on channels and keeps the card itself for web chat visitors", () => {
    const card = {
      v: UI_PART_SCHEMA_VERSION,
      kind: UI_PART_KIND_CARD,
      title: "Notes",
      format: "static.markdown" as const,
      program: "# Notes",
      fallback: { text: "# Notes", url: "" },
    };
    expect(assistantMessageTextForChannel({ text: "Here", parts: [card] }, "telegram")).toBe("Here\n\n# Notes");
    expect(webChatVisitorAssistantText({ text: "Here", parts: [card, part] })).toBe("Here\n\nWeekly report");
    expect(webChatVisitorParts([card, part])).toEqual([card]);
  });
});
