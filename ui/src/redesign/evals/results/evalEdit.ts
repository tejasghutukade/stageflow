import { fetchEval, updateEval } from "../../../api";
import type { EvalDefinition } from "../../../api/evalTypes";

/**
 * Reads the eval fresh, applies one change and saves it against the file hash it read, so an edit made elsewhere in
 * the meantime is refused rather than overwritten. `change` returns null when there is nothing to save.
 */
export async function editEvalDefinition(
  evalId: string,
  change: (definition: EvalDefinition) => EvalDefinition | null,
): Promise<"saved" | "unchanged"> {
  const detail = await fetchEval(evalId);
  const next = detail.definition ? change(detail.definition) : null;
  if (next === null) return "unchanged";
  await updateEval(evalId, { definition: next, base_hash: detail.file_hash });
  return "saved";
}
