#!/usr/bin/env node
/**
 * Minimal stub: write an image toolchain manifest for container builds.
 * Usage: node scripts/generate-toolchain-manifest.mjs [outPath]
 * Default outPath: toolchain.json (cwd). In images, copy to /etc/stageflow/toolchain.json.
 */
import { accessSync, constants, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import semver from "semver";

const TOOLS = ["node", "git", "bash"];
const outPath = path.resolve(process.argv[2] ?? "toolchain.json");

function resolveOnPath(command) {
  if (command.includes("/") || command.includes("\\")) return command;
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* continue */
    }
  }
  return undefined;
}

function probe(command) {
  const resolved = resolveOnPath(command);
  if (!resolved) return undefined;
  if (command === "node") {
    return { path: resolved, version: process.versions.node };
  }
  const result = spawnSync(resolved, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const coerced = semver.coerce(output, { loose: true });
  if (!coerced) {
    return { path: resolved, version: output.trim().split("\n")[0] ?? "" };
  }
  return { path: resolved, version: coerced.version };
}

const tools = {};
for (const name of TOOLS) {
  const entry = probe(name);
  if (entry) tools[name] = entry;
}

writeFileSync(outPath, `${JSON.stringify({ tools }, null, 2)}\n`);
console.log(`Wrote ${outPath} (${Object.keys(tools).length} tools)`);
