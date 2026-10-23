#!/usr/bin/env node
// Minimal stand-in for the `docker` binary, used by sandbox desk tests
// (src/runtime/sandboxContainer.ts). Supports the invocations that module makes:
//
//   run -d --name <name> -v sf-bash-<name>:/workspace -w /workspace <image> sleep infinity
//     -> creates a per-container temp directory that stands in for /workspace,
//        prints a fake container id, exits 0. If FAKE_DOCKER_LOG_FILE is set,
//        appends a "start <name>" line.
//   exec [-w /workspace] <name> bash -c <command>
//     -> runs <command> with cwd set to that container's fake /workspace.
//        Absolute /workspace paths in the command are rewritten to the temp
//        directory. Not a chroot: the command can still name other host paths.
//   cp <src> <dest>
//     -> copies between a host path and <name>:/workspace/... . A trailing
//        "/." copies directory contents. FAKE_DOCKER_FAIL_CP=1 forces failure.
//   rm -f <name>
//     -> exits 0. Appends a "stop <name>" line to FAKE_DOCKER_LOG_FILE if set.
//   volume rm <name>
//     -> exits 0. Appends a "volume-rm <name>" line to FAKE_DOCKER_LOG_FILE if set.
import { execSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const [subcommand] = args;
const MOUNT = "/workspace";

function log(line) {
  const file = process.env.FAKE_DOCKER_LOG_FILE;
  if (!file) return;
  appendFileSync(file, `${line}\n`);
}

function stateRoot() {
  return process.env.FAKE_DOCKER_STATE_DIR ?? path.join(os.tmpdir(), "sf-fake-sandbox-docker");
}

function workspaceFor(name) {
  return path.join(stateRoot(), name);
}

function containerPathToHost(name, containerPath) {
  if (containerPath !== MOUNT && !containerPath.startsWith(`${MOUNT}/`)) {
    process.stderr.write(`fakeSandboxDocker: path outside ${MOUNT}: ${containerPath}\n`);
    process.exit(1);
  }
  const rel = containerPath === MOUNT ? "" : containerPath.slice(MOUNT.length + 1);
  return path.join(workspaceFor(name), rel);
}

function splitEndpoint(spec) {
  const contents = spec.endsWith("/.");
  const raw = contents ? spec.slice(0, -2) : spec;
  const container = raw.match(/^([^:]+):(\/.*)$/);
  if (container) {
    return {
      kind: "container",
      name: container[1],
      abs: containerPathToHost(container[1], container[2]),
      contents,
    };
  }
  return { kind: "host", abs: raw, contents };
}

function copyNode(src, dest, contents) {
  if (!existsSync(src)) {
    process.stderr.write(`fakeSandboxDocker: cp source missing ${src}\n`);
    process.exit(1);
  }
  if (contents) {
    if (!statSync(src).isDirectory()) {
      process.stderr.write(`fakeSandboxDocker: cp contents source is not a directory ${src}\n`);
      process.exit(1);
    }
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      cpSync(path.join(src, name), path.join(dest, name), {
        recursive: true,
        verbatimSymlinks: true,
        force: true,
      });
    }
    return;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true, force: true });
}

if (subcommand === "run") {
  const nameIndex = args.indexOf("--name");
  const name = nameIndex >= 0 ? args[nameIndex + 1] : "unknown";
  mkdirSync(workspaceFor(name), { recursive: true });
  log(`start ${name}`);
  process.stdout.write("fakecontainerid1234567890\n");
  process.exit(0);
} else if (subcommand === "rm") {
  const name = args[args.length - 1];
  log(`stop ${name}`);
  process.exit(0);
} else if (subcommand === "volume") {
  const name = args[args.length - 1];
  if (args[1] !== "rm") {
    process.stderr.write(`fakeSandboxDocker: unsupported volume command ${args[1]}\n`);
    process.exit(1);
  }
  log(`volume-rm ${name}`);
  process.exit(0);
} else if (subcommand === "cp") {
  if (process.env.FAKE_DOCKER_FAIL_CP === "1") {
    process.stderr.write("forced cp failure\n");
    process.exit(1);
  }
  const src = splitEndpoint(args[1]);
  const dest = splitEndpoint(args[2]);
  if (src.kind === "container") mkdirSync(workspaceFor(src.name), { recursive: true });
  if (dest.kind === "container") mkdirSync(workspaceFor(dest.name), { recursive: true });
  copyNode(src.abs, dest.abs, src.contents);
  process.exit(0);
} else if (subcommand === "exec") {
  let i = 1;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-w" || args[i] === "--workdir") {
      i += 2;
      continue;
    }
    i += 1;
  }
  const name = args[i];
  const command = args[args.length - 1];
  const workspace = workspaceFor(name);
  mkdirSync(workspace, { recursive: true });
  const rewritten = command.replaceAll(MOUNT, workspace);
  try {
    const stdout = execSync(rewritten, {
      cwd: workspace,
      shell: "/bin/bash",
      env: { ...process.env, HOME: workspace, PWD: workspace },
    });
    if (stdout) process.stdout.write(stdout);
    process.exit(0);
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    process.exit(typeof err.status === "number" ? err.status : 1);
  }
} else {
  process.stderr.write(`fakeSandboxDocker: unsupported subcommand ${subcommand}\n`);
  process.exit(1);
}
