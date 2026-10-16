import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentsCommand } from "../src/cli/agentsCommand.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** A stand-in Host: answers the agents API with canned bodies and records restore requests. */
async function fakeHost(chatFrames: unknown[], current = 5) {
  const restores: unknown[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (url.pathname.endsWith("/chat")) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        for (const frame of chatFrames) res.write(`${JSON.stringify(frame)}\n`);
        res.end();
      } else if (url.pathname.endsWith("/restore")) {
        restores.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ agent: { revision: current + 1 } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ agent: { id: "helper", revision: current } }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const out: string[] = [];
  const err: string[] = [];
  const run = (...args: string[]) =>
    runAgentsCommand(args, {
      projectRoot: "/p",
      cwd: "/p",
      hostBaseUrl: `http://127.0.0.1:${port}`,
      ensureService: async () => ({ ok: true }) as never,
      io: { log: (l) => out.push(l), error: (l) => err.push(l), write: (c) => out.push(c) },
    });
  return { run, out, err, restores };
}

describe("sf agents chat", () => {
  it("exits non-zero and says so when the stream ends with no done or error frame", async () => {
    const host = await fakeHost([{ type: "delta", text: "partial" }]);
    expect(await host.run("chat", "helper", "--message", "hi")).toBe(1);
    expect(host.err.join("\n")).toContain("closed the connection before the reply finished");
  });

  it("prints an error object, not null, with --json", async () => {
    const host = await fakeHost([]);
    expect(await host.run("chat", "helper", "--message", "hi", "--json")).toBe(1);
    expect(JSON.parse(host.out.join("\n"))).toMatchObject({ code: "agent.stream_closed" });
  });

  it("still succeeds on a done frame", async () => {
    const host = await fakeHost([{ type: "delta", text: "hey" }, { type: "done", session: { id: "ses_1" } }]);
    expect(await host.run("chat", "helper", "--message", "hi")).toBe(0);
  });
});

describe("sf agents restore", () => {
  it("does not echo the current revision back as the base", async () => {
    const host = await fakeHost([], 5);
    expect(await host.run("restore", "helper", "2")).toBe(1);
    expect(host.err.join("\n")).toContain("restore needs --base");
    expect(host.err.join("\n")).toContain("--base 5");
    expect(host.restores).toEqual([]);
  });

  it("sends the revision the user names so a newer edit is refused by the lock", async () => {
    const host = await fakeHost([], 5);
    expect(await host.run("restore", "helper", "2", "--base", "4")).toBe(0);
    expect(host.restores).toEqual([{ baseRevision: 4 }]);
    expect(await host.run("restore", "helper", "2", "--base", "x")).toBe(1);
  });
});
