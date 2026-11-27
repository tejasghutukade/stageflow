import { afterEach, describe, expect, it } from "vitest";
import { webChatLink } from "./redesign/agents/model/definition";
import { chatOrigin, chooseSandboxOrigin, consoleOrigin, parseSandboxOrigin, setHostInfoForTests, type HostInfo } from "./hostInfo";
import { defaultRedirectUri } from "./redesign/identity/identityView";

const none: HostInfo = { hosted: false, managed: false, publicUrl: null, publicChatUrl: null };

afterEach(() => setHostInfoForTests(null));

describe("sandbox origin", () => {
  it("keeps a string and treats null, absent, and non-strings as off", () => {
    expect(parseSandboxOrigin("http://localhost:5999")).toBe("http://localhost:5999");
    expect(parseSandboxOrigin(null)).toBeNull();
    expect(parseSandboxOrigin(undefined)).toBeNull();
    expect(parseSandboxOrigin(5999)).toBeNull();
    expect(parseSandboxOrigin({ origin: "http://localhost:5999" })).toBeNull();
    expect(parseSandboxOrigin("")).toBeNull();
    expect(parseSandboxOrigin("http://localhost:5999 extra")).toBeNull();
  });
});

describe("chooseSandboxOrigin", () => {
  const both = ["http://localhost:4400", "http://127.0.0.1:4400"];

  it("picks the loopback name that is not the page hostname", () => {
    expect(chooseSandboxOrigin("http://localhost:4400", both, "localhost")).toBe("http://127.0.0.1:4400");
    expect(chooseSandboxOrigin("http://127.0.0.1:4400", both, "127.0.0.1")).toBe("http://localhost:4400");
    expect(chooseSandboxOrigin("http://127.0.0.1:4400", both, "LOCALHOST")).toBe("http://127.0.0.1:4400");
    expect(chooseSandboxOrigin("http://localhost:4400", ["http://127.0.0.1:4400", "http://localhost:4400"], "example.com")).toBeNull();
    expect(
      chooseSandboxOrigin(null, ["https://sandbox.example.com", "http://127.0.0.1:4400"], "chat.example.com"),
    ).toBe("https://sandbox.example.com");
  });

  it("falls back when the list is empty or every valid entry matches the page", () => {
    expect(chooseSandboxOrigin("http://127.0.0.1:4400", [], "localhost")).toBe("http://127.0.0.1:4400");
    expect(chooseSandboxOrigin("http://localhost:4400", undefined, "localhost")).toBe("http://localhost:4400");
    expect(chooseSandboxOrigin("http://localhost:4400", ["http://localhost:4400"], "localhost")).toBe("http://localhost:4400");
    expect(chooseSandboxOrigin(null, [], "localhost")).toBeNull();
    expect(chooseSandboxOrigin(undefined, null, "example.com")).toBeNull();
  });

  it("returns null for an IPv6 page hostname", () => {
    expect(chooseSandboxOrigin("http://127.0.0.1:4400", both, "::1")).toBeNull();
    expect(chooseSandboxOrigin("http://127.0.0.1:4400", both, "[::1]")).toBeNull();
    expect(chooseSandboxOrigin("http://localhost:4400", both, "fe80::1")).toBeNull();
  });

  it("ignores malformed and hostile entries", () => {
    const hostile = [
      "javascript:alert(1)",
      "https://127.0.0.1:4400",
      "http://user:pass@127.0.0.1:4400",
      "http://127.0.0.1:4400/path",
      "http://127.0.0.1:4400?x=1",
      "http://127.0.0.1:4400#frag",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://evil.example:4400",
      "http://[::1]:4400",
      "",
      4400,
      null,
    ];
    expect(chooseSandboxOrigin("http://localhost:4400", hostile, "localhost")).toBe("http://localhost:4400");
    expect(chooseSandboxOrigin("javascript:alert(1)", hostile, "example.com")).toBeNull();
    expect(chooseSandboxOrigin("https://127.0.0.1:4400", [], "example.com")).toBeNull();
    expect(chooseSandboxOrigin("http://user:pass@127.0.0.1:9", [], "example.com")).toBeNull();
    expect(chooseSandboxOrigin("http://127.0.0.1:4400/shell.html", [], "example.com")).toBeNull();
  });
});

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
