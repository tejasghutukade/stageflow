import type {
  BrowserSandboxOrchestrator,
  SandboxInfo,
  SandboxLabels,
  SandboxRef,
  SandboxStartRequest,
} from "./sandboxOrchestrator.js";

export type FakeSandboxOrchestrator = BrowserSandboxOrchestrator & {
  readonly gracefulStops: readonly string[];
  readonly releases: readonly string[];
};

export function createFakeSandboxOrchestrator(
  options: { adapterId?: string; address?: (n: number) => string } = {},
): FakeSandboxOrchestrator {
  const adapterId = options.adapterId ?? "fake";
  const addressOf = options.address ?? ((n) => `ws://127.0.0.1:${9000 + n}/devtools/browser/fake-${n}`);
  const sandboxes = new Map<string, SandboxInfo>();
  const gracefulStops: string[] = [];
  const releases: string[] = [];
  let counter = 0;

  return {
    gracefulStops,
    releases,

    async start(request: SandboxStartRequest): Promise<SandboxInfo> {
      counter += 1;
      const info: SandboxInfo = {
        ref: { id: `sbx-${counter}`, adapter: { id: adapterId, version: 1 } },
        labels: { ...request.labels },
        status: "running",
        attachAddress: addressOf(counter),
      };
      sandboxes.set(info.ref.id, info);
      return structuredClone(info);
    },

    async stopGracefully(ref: SandboxRef): Promise<void> {
      const info = sandboxes.get(ref.id);
      if (info === undefined) return;
      gracefulStops.push(ref.id);
      info.status = "stopped";
      delete info.attachAddress;
    },

    async listByLabel(labels: Partial<SandboxLabels>): Promise<SandboxInfo[]> {
      return [...sandboxes.values()]
        .filter((info) =>
          Object.entries(labels).every(
            ([key, value]) => value === undefined || info.labels[key as keyof SandboxLabels] === value,
          ),
        )
        .map((info) => structuredClone(info));
    },

    async inspect(ref: SandboxRef): Promise<SandboxInfo | undefined> {
      const info = sandboxes.get(ref.id);
      return info === undefined ? undefined : structuredClone(info);
    },

    async release(ref: SandboxRef): Promise<void> {
      if (sandboxes.delete(ref.id)) releases.push(ref.id);
    },
  };
}
