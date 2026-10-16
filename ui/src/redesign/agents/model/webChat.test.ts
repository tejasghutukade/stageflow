import { describe, expect, it } from "vitest";
import {
  changedFields,
  changedSections,
  completeDefinition,
  defaultDefinition,
  DEFAULT_WEB_CHAT,
  newAgentDefinition,
  webChatLink,
  webChatState,
} from "./definition";

describe("web chat model", () => {
  it("is on for new agents and off in the schema defaults", () => {
    expect(newAgentDefinition().web_chat).toEqual({ enabled: true, rate_limit_per_minute: 10, max_message_chars: 4000 });
    expect(newAgentDefinition().web_chat.slug).toBeUndefined();
    expect(defaultDefinition().web_chat).toEqual({ enabled: false, rate_limit_per_minute: 10, max_message_chars: 4000 });
  });

  it("keeps web chat on when an author draft is completed", () => {
    expect(completeDefinition({ name: "A", web_chat: { rate_limit_per_minute: 30 } }).web_chat).toEqual({
      enabled: true,
      rate_limit_per_minute: 30,
      max_message_chars: 4000,
    });
    expect(completeDefinition({ name: "A" }).web_chat?.enabled).toBe(true);
  });

  it("builds the absolute link from the path, the Host origin or a public base URL", () => {
    expect(webChatLink({ webChatUrl: "/chat/k7x9" }, "http://127.0.0.1:3847")).toBe("http://127.0.0.1:3847/chat/k7x9");
    expect(webChatLink({ webChatUrl: "/chat/k7x9", publicBaseUrl: "https://chat.example.com/" }, "http://x")).toBe("https://chat.example.com/chat/k7x9");
    expect(webChatLink({ webChatUrl: "https://elsewhere.test/c/1" }, "http://x")).toBe("https://elsewhere.test/c/1");
    expect(webChatLink({ webChatUrl: null }, "http://x")).toBeNull();
    expect(webChatLink(null, "http://x")).toBeNull();
  });

  it("is live only when web chat is on and the agent is enabled", () => {
    const on = { ...defaultDefinition(), web_chat: { ...DEFAULT_WEB_CHAT, enabled: true } };
    expect(webChatState(true, on)).toBe("live");
    expect(webChatState(false, on)).toBe("waiting");
    expect(webChatState(true, defaultDefinition())).toBe("off");
    expect(webChatState(true, null)).toBe("off");
  });

  it("marks the web chat section changed, including a link rotation", () => {
    const saved = { ...defaultDefinition(), web_chat: { ...DEFAULT_WEB_CHAT, enabled: true, slug: "k7x9" } };
    expect(changedSections(saved, saved).has("webchat")).toBe(false);
    const rotated = { ...saved, web_chat: { ...DEFAULT_WEB_CHAT, enabled: true } };
    expect(changedSections(saved, rotated).has("webchat")).toBe(true);
    expect(changedFields(saved, rotated)).toEqual(["web chat"]);
    const limit = { ...saved, web_chat: { ...saved.web_chat, rate_limit_per_minute: 30 } };
    expect(changedFields(saved, limit)).toEqual(["web chat"]);
  });
});
