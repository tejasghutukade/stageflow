import {
  loadDraftPackage,
  validateDraftPackage,
  type DraftFileHashes,
  type DraftPackage,
} from "../config/draftPackage.js";
import { publishDraftPackage } from "../config/publishDraftPackage.js";

export { loadDraftPackage, validateDraftPackage, type DraftPackage };

export type PublishFacadeResult =
  | {
      ok: true;
      pipelinePath: string;
      stagePaths: string[];
      taskPath?: string;
      fileHashes: DraftFileHashes;
    }
  | {
      ok: false;
      error: string;
      status: number;
      code?: string;
      fileHashes?: DraftFileHashes;
    };

/** Write a package the way the Workshop's save does, flattening its result shape. */
export async function publishDraftPackageFacade(
  projectRoot: string,
  input: {
    directory: string;
    draft: DraftPackage;
    pipelineFilename: string;
    allowInvalid?: boolean;
    baseHashes?: DraftFileHashes;
  },
  mode: "create" | "overwrite",
): Promise<PublishFacadeResult> {
  const { write } = await publishDraftPackage(projectRoot, input, mode);
  if (!write.ok) {
    return {
      ok: false,
      error: write.error,
      status: write.status,
      ...(write.code ? { code: write.code } : {}),
      ...(write.fileHashes ? { fileHashes: write.fileHashes } : {}),
    };
  }
  return {
    ok: true,
    pipelinePath: write.pipelinePath,
    stagePaths: write.stagePaths,
    fileHashes: write.fileHashes,
    ...(write.taskPath !== undefined ? { taskPath: write.taskPath } : {}),
  };
}
