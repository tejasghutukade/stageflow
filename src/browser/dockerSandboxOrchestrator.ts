import { execFile } from "node:child_process";
import {
  SandboxError,
  type BrowserSandboxOrchestrator,
  type SandboxInfo,
  type SandboxLabels,
  type SandboxRef,
  type SandboxStartRequest,
  type SandboxStatus,
} from "./sandboxOrchestrator.js";

export type DockerCliResult = { code: number; stdout: string; stderr: string };
export type DockerCliRunner = (args: string[]) => Promise<DockerCliResult>;

export type DockerSandboxOptions = {
  image: string;
  command?: string[];
  debugPort?: number;
  shmSize?: string;
  memory?: string;
  pidsLimit?: number;
  user?: string;
  tmpfs?: string[];
  stopTimeoutSeconds?: number;
  profileMountPath?: string;
  run?: DockerCliRunner;
};

const LABEL_PREFIX = "stageflow.";
const MARKER = `${LABEL_PREFIX}sandbox=1`;
const LABEL_KEYS: Record<keyof SandboxLabels, string> = {
  scope: `${LABEL_PREFIX}scope`,
  runId: `${LABEL_PREFIX}run`,
  stageId: `${LABEL_PREFIX}stage`,
  profile: `${LABEL_PREFIX}profile`,
};

export const defaultDockerCliRunner: DockerCliRunner = (args) =>
  new Promise((resolve) => {
    execFile("docker", args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
      resolve({ code, stdout: String(stdout), stderr: err !== null && stderr === "" ? err.message : String(stderr) });
    });
  });

type InspectEntry = {
  Id: string;
  Config?: { Labels?: Record<string, string> };
  State?: { Status?: string };
  NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
};

function volumeName(scope: string, name: string): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `sf-profile-${safe(scope)}-${safe(name)}`;
}

function statusOf(raw: string | undefined): SandboxStatus {
  if (raw === "running" || raw === "restarting" || raw === "paused") return "running";
  if (raw === "dead") return "dead";
  return "stopped";
}

function isMissing(result: DockerCliResult): boolean {
  return /no such (container|object)/i.test(result.stderr);
}

/**
 * Development only: shells out to the local container CLI. It needs a runtime
 * socket on the machine running it, so it must never run inside a Stageflow container.
 */
export function createDockerSandboxOrchestrator(options: DockerSandboxOptions): BrowserSandboxOrchestrator {
  const run = options.run ?? defaultDockerCliRunner;
  const debugPort = options.debugPort ?? 9222;
  const stopTimeout = options.stopTimeoutSeconds ?? 10;
  const profileMount = options.profileMountPath ?? "/profile";

  function toInfo(entry: InspectEntry): SandboxInfo {
    const raw = entry.Config?.Labels ?? {};
    const labels: SandboxLabels = { scope: raw[LABEL_KEYS.scope] ?? "", runId: raw[LABEL_KEYS.runId] ?? "" };
    if (raw[LABEL_KEYS.stageId] !== undefined) labels.stageId = raw[LABEL_KEYS.stageId];
    if (raw[LABEL_KEYS.profile] !== undefined) labels.profile = raw[LABEL_KEYS.profile];
    const status = statusOf(entry.State?.Status);
    const info: SandboxInfo = { ref: { id: entry.Id, adapter: { id: "docker", version: 1 } }, labels, status };
    const binding = entry.NetworkSettings?.Ports?.[`${debugPort}/tcp`]?.[0];
    if (status === "running" && binding?.HostPort !== undefined) {
      info.attachAddress = `http://127.0.0.1:${binding.HostPort}`;
    }
    return info;
  }

  async function inspectMany(ids: string[]): Promise<SandboxInfo[]> {
    if (ids.length === 0) return [];
    const result = await run(["inspect", ...ids]);
    if (result.code !== 0) {
      if (isMissing(result)) return [];
      throw new SandboxError("unavailable", `docker inspect failed: ${result.stderr.trim()}`);
    }
    return (JSON.parse(result.stdout) as InspectEntry[]).map(toInfo);
  }

  return {
    async start(request: SandboxStartRequest): Promise<SandboxInfo> {
      if (request.egress !== undefined) {
        throw new SandboxError("not_supported", "the docker development orchestrator cannot enforce an egress policy");
      }
      const args = [
        "run",
        "-d",
        "--init",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        String(options.pidsLimit ?? 512),
        "--memory",
        options.memory ?? "1g",
        "--label",
        MARKER,
        "-p",
        `127.0.0.1::${debugPort}`,
      ];
      for (const mount of options.tmpfs ?? ["/tmp"]) args.push("--tmpfs", mount);
      if (options.user !== undefined) args.push("--user", options.user);
      if (options.shmSize !== undefined) args.push("--shm-size", options.shmSize);
      for (const [key, label] of Object.entries(LABEL_KEYS) as [keyof SandboxLabels, string][]) {
        const value = request.labels[key];
        if (value !== undefined) args.push("--label", `${label}=${value}`);
      }
      if (request.profile !== undefined) {
        args.push("-v", `${volumeName(request.profile.scope, request.profile.name)}:${profileMount}`);
      }
      args.push(options.image, ...(options.command ?? []));
      const started = await run(args);
      if (started.code !== 0) {
        throw new SandboxError("unavailable", `docker run failed: ${started.stderr.trim()}`);
      }
      const id = started.stdout.trim().split("\n").pop() ?? "";
      const [info] = await inspectMany([id]);
      if (info === undefined) throw new SandboxError("failed", "container vanished after start");
      return info;
    },

    async stopGracefully(ref: SandboxRef): Promise<void> {
      const result = await run(["stop", "-t", String(stopTimeout), ref.id]);
      if (result.code !== 0 && !isMissing(result)) {
        throw new SandboxError("failed", `docker stop failed: ${result.stderr.trim()}`);
      }
    },

    async listByLabel(labels: Partial<SandboxLabels>): Promise<SandboxInfo[]> {
      const args = ["ps", "-a", "--no-trunc", "--format", "{{.ID}}", "--filter", `label=${MARKER}`];
      for (const [key, label] of Object.entries(LABEL_KEYS) as [keyof SandboxLabels, string][]) {
        const value = labels[key];
        if (value !== undefined) args.push("--filter", `label=${label}=${value}`);
      }
      const listed = await run(args);
      if (listed.code !== 0) throw new SandboxError("unavailable", `docker ps failed: ${listed.stderr.trim()}`);
      return inspectMany(listed.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""));
    },

    async inspect(ref: SandboxRef): Promise<SandboxInfo | undefined> {
      return (await inspectMany([ref.id]))[0];
    },

    async release(ref: SandboxRef): Promise<void> {
      const result = await run(["rm", "-f", "-v", ref.id]);
      if (result.code !== 0 && !isMissing(result)) {
        throw new SandboxError("failed", `docker rm failed: ${result.stderr.trim()}`);
      }
    },
  };
}
