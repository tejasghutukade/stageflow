#!/usr/bin/env node
import { access, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDist = path.join(root, "ui", "dist");
const outDir = path.join(root, "dist", "ui");

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!(await exists(uiDist))) {
    console.error(`Missing UI build output: ${uiDist}`);
    console.error("Run `npm run ui:build` first.");
    process.exit(1);
  }
  const indexHtml = path.join(uiDist, "index.html");
  if (!(await exists(indexHtml))) {
    console.error(`UI build output has no index.html: ${indexHtml}`);
    console.error("Run `npm run ui:build` first.");
    process.exit(1);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.dirname(outDir), { recursive: true });
  await cp(uiDist, outDir, { recursive: true });
  console.log(`Copied ${uiDist} → ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
