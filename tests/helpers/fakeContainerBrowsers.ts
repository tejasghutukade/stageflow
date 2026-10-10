import type { BrowserEndpointClient } from "../../src/browser/containerBrowserEndpoint.js";
import { createFakeSandboxOrchestrator } from "../../src/browser/fakeSandboxOrchestrator.js";
import type { BrowserSandboxOrchestrator, SandboxRef } from "../../src/browser/sandboxOrchestrator.js";

export type FakeContainerBrowsers = {
  orchestrator: BrowserSandboxOrchestrator;
  endpoint: BrowserEndpointClient;
  /** Ordered record of closes (`close:<n>`), stops (`stop:<id>`) and releases (`release:<id>`). */
  events: string[];
  /** The browser stops answering without the container being released (a crash). */
  crash(n: number): void;
  /** Graceful close is ignored by this browser, so the host must fall back to stopping the container. */
  ignoreClose(): void;
  addressOf(n: number): string;
};

export function createFakeContainerBrowsers(): FakeContainerBrowsers {
  const events: string[] = [];
  const alive = new Set<number>();
  let stubborn = false;
  const idOf = (ref: SandboxRef) => Number(ref.id.replace("sbx-", ""));
  const inner = createFakeSandboxOrchestrator({ address: (n) => `http://10.0.0.${n}:9222` });
  const addressOf = (n: number) => `ws://10.0.0.${n}:9222/devtools/browser/b${n}`;
  const portOf = (url: string) => Number(new URL(url).hostname.split(".")[3]);

  const orchestrator: BrowserSandboxOrchestrator = {
    async start(request) {
      const info = await inner.start(request);
      alive.add(idOf(info.ref));
      return info;
    },
    async stopGracefully(ref) {
      events.push(`stop:${ref.id}`);
      alive.delete(idOf(ref));
      return inner.stopGracefully(ref);
    },
    listByLabel: (labels) => inner.listByLabel(labels),
    inspect: (ref) => inner.inspect(ref),
    async release(ref) {
      events.push(`release:${ref.id}`);
      alive.delete(idOf(ref));
      return inner.release(ref);
    },
  };

  const endpoint: BrowserEndpointClient = {
    async resolve(address) {
      const n = portOf(address);
      return alive.has(n) ? addressOf(n) : undefined;
    },
    async closeBrowser(address) {
      const n = portOf(address);
      events.push(`close:${n}`);
      if (!stubborn) alive.delete(n);
    },
  };

  return {
    orchestrator,
    endpoint,
    events,
    crash: (n) => void alive.delete(n),
    ignoreClose: () => {
      stubborn = true;
    },
    addressOf,
  };
}
