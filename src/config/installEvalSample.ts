import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { isMap, parseDocument } from "yaml";
import { EvalsWriteError, writeFileAtomic } from "./atomicWrite.js";
import { ensureCatalogScanRoot, type CatalogScanKey } from "./ensureCatalogScanRoot.js";
import {
  explicitRoots,
  findEvalFile,
  manifestForWrite,
  resolveWriteDir,
  type WriteRootKind,
} from "./evalWriteRoots.js";
import { resolveSeededExamplesPath } from "./seededCatalog.js";

export const EVAL_SAMPLE_FILES = {
  pipeline: "eval-sample.pipeline.yaml",
  eval: "critique-sample.eval.yaml",
  dataset: "critique-sample.dataset.jsonl",
} as const;

export const EVAL_SAMPLE_ID = "critique-sample";

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

function rewriteEvalPaths(text: string, pipelineRef: string, datasetRef: string): string {
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) throw new EvalsWriteError("SAMPLE_SOURCE_MISSING", "Sample eval file is not a mapping");
  doc.setIn(["target", "pipeline"], pipelineRef);
  doc.set("dataset", datasetRef);
  const out = doc.toString({ lineWidth: 0 });
  return out.endsWith("\n") ? out : `${out}\n`;
}

export async function installEvalSample(input: {
  projectRoot: string;
  sourceDir?: string;
}): Promise<{ evalId: string }> {
  const { projectRoot } = input;
  const sourceDir =
    input.sourceDir ??
    (() => {
      const examples = resolveSeededExamplesPath();
      return examples === undefined ? undefined : path.join(examples, "evals");
    })();
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
  await writeFileAtomic(targets.pipeline, texts.pipeline);
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
