import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createDockerSandboxOrchestrator, type DockerCliRunner } from "../src/browser/dockerSandboxOrchestrator.js";
import { createFakeSandboxOrchestrator } from "../src/browser/fakeSandboxOrchestrator.js";
import { createSessionApiSandboxOrchestrator } from "../src/browser/sessionApiSandboxOrchestrator.js";
import { createFakeProviderSession } from "./helpers/fakeProviderSession.js";
import { SandboxError } from "../src/browser/sandboxOrchestrator.js";
import { runSandboxOrchestratorConformance } from "./helpers/sandboxOrchestratorConformance.js";

type FakeContainer = { id: string; labels: Record<string, string>; status: string; port: string; args: string[] };

function createFakeDockerCli(): { run: DockerCliRunner; calls: string[][]; containers: Map<string, FakeContainer> } {
  const containers = new Map<string, FakeContainer>();
  const calls: string[][] = [];
  let n = 0;
  const missing = { code: 1, stdout: "", stderr: "Error: No such container: x" };
  const run: DockerCliRunner = async (args) => {
    calls.push(args);
    const [verb] = args;
    if (verb === "run") {
      n += 1;
      const labels: Record<string, string> = {};
      args.forEach((a, i) => {
        if (a === "--label") {
          const [k, ...v] = args[i + 1]!.split("=");
          labels[k!] = v.join("=");
        }
      });
      const id = `c${String(n).padStart(4, "0")}`.repeat(8);
      containers.set(id, { id, labels, status: "running", port: String(40000 + n), args });
      return { code: 0, stdout: `${id}\n`, stderr: "" };
    }
    if (verb === "inspect") {
      const found = args.slice(1).map((id) => containers.get(id));
      if (found.some((c) => c === undefined)) return missing;
      const body = (found as FakeContainer[]).map((c) => ({
        Id: c.id,
        Config: { Labels: c.labels },
        State: { Status: c.status },
        NetworkSettings: { Ports: { "9222/tcp": c.status === "running" ? [{ HostIp: "127.0.0.1", HostPort: c.port }] : null } },
      }));
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    }
    if (verb === "ps") {
      const wanted: string[] = [];
      args.forEach((a, i) => {
        if (a === "--filter") wanted.push(args[i + 1]!.slice("label=".length));
      });
      const ids = [...containers.values()]
        .filter((c) => wanted.every((w) => c.labels[w.split("=")[0]!] === w.split("=").slice(1).join("=")))
        .map((c) => c.id);
      return { code: 0, stdout: ids.join("\n"), stderr: "" };
    }
    if (verb === "stop") {
      const c = containers.get(args.at(-1)!);
      if (c === undefined) return missing;
      c.status = "exited";
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "rm") {
      return containers.delete(args.at(-1)!) ? { code: 0, stdout: "", stderr: "" } : missing;
    }
    return { code: 1, stdout: "", stderr: `unsupported ${verb}` };
  };
  return { run, calls, containers };
}

function dockerUsable(): boolean {
  if (process.env.STAGEFLOW_DOCKER_SMOKE !== "1") return false;
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

runSandboxOrchestratorConformance("in-memory fake", { create: () => createFakeSandboxOrchestrator() });

runSandboxOrchestratorConformance("provider-style session API adapter (recorded-API stand-in)", {
  create: () => createSessionApiSandboxOrchestrator({ client: createFakeProviderSession().api }),
});

runSandboxOrchestratorConformance("docker development implementation (simulated CLI)", {
  create: () => createDockerSandboxOrchestrator({ image: "fake:image", run: createFakeDockerCli().run }),
});

runSandboxOrchestratorConformance("docker development implementation (real CLI, STAGEFLOW_DOCKER_SMOKE=1)", {
  skip: !dockerUsable(),
  timeoutMs: 120_000,
  create: () =>
    createDockerSandboxOrchestrator({
      image: process.env.STAGEFLOW_SANDBOX_TEST_IMAGE ?? "busybox:latest",
      command: ["sleep", "600"],
      stopTimeoutSeconds: 2,
    }),
});

describe("docker development sandbox orchestrator", () => {
  it("passes labels, the debug port and the profile volume to the CLI, and never a runtime socket", async () => {
    const cli = createFakeDockerCli();
    const o = createDockerSandboxOrchestrator({ image: "fake:image", command: ["sleep", "1"], shmSize: "1g", run: cli.run });
    const info = await o.start({
      labels: { scope: "local", runId: "r1", stageId: "s1", profile: "work/main" },
      profile: { scope: "local", name: "work/main" },
    });
    const args = cli.calls[0]!.join(" ");
    expect(args).toContain("--label stageflow.scope=local");
    expect(args).toContain("--label stageflow.run=r1");
    expect(args).toContain("-p 127.0.0.1::9222");
    expect(args).toContain("-v sf-profile-local-work_main:/profile");
    expect(args).toContain("--shm-size 1g");
    expect(args).toMatch(/fake:image sleep 1$/);
    expect(args).not.toMatch(/docker\.sock|--privileged/);
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop ALL");
    expect(args).toContain("--security-opt no-new-privileges");
    expect(args).toContain("--pids-limit 512");
    expect(args).toContain("--memory 1g");
    expect(args).toContain("--tmpfs /tmp");
    expect(info.attachAddress).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("rejects an egress policy it cannot enforce", async () => {
    const o = createDockerSandboxOrchestrator({ image: "fake:image", run: createFakeDockerCli().run });
    await expect(
      o.start({ labels: { scope: "local", runId: "r1" }, egress: { allowDomains: ["example.com"] } }),
    ).rejects.toMatchObject({ errorClass: "not_supported" });
    await expect(o.start({ labels: { scope: "local", runId: "r1" }, egress: {} })).rejects.toBeInstanceOf(SandboxError);
  });

  it("maps a failing run to unavailable and a failing remove to failed", async () => {
    const o = createDockerSandboxOrchestrator({
      image: "fake:image",
      run: async () => ({ code: 125, stdout: "", stderr: "cannot connect to the Docker daemon" }),
    });
    await expect(o.start({ labels: { scope: "local", runId: "r1" } })).rejects.toMatchObject({ errorClass: "unavailable" });
    await expect(o.release({ id: "x", adapter: { id: "docker", version: 1 } })).rejects.toMatchObject({ errorClass: "failed" });
  });
});
