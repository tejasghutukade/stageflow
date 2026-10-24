import { useEffect, useRef, useState } from "react";
import { validateEval } from "../../../api/evalsClient";
import type { EvalDefinition } from "../../../api/evalTypes";
import type { ValidationFinding } from "../../../api/types";
import { PREVIEW_DEBOUNCE_MS } from "../newEval/useWizardPreview";
import type { EditState } from "./editModel";

export type EditPreview = {
  yaml: string;
  findings: ValidationFinding[];
  definition: EvalDefinition | null;
  loading: boolean;
  error: string | null;
};

const EMPTY: EditPreview = { yaml: "", findings: [], definition: null, loading: false, error: null };

/** Debounced `POST /api/evals/validate` for the draft (form) or the YAML text (YAML mode). */
export function useEditPreview(state: EditState | null): EditPreview {
  const [preview, setPreview] = useState<EditPreview>(EMPTY);
  const seq = useRef(0);
  const input = state === null ? null : state.mode === "yaml" ? { yaml: state.yamlText } : state.draft ? { definition: state.draft } : null;
  const key = JSON.stringify(input);

  useEffect(() => {
    if (input === null) {
      setPreview(EMPTY);
      return;
    }
    const mine = ++seq.current;
    setPreview((p) => ({ ...p, loading: true }));
    const timer = window.setTimeout(() => {
      validateEval(input).then(
        (res) => {
          if (mine === seq.current) setPreview({ yaml: res.derived_yaml, findings: res.findings, definition: res.definition, loading: false, error: null });
        },
        (err: unknown) => {
          if (mine === seq.current) setPreview((p) => ({ ...p, loading: false, error: err instanceof Error ? err.message : String(err) }));
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return preview;
}
