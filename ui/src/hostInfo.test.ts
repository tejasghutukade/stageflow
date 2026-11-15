import { afterEach, describe, expect, it } from "vitest";
import { webChatLink } from "./redesign/agents/model/definition";
import { chatOrigin, consoleOrigin, setHostInfoForTests, type HostInfo } from "./hostInfo";
import { defaultRedirectUri } from "./redesign/identity/identityView";

const none: HostInfo = { hosted: false, managed: false, publicUrl: null, publicChatUrl: null };

afterEach(() => setHostInfoForTests(null));

describe("host addresses", () => {
  it("falls back to the browser's address", () => {
    expect(consoleOrigin(none, "http://127.0.0.1:3847")).toBe("http://127.0.0.1:3847");
    expect(chatOrigin(none, "http://127.0.0.1:3847")).toBe("http://127.0.0.1:3847");
  });

  it("chat uses its own address, then the public address, then the browser's", () => {
    const base = { ...none, publicUrl: "https://acme.stage-flow.dev" };
    expect(chatOrigin(base, "http://x")).toBe("https://acme.stage-flow.dev");
    expect(chatOrigin({ ...base, publicChatUrl: "https://acme-public.stage-flow.dev" }, "http://x")).toBe("https://acme-public.stage-flow.dev");
    expect(consoleOrigin({ ...base, publicChatUrl: "https://acme-public.stage-flow.dev" }, "http://x")).toBe("https://acme.stage-flow.dev");
  });

  it("builds the shareable chat link and sign-in redirect from the chat address", () => {
    setHostInfoForTests({ hosted: true, managed: true, publicUrl: "https://acme.stage-flow.dev", publicChatUrl: "https://acme-public.stage-flow.dev" });
    expect(webChatLink({ webChatUrl: "/chat/helper" })).toBe("https://acme-public.stage-flow.dev/chat/helper");
    expect(defaultRedirectUri("https://acme-public.stage-flow.dev", "/chat/helper")).toBe(
      "https://acme-public.stage-flow.dev/api/public/chat/helper/oidc/callback",
    );
  });
});
