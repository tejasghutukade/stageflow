import { describe, expect, it } from "vitest";
import type { BrowserSandboxOrchestrator, SandboxInfo } from "../../src/browser/sandboxOrchestrator.js";

export type OrchestratorConformanceOptions = {
  create: () => BrowserSandboxOrchestrator | Promise<BrowserSandboxOrchestrator>;
  cleanup?: (orchestrator: BrowserSandboxOrchestrator, started: SandboxInfo[]) => Promise<void>;
  skip?: boolean;
  timeoutMs?: number;
};

export function runSandboxOrchestratorConformance(name: string, options: OrchestratorConformanceOptions): void {
  const suite = options.skip ? describe.skip : describe;
  suite(`sandbox orchestrator conformance: ${name}`, () => {
    const timeout = options.timeoutMs ?? 30_000;
    const scope = `conf-${Math.random().toString(36).slice(2, 8)}`;
    const labels = { scope, runId: "r1", stageId: "s1" };

    async function withOrchestrator(body: (o: BrowserSandboxOrchestrator, track: (i: SandboxInfo) => SandboxInfo) => Promise<void>) {
      const o = await options.create();
      const started: SandboxInfo[] = [];
      try {
        await body(o, (info) => {
          started.push(info);
          return info;
        });
      } finally {
        if (options.cleanup) await options.cleanup(o, started);
        else for (const info of started) await o.release(info.ref);
      }
    }

    it("starts a running, labelled sandbox with an opaque serializable ref", async () => {
      await withOrchestrator(async (o, track) => {
        const info = track(await o.start({ labels }));
        expect(info.status).toBe("running");
        expect(info.labels).toEqual(labels);
        expect(info.attachAddress).toEqual(expect.any(String));
        expect(info.ref.id).toEqual(expect.any(String));
        expect(info.ref.adapter.id).toEqual(expect.any(String));
        expect(info.ref.adapter.version).toEqual(expect.any(Number));
        expect(JSON.parse(JSON.stringify(info.ref))).toEqual(info.ref);
        expect(Object.keys(info.ref).sort()).toEqual(["adapter", "id"]);
      });
    }, timeout);

    it("gives each sandbox a distinct ref", async () => {
      await withOrchestrator(async (o, track) => {
        const a = track(await o.start({ labels }));
        const b = track(await o.start({ labels }));
        expect(a.ref.id).not.toBe(b.ref.id);
      });
    }, timeout);

    it("lists by any subset of labels and inspects", async () => {
      await withOrchestrator(async (o, track) => {
        const a = track(await o.start({ labels }));
        track(await o.start({ labels: { ...labels, runId: "r2" } }));
        expect((await o.listByLabel({ scope, runId: "r1" })).map((i) => i.ref.id)).toEqual([a.ref.id]);
        expect(await o.listByLabel({ scope })).toHaveLength(2);
        expect(await o.listByLabel({ scope, runId: "nope" })).toEqual([]);
        expect((await o.inspect(a.ref))?.labels).toEqual(labels);
      });
    }, timeout);

    it("round-trips the optional profile label", async () => {
      await withOrchestrator(async (o, track) => {
        const info = track(await o.start({ labels: { ...labels, profile: "work" }, profile: { scope, name: "work" } }));
        expect(info.labels.profile).toBe("work");
        expect((await o.listByLabel({ scope, profile: "work" })).map((i) => i.ref.id)).toEqual([info.ref.id]);
      });
    }, timeout);

    it("graceful stop keeps the sandbox inspectable and drops the attach address", async () => {
      await withOrchestrator(async (o, track) => {
        const info = track(await o.start({ labels }));
        await o.stopGracefully(info.ref);
        const stopped = await o.inspect(info.ref);
        expect(stopped?.status).toBe("stopped");
        expect(stopped?.attachAddress).toBeUndefined();
        await o.stopGracefully(info.ref);
      });
    }, timeout);

    it("release is idempotent and removes the sandbox", async () => {
      await withOrchestrator(async (o, track) => {
        const info = track(await o.start({ labels }));
        await o.release(info.ref);
        await o.release(info.ref);
        expect(await o.inspect(info.ref)).toBeUndefined();
        expect(await o.listByLabel({ scope })).toEqual([]);
      });
    }, timeout);

    it("tolerates an unknown ref on every operation", async () => {
      await withOrchestrator(async (o, track) => {
        const info = track(await o.start({ labels }));
        const unknown = { id: "sbx-does-not-exist", adapter: info.ref.adapter };
        expect(await o.inspect(unknown)).toBeUndefined();
        await o.stopGracefully(unknown);
        await o.release(unknown);
      });
    }, timeout);

    it("starts normally when no egress policy is given", async () => {
      await withOrchestrator(async (o, track) => {
        const info = track(await o.start({ labels, egress: undefined }));
        expect(info.status).toBe("running");
      });
    }, timeout);
  });
}
