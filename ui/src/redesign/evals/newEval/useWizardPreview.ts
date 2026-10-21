import { useEffect, useMemo, useRef, useState } from "react";
import { validateEval } from "../../../api/evalsClient";
import type { ValidationFinding } from "../../../api/types";
import {
  buildDefinition,
  evalDirFromFindings,
  inferDirs,
  type WizardDraft,
  type WriteDirs,
} from "./wizardModel";

export const PREVIEW_DEBOUNCE_MS = 300;

export type WizardPreview = {
  yaml: string;
  findings: ValidationFinding[];
  loading: boolean;
  error: string | null;
};

/** Debounced `POST /api/evals/validate` with the draft; nothing is written. Also learns the evals directory. */
export function useWizardPreview(draft: WizardDraft, datasetPaths: readonly string[], enabled: boolean) {
  const [evalDir, setEvalDir] = useState<string | null>(null);
  const dirs: WriteDirs = useMemo(() => inferDirs(evalDir, datasetPaths), [evalDir, datasetPaths]);
  const definition = useMemo(() => buildDefinition(draft, dirs), [draft, dirs]);
  const key = JSON.stringify(definition);
  const [preview, setPreview] = useState<WizardPreview>({ yaml: "", findings: [], loading: false, error: null });
  const seq = useRef(0);
  const root = draft.target?.projectRoot;

  useEffect(() => {
    if (!enabled || !definition) {
      setPreview({ yaml: "", findings: [], loading: false, error: null });
      return;
    }
    const mine = ++seq.current;
    setPreview((p) => ({ ...p, loading: true }));
    const timer = window.setTimeout(() => {
      validateEval({ definition, ...(root ? { project_root: root } : {}) }).then(
        (res) => {
          if (mine !== seq.current) return;
          const found = evalDirFromFindings(res.findings);
          if (found !== null && found !== dirs.evals) setEvalDir(found);
          setPreview({ yaml: res.derived_yaml, findings: res.findings, loading: false, error: null });
        },
        (err: unknown) => {
          if (mine !== seq.current) return;
          setPreview((p) => ({ ...p, loading: false, error: err instanceof Error ? err.message : String(err) }));
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, root]);

  return { preview, dirs };
}
