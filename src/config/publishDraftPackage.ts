import {
  createDraftPackage,
  overwriteDraftPackage,
  type CreateDraftPackageInput,
  type DraftPackageWriteResult,
} from "./draftPackage.js";
import { ensureCatalogScanRoot } from "./ensureCatalogScanRoot.js";

export type PublishDraftPackageMode = "create" | "overwrite" | "auto";

export type PublishDraftPackageResult = {
  write: DraftPackageWriteResult;
  catalogChanged: boolean;
};

export async function publishDraftPackage(
  projectRoot: string,
  input: CreateDraftPackageInput,
  mode: PublishDraftPackageMode,
): Promise<PublishDraftPackageResult> {
  let write: DraftPackageWriteResult;
  if (mode === "create") {
    write = await createDraftPackage(projectRoot, input);
  } else if (mode === "overwrite") {
    write = await overwriteDraftPackage(projectRoot, input);
  } else {
    const created = await createDraftPackage(projectRoot, input);
    if (created.ok || created.status !== 409) {
      write = created;
    } else {
      write = await overwriteDraftPackage(projectRoot, input);
    }
  }

  if (!write.ok) {
    return { write, catalogChanged: false };
  }

  const catalogChanged = await ensureCatalogScanRoot(
    projectRoot,
    input.directory,
  );
  return { write, catalogChanged };
}
