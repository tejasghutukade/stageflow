import { useEffect, useMemo, useRef, useState } from "react";
import { fetchEvalDraftEstimate, validateEval } from "../../../api/evalsClient";
import type { EvalRunEstimate } from "../../../api/evalTypes";
import type { ValidationFinding } from "../../../api/types";
import {
  buildDefinition,
  draftDatasetCases,
  evalDirFromFindings,
  inferDirs,
  type WizardDraft,
  type WriteDirs,
  type WriteRootsInfo,
} from "./wizardModel";

export const PREVIEW_DEBOUNCE_MS = 300;

export type WizardPreview = {
  yaml: string;
  findings: ValidationFinding[];
  loading: boolean;
  error: string | null;
  estimate: EvalRunEstimate | null;
};

/** Debounced `POST /api/evals/validate` with the draft; nothing is written. Also learns the evals directory. */
export function useWizardPreview(draft: WizardDraft, datasetPaths: readonly string[], enabled: boolean, writeRoots: WriteRootsInfo | null = null) {
  const [evalDir, setEvalDir] = useState<string | null>(null);
  const dirs: WriteDirs = useMemo(() => inferDirs(evalDir, datasetPaths, writeRoots), [evalDir, datasetPaths, writeRoots]);
  const definition = useMemo(() => buildDefinition(draft, dirs), [draft, dirs]);
  const cases = draftDatasetCases(draft);
  const key = JSON.stringify([definition, cases ?? null]);
  const [preview, setPreview] = useState<WizardPreview>({ yaml: "", findings: [], loading: false, error: null, estimate: null });
  const seq = useRef(0);
  const root = draft.target?.projectRoot;

  useEffect(() => {
    if (!enabled || !definition) {
      setPreview({ yaml: "", findings: [], loading: false, error: null, estimate: null });
      return;
    }
    const mine = ++seq.current;
    setPreview((p) => ({ ...p, loading: true }));
    const timer = window.setTimeout(() => {
      const base = { ...(root ? { project_root: root } : {}), ...(cases ? { dataset_cases: cases } : {}) };
      const estimate = fetchEvalDraftEstimate({ definition, ...base }).catch(() => null);
      validateEval({ definition, ...base }).then(
        async (res) => {
          const est = await estimate;
          if (mine !== seq.current) return;
          const found = writeRoots ? null : evalDirFromFindings(res.findings);
          if (found !== null && found !== dirs.evals) setEvalDir(found);
          setPreview({ yaml: res.derived_yaml, findings: res.findings, loading: false, error: null, estimate: est });
        },
        (err: unknown) => {
          if (mine !== seq.current) return;
          setPreview((p) => ({ ...p, loading: false, error: err instanceof Error ? err.message : String(err) }));
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, root, writeRoots]);

  return { preview, dirs };
}
