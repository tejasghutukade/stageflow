/**
 * Custom Pi tool for writing factory stage artifact files under the run
 * workspace. Paths are relative to
 * `stages/<stageId>/attempts/<attempt>/artifacts/` and must resolve inside
 * that directory.
 *
 * Parameter schemas use `typebox` (Pi's `defineTool` TSchema), not
 * `@sinclair/typebox`. Unlike emit, this tool does not terminate the turn.
 */
import { randomBytes } from "node:crypto";
import { lstat, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import {
  ensureRealArtifactsDir,
  isInsideDir,
  resolveArtifactTarget,
  resolveContainedParent,
} from "../runstore/workspaceLayout.js";

export type WriteStageArtifactOptions = {
  runWorkspaceDir: string;
  stageId: string;
  attempt: number;
};

function toolResult(
  text: string,
  details: { path: string; error: string },
  options?: { isError?: boolean },
) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    ...(options?.isError ? { isError: true } : {}),
  };
}

async function assertSafeWriteTarget(targetPath: string): Promise<void> {
  try {
    const st = await lstat(targetPath);
    if (st.isSymbolicLink()) {
      throw new Error("path escapes the stage artifacts directory");
    }
    if (st.nlink > 1) {
      throw new Error("refusing to overwrite hard-linked file");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

async function writeContainedArtifact(
  runWorkspaceDir: string,
  artifactsDirectory: string,
  absolutePath: string,
  content: string,
): Promise<void> {
  const { realArtifacts } = await ensureRealArtifactsDir(
    runWorkspaceDir,
    artifactsDirectory,
  );
  const relativeToArtifacts = path.relative(artifactsDirectory, absolutePath);
  const parent = await resolveContainedParent(
    realArtifacts,
    relativeToArtifacts,
  );
  const baseName = path.basename(absolutePath);
  const targetPath = path.join(parent, baseName);
  await assertSafeWriteTarget(targetPath);

  const tmpName = `.sf-artifact-${randomBytes(8).toString("hex")}.tmp`;
  const tmpPath = path.join(parent, tmpName);
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  const realWritten = await realpath(targetPath);
  if (!isInsideDir(realWritten, realArtifacts)) {
    throw new Error("path escapes the stage artifacts directory");
  }
}

export function createWriteStageArtifactTool(options: WriteStageArtifactOptions) {
  const { runWorkspaceDir, stageId, attempt } = options;

  return {
    name: "write_stage_artifact",
    label: "Write stage artifact",
    description:
      "Write a factory artifact file under this stage attempt's artifacts directory in the run workspace. Pass a path relative to stages/<stageId>/attempts/<attempt>/artifacts/ and the file content. Returns the run-relative path to include in emit_stage_envelope artifacts.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      try {
        if (params === null || typeof params !== "object") {
          throw new Error("parameters must be an object");
        }
        const record = params as Record<string, unknown>;
        if (typeof record.path !== "string") {
          throw new Error("path must be a string");
        }
        if (typeof record.content !== "string") {
          throw new Error("content must be a string");
        }

        const { absolutePath, runRelativePath, artifactsDir } =
          resolveArtifactTarget(runWorkspaceDir, stageId, attempt, record.path);
        await writeContainedArtifact(
          runWorkspaceDir,
          artifactsDir,
          absolutePath,
          record.content,
        );
        return toolResult(`Wrote artifact: ${runRelativePath}`, {
          path: runRelativePath,
          error: "",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolResult(`Failed to write artifact: ${message}`, {
          path: "",
          error: message,
        }, { isError: true });
      }
    },
  };
}
