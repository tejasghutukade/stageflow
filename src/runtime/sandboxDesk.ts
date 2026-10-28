import { randomBytes } from "node:crypto";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  copyFromSandboxContainer,
  copyToSandboxContainer,
  execInSandboxContainer,
  SANDBOX_MOUNT_PATH,
} from "./sandboxContainer.js";
import { shellQuote } from "./sandboxFiles.js";
import type { StageArtifactGrant } from "./stageRoots.js";

export type SandboxDeskRole = "artifacts" | "envelope" | "checkout" | "grant" | "work";

export type SandboxDeskBinding = {
  role: SandboxDeskRole;
  hostPath: string;
  containerPath: string;
  shape: "directory" | "file" | "mirror";
  copyIn: boolean;
  copyOut: boolean;
  optional: boolean;
};

export type SandboxDesk = {
  bindings: readonly SandboxDeskBinding[];
};

export function buildSandboxDesk(input: {
  attemptDir: string;
  checkoutRoot?: string;
  grants?: readonly StageArtifactGrant[];
}): SandboxDesk {
  const attemptDir = input.attemptDir;
  const bindings: SandboxDeskBinding[] = [
    {
      role: "artifacts",
      hostPath: path.join(attemptDir, "artifacts"),
      containerPath: `${SANDBOX_MOUNT_PATH}/artifacts`,
      shape: "directory",
      copyIn: true,
      copyOut: false,
      optional: true,
    },
    {
      role: "envelope",
      hostPath: path.join(attemptDir, "envelope.json"),
      containerPath: `${SANDBOX_MOUNT_PATH}/envelope.json`,
      shape: "file",
      copyIn: true,
      copyOut: false,
      optional: true,
    },
  ];

  const checkout = input.checkoutRoot?.trim();
  if (checkout) {
    bindings.push({
      role: "checkout",
      hostPath: checkout,
      containerPath: `${SANDBOX_MOUNT_PATH}/checkout`,
      shape: "directory",
      copyIn: true,
      copyOut: true,
      optional: false,
    });
  }

  for (const grant of input.grants ?? []) {
    bindings.push({
      role: "grant",
      hostPath: grant.hostPath,
      containerPath: grant.containerPath,
      shape: grant.kind === "directory" ? "directory" : "file",
      copyIn: true,
      copyOut: false,
      optional: false,
    });
  }

  bindings.push({
    role: "work",
    hostPath: path.join(attemptDir, "work"),
    containerPath: `${SANDBOX_MOUNT_PATH}/work`,
    shape: "directory",
    copyIn: false,
    copyOut: true,
    optional: true,
  });

  return { bindings };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function populateSandboxDesk(params: {
  containerName: string;
  dockerBin?: string;
  desk: SandboxDesk;
}): Promise<void> {
  const dirs = new Set<string>([
    `${SANDBOX_MOUNT_PATH}/artifacts`,
    `${SANDBOX_MOUNT_PATH}/work`,
    `${SANDBOX_MOUNT_PATH}/grants`,
  ]);
  for (const binding of params.desk.bindings) {
    if (binding.role === "checkout" || binding.shape === "mirror") {
      dirs.add(binding.containerPath);
    }
    if (binding.role === "grant" && binding.shape === "file") {
      dirs.add(path.posix.dirname(binding.containerPath));
    }
    if (binding.role === "grant" && binding.shape === "directory") {
      dirs.add(binding.containerPath);
    }
  }
  const made = await execInSandboxContainer({
    containerName: params.containerName,
    dockerBin: params.dockerBin,
    command: `mkdir -p -- ${[...dirs].map(shellQuote).join(" ")}`,
  });
  if (made.exitCode !== 0) {
    throw new Error(
      `failed to prepare sandbox desk: ${made.stderr.trim() || made.stdout.trim() || `exit ${made.exitCode}`}`,
    );
  }

  for (const binding of params.desk.bindings) {
    if (!binding.copyIn) continue;
    if (!(await pathExists(binding.hostPath))) {
      if (binding.optional) continue;
      throw new Error(`sandbox desk source missing: ${binding.hostPath}`);
    }
    await copyBindingIn(params, binding);
  }
}

export async function syncSandboxDesk(params: {
  containerName: string;
  dockerBin?: string;
  desk: SandboxDesk;
}): Promise<void> {
  for (const binding of params.desk.bindings) {
    if (!binding.copyOut) continue;
    await copyBindingOut(params, binding);
  }
}

async function copyBindingIn(
  params: { containerName: string; dockerBin?: string },
  binding: SandboxDeskBinding,
): Promise<void> {
  if (binding.shape === "file") {
    await copyToSandboxContainer({
      containerName: params.containerName,
      dockerBin: params.dockerBin,
      hostPath: binding.hostPath,
      containerPath: binding.containerPath,
    });
    return;
  }
  if (binding.shape === "directory") {
    await copyToSandboxContainer({
      containerName: params.containerName,
      dockerBin: params.dockerBin,
      hostPath: binding.hostPath,
      containerPath: binding.containerPath,
      contents: true,
    });
    return;
  }
  const info = await stat(binding.hostPath);
  if (info.isDirectory()) {
    await copyToSandboxContainer({
      containerName: params.containerName,
      dockerBin: params.dockerBin,
      hostPath: binding.hostPath,
      containerPath: binding.containerPath,
      contents: true,
    });
    return;
  }
  await copyToSandboxContainer({
    containerName: params.containerName,
    dockerBin: params.dockerBin,
    hostPath: binding.hostPath,
    containerPath: path.posix.join(binding.containerPath, path.basename(binding.hostPath)),
  });
}

async function copyBindingOut(
  params: { containerName: string; dockerBin?: string },
  binding: SandboxDeskBinding,
): Promise<void> {
  if (binding.role === "checkout" || binding.role === "work") {
    await mirrorDirectoryFromContainer(params, binding.containerPath, binding.hostPath);
    return;
  }
  if (binding.shape === "directory") {
    await mkdir(binding.hostPath, { recursive: true });
    await copyFromSandboxContainer({
      containerName: params.containerName,
      dockerBin: params.dockerBin,
      containerPath: binding.containerPath,
      hostPath: binding.hostPath,
      contents: true,
    });
    return;
  }
  const info = await stat(binding.hostPath);
  if (info.isDirectory()) {
    await mkdir(binding.hostPath, { recursive: true });
    await copyFromSandboxContainer({
      containerName: params.containerName,
      dockerBin: params.dockerBin,
      containerPath: binding.containerPath,
      hostPath: binding.hostPath,
      contents: true,
    });
    return;
  }
  await mkdir(path.dirname(binding.hostPath), { recursive: true });
  await copyFromSandboxContainer({
    containerName: params.containerName,
    dockerBin: params.dockerBin,
    containerPath: path.posix.join(binding.containerPath, path.basename(binding.hostPath)),
    hostPath: binding.hostPath,
  });
}

async function mirrorDirectoryFromContainer(
  params: { containerName: string; dockerBin?: string },
  containerPath: string,
  hostPath: string,
): Promise<void> {
  let probe;
  try {
    probe = await execInSandboxContainer({
      containerName: params.containerName,
      dockerBin: params.dockerBin,
      command: `test -d ${shellQuote(containerPath)}`,
    });
  } catch (err) {
    throw new Error(
      `sandbox desk directory unavailable, not replacing ${hostPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (probe.exitCode !== 0) {
    throw new Error(`sandbox desk directory missing, not replacing ${hostPath}`);
  }

  await mkdir(path.dirname(hostPath), { recursive: true });
  const staging = path.join(
    path.dirname(hostPath),
    `.${path.basename(hostPath)}.sf-sync-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(staging);
  try {
    await copyFromSandboxContainer({
      containerName: params.containerName,
      dockerBin: params.dockerBin,
      containerPath,
      hostPath: staging,
      contents: true,
    });
    await replaceDirectory(hostPath, staging);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

async function replaceDirectory(hostPath: string, staging: string): Promise<void> {
  const backup = path.join(
    path.dirname(hostPath),
    `.${path.basename(hostPath)}.sf-sync-bak-${randomBytes(4).toString("hex")}`,
  );
  let hostMoved = false;
  try {
    if (await pathExists(hostPath)) {
      await rename(hostPath, backup);
      hostMoved = true;
    }
    await rename(staging, hostPath);
    hostMoved = false;
  } catch (err) {
    if (hostMoved && !(await pathExists(hostPath)) && (await pathExists(backup))) {
      await rename(backup, hostPath);
    }
    throw err;
  }
  if (await pathExists(backup)) {
    await rm(backup, { recursive: true, force: true });
  }
}
