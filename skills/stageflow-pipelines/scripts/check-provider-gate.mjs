#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  let sfBin = "sf";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--sf-bin") {
      const value = argv[i + 1];
      if (!value) {
        console.error("check-provider-gate: --sf-bin requires a path");
        process.exit(1);
      }
      sfBin = value;
      i += 1;
    }
  }
  return { sfBin };
}

function print(payload, code) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

const { sfBin } = parseArgs(process.argv.slice(2));
const result = spawnSync(sfBin, ["providers", "status"], { encoding: "utf8" });

if (result.error || result.status === null) {
  print({ ok: false, reason: "sf_not_found" }, 1);
}

const lines = (result.stdout ?? "").split(/\r?\n/);
for (const line of lines) {
  if (line.length === 0) continue;
  const fields = line.split("\t");
  if (fields[1] === "configured") {
    print({ ok: true }, 0);
  }
}

print({ ok: false, reason: "no_provider_configured" }, 1);
