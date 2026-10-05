import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import type { StageBrowserSupport } from "../src/browser/browserHost.js";
import { resolveBrowserHostCapabilities } from "../src/browser/hostCapabilities.js";
import { defaultStageBrowserSupport } from "../src/browser/stageBrowserEnv.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type WithSupport = { browserSupport(): StageBrowserSupport };

async function boot(browser?: StageBrowserSupport) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-boot-browser-"));
  roots.push(root);
  const result = await bootstrapStageflowHost({
    agent: new FakeAgent({ type: "never_emit" }),
    cwd: root,
    rootDir: root,
    store: createRunStore({ rootDir: root }),
    skipHostConfig: true,
    ...(browser !== undefined ? { browser } : {}),
  });
  return result;
}

describe("Host browser support", () => {
  it("a Host that serves the console reports the live view relay to its browser host", async () => {
    const result = await boot();
    const support = (result.manager as unknown as WithSupport).browserSupport();
    expect(resolveBrowserHostCapabilities(support.host.capabilities).liveView).toBe("relay");
    await result.mcpHandler.close();
  });

  it("an injected browser support wins", async () => {
    const injected = defaultStageBrowserSupport();
    const result = await boot(injected);
    expect((result.manager as unknown as WithSupport).browserSupport().host).toBe(injected.host);
    await result.mcpHandler.close();
  });

  it("the default support used by CLI-only runs reports no live view", () => {
    expect(resolveBrowserHostCapabilities(defaultStageBrowserSupport().host.capabilities).liveView).toBe("none");
  });
});
