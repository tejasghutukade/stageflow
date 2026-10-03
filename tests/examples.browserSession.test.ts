import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createFixtureServer } from "../examples/browser-session/fixture-server.mjs";

const EXAMPLE = path.join(process.cwd(), "examples", "browser-session");

describe("examples/browser-session pipeline", () => {
  it("loads with the check, login, two parallel work stages, merge topology", async () => {
    const loaded = await loadPipeline(path.join(EXAMPLE, "browser-session.pipeline.yaml"));
    const byId = new Map(loaded.stages.map((s) => [s.id, s]));
    expect([...byId.keys()]).toEqual([
      "check-login",
      "human-login",
      "work-a",
      "work-b",
      "merge",
    ]);
    for (const stage of loaded.stages) {
      if (stage.id === "merge") {
        expect(stage.browser).toBeUndefined();
        continue;
      }
      expect(stage.browser?.profile).toBe("fixture-site");
      expect(stage.requires).toEqual([{ tool: "agent-browser" }]);
    }
    const edges = Object.fromEntries(
      loaded.dag.nodes.map((n) => [n.id, n.needsEdges.map((e) => [e.id, e.if !== undefined])]),
    );
    expect(edges["human-login"]).toEqual([["check-login", true]]);
    for (const work of ["work-a", "work-b"]) {
      expect(edges[work]).toEqual(
        expect.arrayContaining([
          ["check-login", false],
          ["human-login", false],
        ]),
      );
    }
    expect(edges.merge).toEqual(
      expect.arrayContaining([
        ["work-a", false],
        ["work-b", false],
      ]),
    );
    expect(loaded.dag.nodes.find((n) => n.id === "human-login")?.completion).toBeDefined();
    expect(byId.get("human-login")?.browser?.headed).not.toBe(false);
  });
});

describe("examples/browser-session fixture server", () => {
  const server = createFixtureServer();
  let base: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("redirects /home to /login without the cookie", async () => {
    const res = await fetch(`${base}/home`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("sets one persistent and one session-only cookie on login", async () => {
    const res = await fetch(`${base}/login?go=1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const cookies = res.headers.getSetCookie();
    const persistent = cookies.find((c) => c.startsWith("fixture_login="));
    const session = cookies.find((c) => c.startsWith("fixture_session="));
    expect(persistent).toMatch(/Max-Age=/i);
    expect(session).toBeDefined();
    expect(session).not.toMatch(/Max-Age|Expires/i);
  });

  it("serves distinct pages /a and /b only with the cookie", async () => {
    for (const page of ["a", "b"]) {
      const anon = await fetch(`${base}/${page}`, { redirect: "manual" });
      expect(anon.status).toBe(302);
      const res = await fetch(`${base}/${page}`, { headers: { cookie: "fixture_login=1" } });
      expect(await res.text()).toContain(`Page ${page.toUpperCase()}`);
    }
  });

  it("shows Welcome on /home only with the cookie", async () => {
    const res = await fetch(`${base}/home`, { headers: { cookie: "fixture_login=1" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Welcome");
  });
});
