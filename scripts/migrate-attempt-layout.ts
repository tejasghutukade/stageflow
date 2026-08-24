#!/usr/bin/env node

import { access, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { runsDir, storeRootFor } from "../src/runstore/paths.js";

const ROOT_RESOURCES = [
  "pi-session.jsonl",
  "log.jsonl",
  "envelope.json",
  ".pi-agent",
  "artifacts",
] as const;

type RootResource = (typeof ROOT_RESOURCES)[number];

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listPresentRootResources(stageDir: string): Promise<RootResource[]> {
  const present: RootResource[] = [];
  for (const name of ROOT_RESOURCES) {
    if (await exists(path.join(stageDir, name))) {
      present.push(name);
    }
  }
  return present;
}

async function migrateStage(runId: string, stageId: string, stageDir: string): Promise<string[] | null> {
  const attempt1Dir = path.join(stageDir, "attempts", "1");
  if (await exists(attempt1Dir)) {
    return null;
  }

  const present = await listPresentRootResources(stageDir);
  if (present.length === 0) {
    return null;
  }

  await mkdir(attempt1Dir, { recursive: true });

  const moved: string[] = [];
  for (const name of present) {
    const from = path.join(stageDir, name);
    const to = path.join(attempt1Dir, name);
    await rename(from, to);
    moved.push(name);
  }

  console.log(`migrated runId=${runId} stageId=${stageId} moved=${moved.join(",")}`);
  return moved;
}

async function main(): Promise<void> {
  const runsDirPath = runsDir(storeRootFor(process.cwd()));
  if (!(await exists(runsDirPath))) {
    console.log("No runs directory found; nothing to migrate.");
    return;
  }

  const runIds = await readdir(runsDirPath);
  let stagesMigrated = 0;
  let itemsMoved = 0;

  for (const runId of runIds) {
    const runDir = path.join(runsDirPath, runId);
    const runStat = await stat(runDir);
    if (!runStat.isDirectory()) {
      continue;
    }

    const stagesDir = path.join(runDir, "stages");
    if (!(await exists(stagesDir))) {
      continue;
    }

    const stageIds = await readdir(stagesDir);
    for (const stageId of stageIds) {
      const stageDir = path.join(stagesDir, stageId);
      const stageStat = await stat(stageDir);
      if (!stageStat.isDirectory()) {
        continue;
      }

      const moved = await migrateStage(runId, stageId, stageDir);
      if (moved) {
        stagesMigrated++;
        itemsMoved += moved.length;
      }
    }
  }

  console.log(`done stagesMigrated=${stagesMigrated} itemsMoved=${itemsMoved}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
