import { useEffect, useMemo, useState } from "react";
import {
  fetchCatalogFile,
  fetchCatalogRoots,
  fetchModels,
  fetchPipelines,
  type CatalogModel,
} from "../../../api";
import { fetchEvalDatasets, fetchEvals } from "../../../api/evalsClient";
import type { EvalDatasetListItem, EvalListItem } from "../../../api/evalTypes";
import { stageInputFields, type StageInputField } from "./stageInput";
import { buildStageRows, type StageRow, type WizardTarget, type WriteRootsInfo } from "./wizardModel";

export type WizardData = {
  loading: boolean;
  error: string | null;
  rows: StageRow[];
  evals: EvalListItem[];
  datasets: EvalDatasetListItem[];
  models: CatalogModel[];
  writeRoots: WriteRootsInfo | null;
};

export function useWizardData(): WizardData {
  const [state, setState] = useState<WizardData>({ loading: true, error: null, rows: [], evals: [], datasets: [], models: [], writeRoots: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [pipelines, roots, evals, datasets, models] = await Promise.all([
        fetchPipelines(),
        fetchCatalogRoots().catch(() => ({ roots: [] })),
        fetchEvals().catch(() => null),
        fetchEvalDatasets().catch(() => null),
        fetchModels().catch(() => null),
      ]);
      const readOnly = new Set(roots.roots.filter((r) => r.read_only).map((r) => r.project_root));
      return {
        loading: false,
        error: null,
        rows: buildStageRows(pipelines.pipelines, readOnly),
        evals: evals?.items ?? [],
        datasets: datasets?.items ?? [],
        writeRoots: evals?.write_roots ?? null,
        models: models ? models.providers.flatMap((p) => p.models) : [],
      };
    })().then(
      (next) => {
        if (!cancelled) setState(next);
      },
      (err) => {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/** Reads the stage's `io.input` fields from its pipeline and stage files. `undefined` while loading. */
export function useStageFields(target: WizardTarget | null, row: StageRow | null): StageInputField[] | null | undefined {
  const [fields, setFields] = useState<StageInputField[] | null | undefined>(undefined);
  const key = target ? `${target.projectRoot ?? ""}|${target.kind}|${target.pipelinePath ?? target.file}|${target.stageId}` : "";

  useEffect(() => {
    if (!target) {
      setFields(undefined);
      return;
    }
    let cancelled = false;
    setFields(undefined);
    const root = target.projectRoot ? { project_root: target.projectRoot } : {};
    const read = (path: string | undefined) =>
      path ? fetchCatalogFile({ path, ...root }).then((r) => r.content, () => undefined) : Promise.resolve(undefined);
    Promise.all([read(target.pipelinePath ?? row?.pipelines[0]?.path), read(row?.usesPath ?? target.file)]).then(([pipelineYaml, stageYaml]) => {
      if (cancelled) return;
      setFields(
        stageInputFields({
          stageId: target.stageId,
          ...(pipelineYaml !== undefined ? { pipelineYaml } : {}),
          ...(stageYaml !== undefined ? { stageYaml } : {}),
        }),
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return fields;
}

export function useTakenIds(data: WizardData) {
  return useMemo(
    () => ({
      evalIds: data.evals.map((e) => e.id),
      datasetNames: data.datasets.map((d) => d.id),
    }),
    [data.evals, data.datasets],
  );
}
