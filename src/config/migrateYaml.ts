import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadPipelineOutcome } from "./loadPipeline.js";
import { afterCompletionForStage, loadStageOutcome } from "./loadStage.js";
import { readYamlObject } from "./readYamlObject.js";
import { relPath } from "./validateCatalog.js";
import {
  buildVerifyItems,
  ioFromSchemas,
  rewriteCatalogDocument,
  rewritePipelineStageEntry,
  rewriteStageDocument,
  stringifyTargetYaml,
} from "./printTargetYaml.js";
import {
  classifyYamlDocument,
  type YamlDialect,
} from "./yamlDialect.js";
import type { CompletionCheck } from "../types/completion.js";
import type { LoadedPipeline } from "../types/pipeline.js";
import type { LoadedStageConfig } from "../types/stage.js";
import type { PreEmitCheck } from "../types/preEmitCheck.js";

export type MigrateYamlWrite = {
  file: string;
  absPath: string;
  content: string;
};

export type MigrateYamlPlan = {
  writes: MigrateYamlWrite[];
  skipped: string[];
  errors: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAbs(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

function isStageflowPath(absPath: string): boolean {
  return absPath.split(path.sep).includes(".stageflow");
}

const SKIP_DIRS = new Set([".git", ".stageflow", "node_modules", "dist"]);

async function walkFiles(
  dir: string,
  predicate: (name: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await walkFiles(abs, predicate)));
      continue;
    }
    if (entry.isFile() && predicate(entry.name)) found.push(abs);
  }
  return found;
}

async function collectIncludes(filePath: string, seen: Set<string>): Promise<string[]> {
  const abs = normalizeAbs(filePath);
  if (seen.has(abs)) return [];
  seen.add(abs);
  let raw: Record<string, unknown>;
  try {
    raw = await readYamlObject(abs);
  } catch {
    return [];
  }
  const files: string[] = [];
  if (!Array.isArray(raw.include)) return files;
  for (const item of raw.include) {
    if (!isPlainObject(item) || typeof item.local !== "string" || item.local.length === 0) {
      continue;
    }
    const includePath = normalizeAbs(path.resolve(path.dirname(abs), item.local));
    files.push(includePath);
    files.push(...(await collectIncludes(includePath, seen)));
  }
  return files;
}

function usesFromDocument(raw: Record<string, unknown>, declaringPath: string): string[] {
  if (!Array.isArray(raw.stages)) return [];
  const files: string[] = [];
  for (const entry of raw.stages) {
    if (isPlainObject(entry) && typeof entry.uses === "string" && entry.uses.length > 0) {
      files.push(normalizeAbs(path.resolve(path.dirname(declaringPath), entry.uses)));
    }
  }
  return files;
}

export function catalogKind(
  raw: Record<string, unknown>,
  filePath: string,
): "pipeline" | "stage" | "task" | "unknown" {
  const base = path.basename(filePath);
  if (base.endsWith(".task.yaml")) return "task";
  if (typeof raw.goal === "string" && raw.stages === undefined && raw.system_prompt === undefined) {
    return "task";
  }
  if (Array.isArray(raw.stages) || raw.include !== undefined) return "pipeline";
  if (typeof raw.system_prompt === "string" || base.endsWith(".stage.yaml")) return "stage";
  return "unknown";
}

async function dialectOf(filePath: string): Promise<YamlDialect | "unreadable"> {
  try {
    const raw = await readYamlObject(filePath);
    return classifyYamlDocument(raw);
  } catch {
    return "unreadable";
  }
}

function verifyFingerprint(items: Record<string, unknown>[]): string {
  return JSON.stringify(items);
}

type UsesCompile = {
  verify: Record<string, unknown>[];
  io?: ReturnType<typeof ioFromSchemas>;
  pipelineIds: string[];
};

function gitToplevel(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function fileDirtyVsHead(absPath: string): boolean {
  const top = gitToplevel(path.dirname(absPath));
  if (top === null) return false;
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--", absPath], {
      cwd: top,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return status.trim().length > 0;
  } catch {
    return true;
  }
}

async function discoverScope(
  targetPath: string,
): Promise<{ pipelines: string[]; stages: string[]; tasks: string[]; extras: string[] }> {
  const abs = normalizeAbs(targetPath);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new Error(`Path not found: ${abs}`);
  }

  const pipelines: string[] = [];
  const stages: string[] = [];
  const tasks: string[] = [];
  const extras: string[] = [];

  if (info.isDirectory()) {
    pipelines.push(...(await walkFiles(abs, (name) => name.endsWith(".pipeline.yaml"))));
    tasks.push(...(await walkFiles(abs, (name) => name.endsWith(".task.yaml"))));
  } else if (info.isFile()) {
    if (isStageflowPath(abs)) {
      throw new Error("sf migrate-yaml does not rewrite .stageflow run snapshots");
    }
    const raw = await readYamlObject(abs);
    const kind = catalogKind(raw, abs);
    if (kind === "pipeline") pipelines.push(abs);
    else if (kind === "stage") stages.push(abs);
    else if (kind === "task") tasks.push(abs);
    else extras.push(abs);
  }

  const includeSeen = new Set<string>();
  for (const pipelinePath of [...pipelines]) {
    const includes = await collectIncludes(pipelinePath, includeSeen);
    extras.push(...includes);
    try {
      const raw = await readYamlObject(pipelinePath);
      stages.push(...usesFromDocument(raw, pipelinePath));
    } catch {
      // load errors reported later
    }
    for (const includePath of includes) {
      try {
        const raw = await readYamlObject(includePath);
        stages.push(...usesFromDocument(raw, includePath));
      } catch {
        // load errors reported later
      }
    }
  }

  const uniq = (files: string[]) =>
    [...new Set(files.map(normalizeAbs))].filter((file) => !isStageflowPath(file));

  return {
    pipelines: uniq(pipelines).sort(),
    stages: uniq(stages).sort(),
    tasks: uniq(tasks).sort(),
    extras: uniq(extras).sort(),
  };
}

function nodeForStage(loaded: LoadedPipeline, stageId: string) {
  return loaded.dag.nodes.find((node) => node.id === stageId);
}

function stageForId(loaded: LoadedPipeline, stageId: string): LoadedStageConfig | undefined {
  return loaded.stages.find((stage) => stage.id === stageId);
}

function compileVerify(
  preEmit: PreEmitCheck[] | undefined,
  afterChecks: CompletionCheck[] | undefined,
): { ok: true; items: Record<string, unknown>[] } | { ok: false; error: string } {
  return buildVerifyItems(preEmit, afterChecks);
}

async function rewriteUsesFile(
  absPath: string,
  compiled: UsesCompile,
): Promise<string> {
  const raw = await readYamlObject(absPath);
  const next = rewriteStageDocument(raw, {
    io: compiled.io,
    verify: compiled.verify,
  });
  return stringifyTargetYaml(next);
}

async function rewriteDeclaringFile(
  absPath: string,
  loaded: LoadedPipeline,
): Promise<{ content: string } | { error: string }> {
  const raw = await readYamlObject(absPath);
  const next = rewriteCatalogDocument(raw, (entry) => {
    const id = typeof entry.id === "string" ? entry.id : undefined;
    if (!id) return entry;
    const node = nodeForStage(loaded, id);
    const stage = stageForId(loaded, id);
    if (!node || !stage) return dropLegacyOnly(entry);
    const uses = typeof entry.uses === "string" ? entry.uses : undefined;
    if (uses) {
      return rewritePipelineStageEntry(entry, {
        uses,
        on_verify_fail: node.recovery,
      });
    }
    const verify = compileVerify(stage.pre_emit_checks, node.completion?.checks);
    if (!verify.ok) {
      throw new Error(verify.error);
    }
    return rewritePipelineStageEntry(entry, {
      io: ioFromSchemas(stage),
      verify: verify.items,
      on_verify_fail: node.recovery,
    });
  });
  return { content: stringifyTargetYaml(next) };
}

function dropLegacyOnly(entry: Record<string, unknown>): Record<string, unknown> {
  return rewritePipelineStageEntry(entry, {
    uses: typeof entry.uses === "string" ? entry.uses : undefined,
  });
}

async function collectUsesCompile(
  loaded: LoadedPipeline,
  cwd: string,
  byPath: Map<string, UsesCompile>,
  errors: string[],
): Promise<void> {
  for (const stage of loaded.stages) {
    const source = loaded.stageSources?.[stage.id];
    if (source?.kind !== "file") continue;
    const abs = normalizeAbs(source.path);
    const node = nodeForStage(loaded, stage.id);
    const afterChecks = node?.completion?.checks;
    const verify = compileVerify(stage.pre_emit_checks, afterChecks);
    if (!verify.ok) {
      errors.push(`${relPath(cwd, abs)}: ${verify.error}`);
      continue;
    }
    const io = ioFromSchemas(stage);
    const existing = byPath.get(abs);
    if (!existing) {
      byPath.set(abs, {
        verify: verify.items,
        io,
        pipelineIds: [loaded.pipeline.id],
      });
      continue;
    }
    if (verifyFingerprint(existing.verify) !== verifyFingerprint(verify.items)) {
      const first = existing.pipelineIds[0] ?? loaded.pipeline.id;
      const second = loaded.pipeline.id;
      errors.push(
        `uses file ${relPath(cwd, abs)} has different compiled verify lists from pipelines "${first}" and "${second}"`,
      );
      existing.pipelineIds.push(loaded.pipeline.id);
      continue;
    }
    existing.pipelineIds.push(loaded.pipeline.id);
  }
}

function shouldRewriteFile(
  dialect: YamlDialect | "unreadable",
  kind: "pipeline" | "stage" | "task" | "unknown",
  foldingWrapper: boolean,
): "rewrite" | "skip-mixed" | "skip" | "skip-unreadable" {
  if (dialect === "unreadable") return "skip-unreadable";
  if (dialect === "invalid") return "skip-mixed";
  if (kind === "task" || kind === "unknown") return "skip";
  if (dialect === "legacy") return "rewrite";
  if (foldingWrapper) return "rewrite";
  return "skip";
}

async function usesPathHasLegacyWrapper(
  usesAbs: string,
  pipelinePaths: string[],
): Promise<boolean> {
  for (const pipelinePath of pipelinePaths) {
    const declaring = [pipelinePath, ...(await collectIncludes(pipelinePath, new Set()))];
    for (const file of declaring) {
      let raw: Record<string, unknown>;
      try {
        raw = await readYamlObject(file);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.stages)) continue;
      for (const entry of raw.stages) {
        if (!isPlainObject(entry) || typeof entry.uses !== "string") continue;
        const abs = normalizeAbs(path.resolve(path.dirname(file), entry.uses));
        if (abs !== usesAbs) continue;
        if (entry.completion !== undefined || entry.recovery !== undefined) return true;
      }
    }
  }
  return false;
}

export async function planMigrateYaml(
  targetPath: string,
  options: { cwd: string; projectRoot?: string } = { cwd: process.cwd() },
): Promise<MigrateYamlPlan> {
  const cwd = options.cwd;
  const projectRoot = options.projectRoot ?? cwd;
  const writesByPath = new Map<string, MigrateYamlWrite>();
  const skipped = new Set<string>();
  const errors: string[] = [];

  let scope;
  try {
    scope = await discoverScope(targetPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { writes: [], skipped: [], errors: [message] };
  }

  const usesCompile = new Map<string, UsesCompile>();
  const declaringFiles = new Map<string, LoadedPipeline>();

  for (const pipelinePath of scope.pipelines) {
    const dialect = await dialectOf(pipelinePath);
    if (dialect === "invalid") {
      skipped.add(relPath(cwd, pipelinePath));
      continue;
    }
    const outcome = await loadPipelineOutcome(pipelinePath, { cwd, projectRoot });
    if (!outcome.ok) {
      if (outcome.issues.some((issue) => issue.code === "catalog.mixed_yaml_dialect")) {
        skipped.add(relPath(cwd, pipelinePath));
        continue;
      }
      errors.push(
        ...outcome.issues.map((issue) => `${relPath(cwd, pipelinePath)}: ${issue.message}`),
      );
      continue;
    }
    declaringFiles.set(normalizeAbs(outcome.value.pipelinePath), outcome.value);
    await collectUsesCompile(outcome.value, cwd, usesCompile, errors);
    for (const includePath of await collectIncludes(pipelinePath, new Set())) {
      declaringFiles.set(normalizeAbs(includePath), outcome.value);
    }
  }

  if (errors.length > 0) {
    return { writes: [], skipped: [...skipped].sort(), errors };
  }

  for (const [abs, compiled] of usesCompile) {
    const dialect = await dialectOf(abs);
    let kind: ReturnType<typeof catalogKind> = "stage";
    try {
      kind = catalogKind(await readYamlObject(abs), abs);
    } catch {
      errors.push(`${relPath(cwd, abs)}: unreadable YAML`);
      continue;
    }
    const folding = await usesPathHasLegacyWrapper(abs, scope.pipelines);
    const action = shouldRewriteFile(dialect, kind, folding);
    if (action === "skip-mixed") {
      skipped.add(relPath(cwd, abs));
      continue;
    }
    if (action !== "rewrite") {
      skipped.add(relPath(cwd, abs));
      continue;
    }
    const content = await rewriteUsesFile(abs, compiled);
    const current = await readFile(abs, "utf8");
    if (current === content) {
      skipped.add(relPath(cwd, abs));
      continue;
    }
    writesByPath.set(abs, { file: relPath(cwd, abs), absPath: abs, content });
  }

  for (const [abs, loaded] of declaringFiles) {
    const dialect = await dialectOf(abs);
    let raw: Record<string, unknown>;
    try {
      raw = await readYamlObject(abs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${relPath(cwd, abs)}: ${message}`);
      continue;
    }
    const kind = catalogKind(raw, abs);
    const action = shouldRewriteFile(dialect, kind, false);
    if (action === "skip-mixed") {
      skipped.add(relPath(cwd, abs));
      continue;
    }
    if (action !== "rewrite") {
      skipped.add(relPath(cwd, abs));
      continue;
    }
    try {
      const rewritten = await rewriteDeclaringFile(abs, loaded);
      if ("error" in rewritten) {
        errors.push(`${relPath(cwd, abs)}: ${rewritten.error}`);
        continue;
      }
      const current = await readFile(abs, "utf8");
      if (current === rewritten.content) {
        skipped.add(relPath(cwd, abs));
        continue;
      }
      writesByPath.set(abs, {
        file: relPath(cwd, abs),
        absPath: abs,
        content: rewritten.content,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${relPath(cwd, abs)}: ${message}`);
    }
  }

  for (const stagePath of scope.stages) {
    if (writesByPath.has(normalizeAbs(stagePath)) || usesCompile.has(normalizeAbs(stagePath))) {
      continue;
    }
    const dialect = await dialectOf(stagePath);
    if (dialect === "invalid") {
      skipped.add(relPath(cwd, stagePath));
      continue;
    }
    if (dialect !== "legacy") {
      skipped.add(relPath(cwd, stagePath));
      continue;
    }
    const outcome = await loadStageOutcome(stagePath, { deferSchemaRefs: true });
    if (!outcome.ok) {
      if (outcome.issues.some((issue) => issue.code === "catalog.mixed_yaml_dialect")) {
        skipped.add(relPath(cwd, stagePath));
        continue;
      }
      errors.push(
        ...outcome.issues.map((issue) => `${relPath(cwd, stagePath)}: ${issue.message}`),
      );
      continue;
    }
    const verify = compileVerify(
      outcome.value.pre_emit_checks,
      afterCompletionForStage(outcome.value)?.checks,
    );
    if (!verify.ok) {
      errors.push(`${relPath(cwd, stagePath)}: ${verify.error}`);
      continue;
    }
    const raw = await readYamlObject(stagePath);
    const content = stringifyTargetYaml(
      rewriteStageDocument(raw, {
        io: ioFromSchemas(outcome.value),
        verify: verify.items,
      }),
    );
    const current = await readFile(stagePath, "utf8");
    if (current === content) {
      skipped.add(relPath(cwd, stagePath));
      continue;
    }
    writesByPath.set(normalizeAbs(stagePath), {
      file: relPath(cwd, stagePath),
      absPath: normalizeAbs(stagePath),
      content,
    });
  }

  for (const taskPath of scope.tasks) {
    skipped.add(relPath(cwd, taskPath));
  }
  for (const extra of scope.extras) {
    if (writesByPath.has(normalizeAbs(extra))) continue;
    const dialect = await dialectOf(extra);
    if (dialect === "legacy") continue;
    skipped.add(relPath(cwd, extra));
  }

  if (errors.length > 0) {
    return { writes: [], skipped: [...skipped].sort(), errors };
  }

  const writes = [...writesByPath.values()].sort((a, b) => a.file.localeCompare(b.file));
  const skippedSorted = [...skipped].filter((file) => !writes.some((write) => write.file === file)).sort();
  return { writes, skipped: skippedSorted, errors: [] };
}

export async function applyMigrateYamlPlan(plan: MigrateYamlPlan): Promise<void> {
  for (const write of plan.writes) {
    await writeFile(write.absPath, write.content);
  }
}
