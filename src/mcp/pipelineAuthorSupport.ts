import { loadDraftPackage, validateDraftPackage, type DraftPackage } from "../config/draftPackage.js";
import { publishDraftPackage } from "../config/publishDraftPackage.js";

export { loadDraftPackage, validateDraftPackage, type DraftPackage };

export type PublishFacadeResult =
  | { ok: true; pipelinePath: string; stagePaths: string[]; taskPath?: string }
  | { ok: false; error: string; status: number };

/** Write a package the way the Workshop's save does, flattening its result shape. */
export async function publishDraftPackageFacade(
  projectRoot: string,
  input: { directory: string; draft: DraftPackage; pipelineFilename: string; allowInvalid?: boolean },
  mode: "create" | "overwrite",
): Promise<PublishFacadeResult> {
  const { write } = await publishDraftPackage(projectRoot, input, mode);
  if (!write.ok) return { ok: false, error: write.error, status: write.status };
  return { ok: true, pipelinePath: write.pipelinePath, stagePaths: write.stagePaths, ...(write.taskPath !== undefined ? { taskPath: write.taskPath } : {}) };
}
