import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Recorded = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
export type Scripted = { status?: number; body?: string; headers?: Record<string, string>; delayMs?: number; destroy?: boolean };

export type HttpFixture = {
  url: string;
  requests: Recorded[];
  queue: Scripted[];
  fallback: Scripted;
  close(): Promise<void>;
};

export async function httpFixture(fallback: Scripted = { status: 200, body: "{}" }): Promise<HttpFixture> {
  const requests: Recorded[] = [];
  const queue: Scripted[] = [];
  const fixture = { requests, queue, fallback } as HttpFixture;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const scripted = queue.shift() ?? fixture.fallback;
      const respond = (): void => {
        if (scripted.destroy) { req.socket.destroy(); return; }
        res.writeHead(scripted.status ?? 200, { "content-type": "application/json", ...scripted.headers });
        res.end(scripted.body ?? "");
      };
      if (scripted.delayMs) setTimeout(respond, scripted.delayMs); else respond();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fixture.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture.close = () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return fixture;
}
