import type { EvalCreateDatasetInput, EvalDefinition } from "../../../api/evalTypes";
import {
  buildDefinition,
  datasetFilePath,
  datasetTarget,
  type WizardDraft,
  type WriteDirs,
} from "./wizardModel";

export type CreateDeps = {
  createDataset: (input: EvalCreateDatasetInput) => Promise<unknown>;
  createEval: (input: { project_root?: string; definition: EvalDefinition; directory?: string }) => Promise<{ id: string }>;
};

export type CreateOutcome =
  | { ok: true; evalId: string }
  | { ok: false; message: string; datasetWritten: boolean };

function errorText(err: unknown): string {
  return err instanceof Error && err.message !== "" ? err.message : "Request failed";
}

export function datasetInput(draft: WizardDraft, dirs: WriteDirs): EvalCreateDatasetInput | null {
  const ds = draft.dataset;
  const t = draft.target;
  if (!ds || !t) return null;
  const common = { name: ds.name, directory: dirs.datasets, ...(t.projectRoot ? { project_root: t.projectRoot } : {}) };
  if (ds.source === "sample") return { ...common, source: "sample", target: datasetTarget(t) };
  if (ds.source === "sessions") return { ...common, source: "sessions", target: { agent_id: t.agentId ?? t.stageId }, session_ids: ds.runIds };
  if (ds.source === "runs") return { ...common, source: "runs", target: datasetTarget(t), run_ids: ds.runIds };
  return { ...common, cases: ds.cases ?? [] };
}

/** Writes the dataset first, then the eval. A failed eval write keeps the dataset and says so. */
export async function createFromDraft(
  draft: WizardDraft,
  dirs: WriteDirs,
  deps: CreateDeps,
  opts: { datasetAlreadyWritten?: boolean } = {},
): Promise<CreateOutcome> {
  const definition = buildDefinition(draft, dirs);
  const input = datasetInput(draft, dirs);
  if (!definition || !input || !draft.dataset) return { ok: false, message: "The draft is incomplete.", datasetWritten: false };
  let datasetWritten = opts.datasetAlreadyWritten === true;
  if (!datasetWritten) {
    try {
      await deps.createDataset(input);
      datasetWritten = true;
    } catch (err) {
      return { ok: false, message: `The dataset could not be written: ${errorText(err)}`, datasetWritten: false };
    }
  }
  try {
    const root = draft.target?.projectRoot;
    const created = await deps.createEval({ ...(root ? { project_root: root } : {}), definition, directory: dirs.evals });
    return { ok: true, evalId: created.id };
  } catch (err) {
    const path = datasetFilePath(dirs, draft.dataset.name);
    return {
      ok: false,
      message: `The dataset was saved to ${path}, but the eval could not be created: ${errorText(err)}`,
      datasetWritten: true,
    };
  }
}
