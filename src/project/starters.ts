import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, parseDocument } from "yaml";
import { getModelCatalog, type ModelCatalog } from "../models/catalog.js";
import { STARTERS_PENDING_FILE } from "./workspaceCatalog.js";

export { STARTERS_PENDING_FILE };

export const STARTERS_DIR = "starters";

export function resolvePackagedStartersPath(fromUrl: string = import.meta.url): string | undefined {
  const here = path.dirname(fileURLToPath(fromUrl));
  return [path.resolve(here, "../../starters"), path.resolve(here, "../../../starters")].find((dir) =>
    existsSync(path.join(dir, "README.md")),
  );
}

export function startersPending(workspacePath: string): boolean {
  return existsSync(path.join(workspacePath, STARTERS_PENDING_FILE));
}

async function listFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(root, full)));
    else if (entry.isFile()) out.push(path.relative(root, full));
  }
  return out.sort();
}

/** Sets the pipeline default `model` right after `id`, unless the file already sets one. */
export function withPipelineModel(text: string, model: string): string {
  const doc = parseDocument(text);
  if (!isMap(doc.contents) || doc.contents.has("model")) return text;
  const items = doc.contents.items;
  const at = items.findIndex((pair) => (pair.key as { value?: unknown } | null)?.value === "id");
  items.splice(at + 1, 0, doc.createPair("model", model));
  return doc.toString({ lineWidth: 0 });
}

export type InstallStartersResult = { installed: boolean; files: string[] };

/**
 * Copies the packaged starters into `<workspace>/starters` when the workspace is marked pending,
 * filling each pipeline's `model`. Existing files are never overwritten.
 */
export async function installPendingStarters(input: {
  workspacePath: string;
  model: string;
  sourceDir?: string;
}): Promise<InstallStartersResult> {
  const { workspacePath, model } = input;
  if (!startersPending(workspacePath)) return { installed: false, files: [] };
  const sourceDir = input.sourceDir ?? resolvePackagedStartersPath();
  if (sourceDir === undefined) return { installed: false, files: [] };

  const written: string[] = [];
  const targetRoot = path.join(workspacePath, STARTERS_DIR);
  for (const rel of await listFiles(sourceDir)) {
    const target = path.join(targetRoot, rel);
    if (existsSync(target)) continue;
    let text = await readFile(path.join(sourceDir, rel), "utf8");
    if (rel.endsWith(".pipeline.yaml")) text = withPipelineModel(text, model);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, { encoding: "utf8", flag: "wx" });
    written.push(path.join(STARTERS_DIR, rel));
  }
  await rm(path.join(workspacePath, STARTERS_PENDING_FILE), { force: true });
  return { installed: true, files: written };
}

const inflight = new Map<string, Promise<InstallStartersResult>>();

/**
 * Installs pending starters once a provider is connected, with the catalog's default model.
 * `refresh` re-reads connections (use it right after a provider connects).
 */
export function installStartersWhenConnected(input: {
  cwd: string;
  workspacePath: string;
  refresh?: boolean;
  catalog?: Pick<ModelCatalog, "snapshot" | "refresh" | "defaultModel">;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallStartersResult> {
  if ((input.env ?? process.env).STAGEFLOW_NO_STARTERS === "1") return Promise.resolve({ installed: false, files: [] });
  if (!startersPending(input.workspacePath)) return Promise.resolve({ installed: false, files: [] });
  const running = inflight.get(input.workspacePath);
  if (running) return running;
  const catalog = input.catalog ?? getModelCatalog(input.cwd);
  const run = (async () => {
    const snapshot = await (input.refresh ? catalog.refresh() : catalog.snapshot());
    if (snapshot.providers.length === 0) return { installed: false, files: [] };
    return installPendingStarters({ workspacePath: input.workspacePath, model: await catalog.defaultModel() });
  })().finally(() => {
    inflight.delete(input.workspacePath);
  });
  inflight.set(input.workspacePath, run);
  return run;
}
