#!/usr/bin/env node

import { accessSync, constants, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  let explicitPath;
  let home = os.homedir();
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--path") {
      if (!value) {
        console.error("locate-session-transcript: --path requires a file");
        process.exit(1);
      }
      explicitPath = value;
      i += 1;
      continue;
    }
    if (arg === "--home") {
      if (!value) {
        console.error("locate-session-transcript: --home requires a directory");
        process.exit(1);
      }
      home = value;
      i += 1;
      continue;
    }
    if (arg === "--cwd") {
      if (!value) {
        console.error("locate-session-transcript: --cwd requires a directory");
        process.exit(1);
      }
      cwd = value;
      i += 1;
    }
  }
  return { explicitPath, home, cwd };
}

function print(payload, code) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

function isReadableFile(filePath) {
  try {
    accessSync(filePath, constants.R_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function encodeClaudeProject(cwd) {
  return cwd.replace(/[/\\:]/g, "-");
}

function walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function newestMatch(dir, accept) {
  let best;
  for (const filePath of walkFiles(dir)) {
    if (!accept(filePath)) continue;
    let mtimeMs;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) {
      best = { path: filePath, mtimeMs };
    }
  }
  return best;
}

const { explicitPath, home, cwd } = parseArgs(process.argv.slice(2));

if (explicitPath !== undefined) {
  if (!isReadableFile(explicitPath)) {
    print({ ok: false, reason: "unreadable" }, 1);
  }
  print({ ok: true, path: explicitPath, source: "explicit" }, 0);
}

const probes = [
  {
    source: "claude-code",
    dir: path.join(home, ".claude", "projects", encodeClaudeProject(cwd)),
    accept: (filePath) => filePath.endsWith(".jsonl"),
  },
  {
    source: "codex",
    dir: path.join(home, ".codex", "sessions"),
    accept: (filePath) => {
      const base = path.basename(filePath);
      return base.startsWith("rollout-") && base.endsWith(".jsonl");
    },
  },
  {
    source: "pi",
    dir: path.join(home, ".pi", "agent", "sessions"),
    accept: (filePath) => filePath.endsWith(".jsonl"),
  },
];

let winner;
for (const probe of probes) {
  const match = newestMatch(probe.dir, probe.accept);
  if (!match) continue;
  if (!winner || match.mtimeMs > winner.mtimeMs) {
    winner = { path: match.path, mtimeMs: match.mtimeMs, source: probe.source };
  }
}

if (!winner) {
  print({ ok: false, reason: "not_found" }, 1);
}

print({ ok: true, path: winner.path, source: winner.source }, 0);
