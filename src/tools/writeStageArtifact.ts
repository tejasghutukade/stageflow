/**
 * Custom Pi tool for writing factory stage artifact files under the run
 * workspace. Paths are relative to
 * `stages/<stageId>/attempts/<attempt>/artifacts/` and must resolve inside
 * that directory.
 *
 * Parameter schemas use `typebox` (Pi's `defineTool` TSchema), not
 * `@sinclair/typebox`. Unlike emit, this tool does not terminate the turn.
 */
import { Type } from "typebox";
import { resolveArtifactTarget } from "../runstore/workspaceLayout.js";
import { writeContainedArtifact } from "../runstore/writeContainedArtifact.js";

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
