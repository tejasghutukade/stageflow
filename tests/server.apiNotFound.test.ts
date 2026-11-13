import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { loadControlTokens } from "../src/server/controlToken.js";

describe("unknown API paths", () => {
  it("answer a JSON 404 instead of the console page, while console routes still get index.html", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-api-404-"));
    const ui = path.join(root, "ui");
    await mkdir(ui, { recursive: true });
    await writeFile(path.join(ui, "index.html"), "<!doctype html><title>console</title>", "utf8");
    const store = createRunStore({ rootDir: root });
    const token = "t".repeat(40);
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: ui,
      mcpStateless: true,
      controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: token }),
    });
    const address = started.server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const missing = await fetch(`${base}/api/does-not-exist`, { headers: { Authorization: `Bearer ${token}` } });
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).toContain("application/json");
      expect(await missing.json()).toEqual({ error: "Not found", code: "not_found" });

      const page = await fetch(`${base}/some/console/route`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title>console</title>");
    } finally {
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
