import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { requiredScopeFor } from "../src/server/controlToken.js";
import { createLiveViewRoutes, isLiveViewDialogPath, isLiveViewInputPath, isLiveViewPath, isLiveViewReopenTabPath } from "../src/server/liveViewRoutes.js";
import { matchLiveViewRoute } from "../src/server/liveViewPath.js";

const base = "/api/runs/r1/stages/s1/live-view";
const cases: Array<[string, string]> = [
  ["POST", `${base}/ticket`],
  ["GET", `${base}/events`],
  ["POST", `${base}/input`],
  ["POST", `${base}/dialog`],
  ["POST", `${base}/reopen-tab`],
  ["GET", `${base}/reopen-tab`],
  ["GET", `${base}/viewer`],
  ["POST", `${base}/viewer`],
  ["GET", `${base}/ticket`],
  ["POST", `${base}/events`],
  ["GET", `${base}/input`],
  ["PUT", `${base}/dialog`],
  ["POST", `${base}/ticket/extra`],
  ["POST", `${base}/other`],
  ["POST", `${base}/`],
  ["POST", `/api/runs/r1/stages/live-view/ticket`],
  ["POST", `/api/runs/r%2F1/stages/s%201/live-view/ticket`],
  ["GET", `/api/runs/r%2F1/stages/s%201/live-view/events`],
  ["POST", `/api/runs/%zz/stages/s1/live-view/ticket`],
  ["POST", `/api/runs//stages/s1/live-view/ticket`],
  ["POST", `/api/runs/r1/stages/s1/live-view/ticket?x=1`],
  ["POST", `/api/runs/r1/stages/s1/live-view`],
];

function fakeRes() {
  const res = { statusCode: 0, headersSent: false, writableEnded: false } as unknown as ServerResponse & { statusCode: number };
  res.setHeader = (() => res) as never;
  res.writeHead = ((s: number) => {
    res.statusCode = s;
    return res;
  }) as never;
  res.end = (() => res) as never;
  return res;
}

describe("live-view route / bearer exemption agreement", () => {
  const routes = createLiveViewRoutes({ store: {} as never, controlTokens: {} as never });

  it.each(cases)("%s %s", async (method, path) => {
    const pathname = path.split("?")[0]!;
    const matched = matchLiveViewRoute(pathname) !== null;
    expect(isLiveViewPath(pathname)).toBe(matched);
    const exempt = requiredScopeFor(method, pathname) === null;
    expect(exempt).toBe(matched);

    const kind = matchLiveViewRoute(pathname)?.kind;
    expect(isLiveViewInputPath(method, pathname)).toBe(method === "POST" && kind === "input");
    expect(isLiveViewDialogPath(method, pathname)).toBe(method === "POST" && kind === "dialog");

    expect(isLiveViewReopenTabPath(method, pathname)).toBe(method === "POST" && kind === "reopen-tab");

    const wrongMethod =
      ((kind === "events" || kind === "viewer") && method !== "GET") ||
      (kind !== "events" && kind !== "viewer" && method !== "POST");
    const bad = /%zz/.test(path);
    if (matched && (wrongMethod || bad)) {
      const res = fakeRes();
      const handled = await routes.handle({ method, url: path, headers: {} } as IncomingMessage, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(bad ? 400 : 405);
    } else if (!matched) {
      const handled = await routes.handle({ method, url: path, headers: {} } as IncomingMessage, fakeRes());
      expect(handled).toBe(false);
    }
  });

  it("attach registers hooks and unsubscribes", () => {
    const calls: string[] = [];
    const off = routes.attach({
      onGateClosed: () => (calls.push("gate"), () => void calls.push("off-gate")),
      beforeBrowserTeardown: () => (calls.push("teardown"), () => void calls.push("off-teardown")),
      onShutdown: () => (calls.push("shutdown"), () => void calls.push("off-shutdown")),
    });
    expect(calls).toEqual(["gate", "teardown", "shutdown"]);
    off();
    expect(calls.slice(3).sort()).toEqual(["off-gate", "off-shutdown", "off-teardown"]);
  });
});
