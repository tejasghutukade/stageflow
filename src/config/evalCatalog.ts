import { stat } from "node:fs/promises";
import path from "node:path";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import { getModelCatalog } from "../models/catalog.js";
import { loadDatasetFile } from "./loadDataset.js";
import { loadEvalOutcome, resolveEvalPaths, type LoadedEval } from "./loadEval.js";
import type { LoadOutcome } from "./loadOutcome.js";
import { scanCatalogPaths, type CatalogPathKind } from "./scanCatalogPaths.js";
import type { ValidationFinding } from "./validateCatalog.js";
import {
  evalFindingsFromIssues,
  validateEval,
  type DatasetReport,
} from "./validateEval.js";

export type CatalogFileRef = { absPath: string; relPath: string };

async function listFiles(
  manifest: LoadedManifest,
  kind: CatalogPathKind,
): Promise<CatalogFileRef[]> {
  const absPaths = await scanCatalogPaths(manifest, kind);
  return absPaths.map((absPath) => ({
    absPath,
    relPath: path.relative(manifest.projectRoot, absPath).split(path.sep).join("/"),
  }));
}

export function listEvalFiles(manifest: LoadedManifest): Promise<CatalogFileRef[]> {
  return listFiles(manifest, "eval");
}

export function listDatasetFiles(manifest: LoadedManifest): Promise<CatalogFileRef[]> {
  return listFiles(manifest, "dataset");
}

export type EvalCatalogEntry = {
  absPath: string;
  relPath: string;
  outcome: LoadOutcome<LoadedEval>;
  findings: ValidationFinding[];
};

export type LoadEvalCatalogOptions = {
  isKnownModel?: (id: string) => Promise<boolean>;
  datasetReportFor?: (loaded: LoadedEval) => Promise<DatasetReport | undefined>;
};

export async function loadEvalCatalog(
  manifest: LoadedManifest,
  options: LoadEvalCatalogOptions = {},
): Promise<EvalCatalogEntry[]> {
  const refs = await listEvalFiles(manifest);
  const { projectRoot } = manifest;
  const isKnownModel =
    options.isKnownModel ??
    (async (id: string): Promise<boolean> => {
      try {
        const { models } = await getModelCatalog(projectRoot).snapshot();
        return models.length === 0 || models.includes(id);
      } catch {
        return true;
      }
    });

  const datasetReportFor =
    options.datasetReportFor ??
    (async (evalFile: LoadedEval): Promise<DatasetReport | undefined> => {
      const { datasetPath } = resolveEvalPaths(evalFile.file, evalFile.path);
      try {
        await stat(datasetPath);
      } catch {
        return undefined;
      }
      return loadDatasetFile(datasetPath, { root: projectRoot });
    });

  const loaded = await Promise.all(
    refs.map(async (ref) => ({ ref, outcome: await loadEvalOutcome(ref.absPath, projectRoot) })),
  );
  const evals = loaded.flatMap(({ ref, outcome }) =>
    outcome.ok ? [{ id: outcome.value.id, absPath: ref.absPath }] : [],
  );

  const entries: EvalCatalogEntry[] = [];
  for (const { ref, outcome } of loaded) {
    let findings: ValidationFinding[];
    if (outcome.ok) {
      const datasetReport = await datasetReportFor(outcome.value);
      findings = await validateEval(outcome.value, {
        projectRoot,
        evals,
        isKnownModel,
        ...(datasetReport !== undefined ? { datasetReport } : {}),
      });
      if (datasetReport !== undefined) findings.push(...datasetReport.findings);
    } else {
      findings = evalFindingsFromIssues(ref.relPath, outcome.issues);
    }
    entries.push({ absPath: ref.absPath, relPath: ref.relPath, outcome, findings });
  }
  return entries;
}
