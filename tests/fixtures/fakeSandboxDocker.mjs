#!/usr/bin/env node
// Minimal stand-in for the `docker` binary, used by bash-in-a-box sandbox
// container tests (src/runtime/sandboxContainer.ts). Supports just the
// three invocations that module makes:
//
//   run -d --name <name> -v <rootDir>:<rootDir> -w <rootDir> <image> sleep infinity
//     -> prints a fake container id, exits 0. If FAKE_DOCKER_LOG_FILE is
//        set, appends a "start <name>" line for lifecycle assertions.
//   exec <name> bash -c <command>
//     -> actually runs <command> via execSync and relays stdout/stderr/exit
//        code, just enough to prove the argv wiring reaches a real shell
//        rather than the host shell directly. Not real container isolation.
//   rm -f <name>
//     -> exits 0. Appends a "stop <name>" line to FAKE_DOCKER_LOG_FILE if set.
import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const [subcommand] = args;

function log(line) {
  const file = process.env.FAKE_DOCKER_LOG_FILE;
  if (!file) return;
  appendFileSync(file, `${line}\n`);
}

if (subcommand === "run") {
  const nameIndex = args.indexOf("--name");
  const name = nameIndex >= 0 ? args[nameIndex + 1] : "unknown";
  log(`start ${name}`);
  process.stdout.write("fakecontainerid1234567890\n");
  process.exit(0);
} else if (subcommand === "rm") {
  const name = args[args.length - 1];
  log(`stop ${name}`);
  process.exit(0);
} else if (subcommand === "exec") {
  // exec <name> bash -c <command>
  const command = args[args.length - 1];
  try {
    const stdout = execSync(command, { shell: "/bin/bash" });
    process.stdout.write(stdout);
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
