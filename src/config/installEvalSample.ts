import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, parse as parseYaml, parseDocument } from "yaml";
import type { AgentDetail } from "../agents/service.js";
import { isAgentError } from "../agents/errors.js";
import { EvalsWriteError, writeFileAtomic } from "./atomicWrite.js";
import { ensureCatalogScanRoot, type CatalogScanKey } from "./ensureCatalogScanRoot.js";
import {
  explicitRoots,
  findEvalFile,
  manifestForWrite,
  resolveWriteDir,
  type WriteRootKind,
} from "./evalWriteRoots.js";
import { peekDefaultModel } from "../models/catalog.js";
import { loadStageflowManifestOutcome } from "./loadStageflowManifest.js";
import { resolveSeededExamplesPath } from "./seededCatalog.js";

export const EVAL_SAMPLE_FILES = {
  pipeline: "eval-sample.pipeline.yaml",
  eval: "critique-sample.eval.yaml",
  dataset: "critique-sample.dataset.jsonl",
} as const;

export const EVAL_SAMPLE_ID = "critique-sample";

export const AGENT_EVAL_SAMPLE_FILES = {
  agent: "support-sample.agent.yaml",
  eval: "support-sample.eval.yaml",
  dataset: "support-sample.dataset.jsonl",
} as const;

export const AGENT_EVAL_SAMPLE_ID = "support-sample";
export const AGENT_EVAL_SAMPLE_AGENT_ID = "support_sample";

export type EvalSampleKind = "stage" | "agent";

/** The slice of `AgentService` the agent sample install needs. */
export type EvalSampleAgents = {
  get(projectRoot: string, agentId: string): Promise<AgentDetail>;
  create(projectRoot: string, rawInput: unknown, actor: { source: "api" }): Promise<AgentDetail>;
  setEnabled(projectRoot: string, agentId: string, enabled: boolean, actor: { source: "api" }): Promise<AgentDetail>;
};

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

function relativeRef(fromDir: string, toFile: string): string {
  const rel = path.relative(fromDir, toFile).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function rewriteEvalPaths(text: string, pipelineRef: string | undefined, datasetRef: string): string {
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) throw new EvalsWriteError("SAMPLE_SOURCE_MISSING", "Sample eval file is not a mapping");
  if (pipelineRef !== undefined) doc.setIn(["target", "pipeline"], pipelineRef);
  doc.set("dataset", datasetRef);
  const out = doc.toString({ lineWidth: 0 });
  return out.endsWith("\n") ? out : `${out}\n`;
}

export function resolveEvalSampleDir(
  fromUrl: string = import.meta.url,
  marker: string = EVAL_SAMPLE_FILES.eval,
): string | undefined {
  const examples = resolveSeededExamplesPath(fromUrl);
  const here = path.dirname(fileURLToPath(fromUrl));
  const candidates = [
    ...(examples === undefined ? [] : [path.join(examples, "evals")]),
    path.resolve(here, "../../examples/evals"),
    path.resolve(here, "../../../examples/evals"),
    path.resolve(process.cwd(), "examples/evals"),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, marker)));
}

export async function installEvalSample(input: {
  projectRoot: string;
  sourceDir?: string;
  kind?: EvalSampleKind;
  agents?: EvalSampleAgents;
}): Promise<{ evalId: string }> {
  if (input.kind === "agent") return installAgentEvalSample(input);
  const { projectRoot } = input;
  const sourceDir = input.sourceDir ?? resolveEvalSampleDir();
  if (sourceDir === undefined) {
    throw new EvalsWriteError("SAMPLE_SOURCE_MISSING", "The packaged sample files were not found");
  }

  const sources = {
    pipeline: path.join(sourceDir, EVAL_SAMPLE_FILES.pipeline),
    eval: path.join(sourceDir, EVAL_SAMPLE_FILES.eval),
    dataset: path.join(sourceDir, EVAL_SAMPLE_FILES.dataset),
  };
  const texts: Record<keyof typeof sources, string> = { pipeline: "", eval: "", dataset: "" };
  for (const key of Object.keys(sources) as Array<keyof typeof sources>) {
    try {
      texts[key] = await readFile(sources[key], "utf8");
    } catch {
      throw new EvalsWriteError("SAMPLE_SOURCE_MISSING", `Sample file ${EVAL_SAMPLE_FILES[key]} not found in ${sourceDir}`);
    }
  }

  const manifest = await manifestForWrite(projectRoot);
  const dirs = {
    pipeline: await resolveWriteDir(projectRoot, manifest, "pipelines"),
    eval: await resolveWriteDir(projectRoot, manifest, "evals"),
    dataset: await resolveWriteDir(projectRoot, manifest, "datasets"),
  };
  const targets = {
    pipeline: path.join(dirs.pipeline.absDir, EVAL_SAMPLE_FILES.pipeline),
    eval: path.join(dirs.eval.absDir, EVAL_SAMPLE_FILES.eval),
    dataset: path.join(dirs.dataset.absDir, EVAL_SAMPLE_FILES.dataset),
  };

  const taken =
    (await findEvalFile(projectRoot, EVAL_SAMPLE_ID, manifest)) !== undefined ||
    (await exists(targets.pipeline)) ||
    (await exists(targets.eval)) ||
    (await exists(targets.dataset));
  if (taken) throw new EvalsWriteError("SAMPLE_EXISTS", "The sample eval is already installed");

  const evalText = rewriteEvalPaths(
    texts.eval,
    relativeRef(dirs.eval.absDir, targets.pipeline),
    relativeRef(dirs.eval.absDir, targets.dataset),
  );
  const projectManifest = await loadStageflowManifestOutcome(projectRoot);
  const hasDefaultModel = projectManifest.ok && projectManifest.value.manifest.model !== undefined;
  const pipelineText = hasDefaultModel
    ? texts.pipeline
    : texts.pipeline.replace(/^id: .*\n/m, (line) => `${line}model: ${peekDefaultModel()}\n`);
  await writeFileAtomic(targets.pipeline, pipelineText);
  await writeFileAtomic(targets.dataset, texts.dataset);
  await writeFileAtomic(targets.eval, evalText);

  const scanKeys: Record<keyof typeof dirs, { kind: WriteRootKind; key: CatalogScanKey }> = {
    pipeline: { kind: "pipelines", key: "pipelines" },
    eval: { kind: "evals", key: "evals" },
    dataset: { kind: "datasets", key: "datasets" },
  };
  for (const name of Object.keys(dirs) as Array<keyof typeof dirs>) {
    const { kind, key } = scanKeys[name];
    if (explicitRoots(manifest, kind) !== undefined) {
      await ensureCatalogScanRoot(projectRoot, dirs[name].relDir, [key]);
    }
  }
  return { evalId: EVAL_SAMPLE_ID };
}

async function agentExists(agents: EvalSampleAgents, projectRoot: string): Promise<boolean> {
  try {
    await agents.get(projectRoot, AGENT_EVAL_SAMPLE_AGENT_ID);
    return true;
  } catch (err) {
    if (isAgentError(err) && err.code === "agent.not_found") return false;
    throw err;
  }
}

async function installAgentEvalSample(input: {
  projectRoot: string;
  sourceDir?: string;
  agents?: EvalSampleAgents;
}): Promise<{ evalId: string }> {
  const { projectRoot, agents } = input;
  const sourceDir =
    input.sourceDir ?? resolveEvalSampleDir(undefined, AGENT_EVAL_SAMPLE_FILES.eval);
  if (sourceDir === undefined) {
    throw new EvalsWriteError("SAMPLE_SOURCE_MISSING", "The packaged sample files were not found");
  }
  if (agents === undefined) {
    throw new EvalsWriteError("SAMPLE_AGENTS_UNAVAILABLE", "Agents are not available on this Host");
  }
  const texts: Record<keyof typeof AGENT_EVAL_SAMPLE_FILES, string> = { agent: "", eval: "", dataset: "" };
  for (const key of Object.keys(AGENT_EVAL_SAMPLE_FILES) as Array<keyof typeof AGENT_EVAL_SAMPLE_FILES>) {
    try {
      texts[key] = await readFile(path.join(sourceDir, AGENT_EVAL_SAMPLE_FILES[key]), "utf8");
    } catch {
      throw new EvalsWriteError(
        "SAMPLE_SOURCE_MISSING",
        `Sample file ${AGENT_EVAL_SAMPLE_FILES[key]} not found in ${sourceDir}`,
      );
    }
  }

  const projectManifest = await loadStageflowManifestOutcome(projectRoot);
  if (!projectManifest.ok || projectManifest.value.manifest.model === undefined) {
    throw new EvalsWriteError(
      "SAMPLE_NO_DEFAULT_MODEL",
      "The agent sample needs a default model. Set model in stageflow.yaml, then install the sample again.",
    );
  }

  const manifest = await manifestForWrite(projectRoot);
  const dirs = {
    eval: await resolveWriteDir(projectRoot, manifest, "evals"),
    dataset: await resolveWriteDir(projectRoot, manifest, "datasets"),
  };
  const targets = {
    eval: path.join(dirs.eval.absDir, AGENT_EVAL_SAMPLE_FILES.eval),
    dataset: path.join(dirs.dataset.absDir, AGENT_EVAL_SAMPLE_FILES.dataset),
  };
  const taken =
    (await findEvalFile(projectRoot, AGENT_EVAL_SAMPLE_ID, manifest)) !== undefined ||
    (await exists(targets.eval)) ||
    (await exists(targets.dataset)) ||
    (await agentExists(agents, projectRoot));
  if (taken) throw new EvalsWriteError("SAMPLE_EXISTS", "The sample eval is already installed");

  const agentDefinition = parseYaml(texts.agent) as Record<string, unknown>;
  const evalText = rewriteEvalPaths(texts.eval, undefined, relativeRef(dirs.eval.absDir, targets.dataset));

  await agents.create(projectRoot, { ...agentDefinition, web_chat: { enabled: false } }, { source: "api" });
  await agents.setEnabled(projectRoot, AGENT_EVAL_SAMPLE_AGENT_ID, true, { source: "api" });
  await writeFileAtomic(targets.dataset, texts.dataset);
  await writeFileAtomic(targets.eval, evalText);

  const scanKeys = { eval: "evals", dataset: "datasets" } as const;
  for (const name of Object.keys(dirs) as Array<keyof typeof dirs>) {
    if (explicitRoots(manifest, scanKeys[name]) !== undefined) {
      await ensureCatalogScanRoot(projectRoot, dirs[name].relDir, [scanKeys[name]]);
    }
  }
  return { evalId: AGENT_EVAL_SAMPLE_ID };
}
