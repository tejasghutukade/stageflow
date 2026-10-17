import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { PublicWebChat } from "../src/agents/webChat/publicChat.js";

function exchange(headers: Record<string, string>, method = "OPTIONS") {
  const set: Record<string, string> = {};
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader: (name: string, value: string) => void (set[name.toLowerCase()] = value),
    writeHead(status: number) {
      (res as { status?: number }).status = status;
      res.headersSent = true;
    },
    end() {
      res.writableEnded = true;
    },
  };
  const req = { headers, method, socket: { remoteAddress: "127.0.0.1" } };
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse & { status?: number }, set };
}

const chat = new PublicWebChat({ service: {} as never, chat: {} as never, projectRoot: "/p", allowedOrigins: ["https://site.example"] });

describe("public chat CORS", () => {
  it.each(["null", "not a url", "://broken", "http://"])("does not throw on Origin %s and sets no CORS headers", async (origin) => {
    const { req, res, set } = exchange({ origin, host: "localhost:3000" });
    await expect(chat.handle(req, res, "OPTIONS", "/api/public/chat/abc")).resolves.toBe(true);
    expect(set["access-control-allow-origin"]).toBeUndefined();
    expect(res.status).toBe(204);
  });

  it("still allows the same origin and configured origins", async () => {
    const same = exchange({ origin: "http://localhost:3000", host: "localhost:3000" });
    await chat.handle(same.req, same.res, "OPTIONS", "/api/public/chat/abc");
    expect(same.set["access-control-allow-origin"]).toBe("http://localhost:3000");
    const listed = exchange({ origin: "https://site.example", host: "localhost:3000" });
    await chat.handle(listed.req, listed.res, "OPTIONS", "/api/public/chat/abc");
    expect(listed.set["access-control-allow-origin"]).toBe("https://site.example");
    const other = exchange({ origin: "https://evil.example", host: "localhost:3000" });
    await chat.handle(other.req, other.res, "OPTIONS", "/api/public/chat/abc");
    expect(other.set["access-control-allow-origin"]).toBeUndefined();
  });
});
