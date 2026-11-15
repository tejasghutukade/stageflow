import type { McpServer } from "@modelcontextprotocol/server";
import type { McpToolDeps } from "./deps.js";
import {
  listCheckoutChanges,
  getRunDiff,
  readCheckoutFileBytes,
} from "../runread/checkout.js";
import type {
  CheckoutVisibilityError,
} from "../runread/checkout.js";
import { classifyArtifactContent } from "../runread/readArtifact.js";
import { readRunArtifactBytes } from "../runread/readArtifact.js";
import { mapStoreLookupError } from "../server/operatorResults.js";
import { imageResult, textResult } from "./toolResults.js";
import { runFilesFlatSchema } from "../toolkit/runToolModes.js";

function visibilityErrorResult(err: CheckoutVisibilityError) {
  return textResult(
    { error: err.error, code: err.code, status: err.status },
    true,
  );
}

export function registerCheckoutTools(
  server: McpServer,
  deps: McpToolDeps,
): void {
  const { store } = deps;

  server.registerTool(
    "run_files",
    {
      description:
        "Read run workspace files and checkout. view: artifact — run artifact path; changes — dirty paths; diff — git diff against base; file — read a checkout file.",
      inputSchema: runFilesFlatSchema,
    },
    async ({ runId, view, path: filePath, mode, maxBytes }) => {
      if (view === "artifact") {
        try {
          const bytes = await readRunArtifactBytes(store, runId, filePath!);
          const classified = classifyArtifactContent(filePath!, bytes);
          if (classified.kind === "image") {
            return imageResult(classified.mimeType, bytes, {
              runId,
              path: filePath!,
              mimeType: classified.mimeType,
            });
          }
          if (classified.kind === "utf8") {
            return textResult({ runId, path: filePath, content: bytes.toString("utf8") });
          }
          return textResult({ error: "Artifact is not valid UTF-8 text", status: 400 }, true);
        } catch (err) {
          const mapped = mapStoreLookupError(err, { policy: "artifact" });
          return textResult({ error: mapped.error, status: mapped.status }, true);
        }
      }
      if (view === "changes") {
        try {
          const result = await listCheckoutChanges(store, runId);
          if (!result.ok) return visibilityErrorResult(result);
          return textResult({ runId, changes: result.changes, truncated: result.truncated });
        } catch (err) {
          const mapped = mapStoreLookupError(err, { policy: "run" });
          return textResult({ error: mapped.error, status: mapped.status }, true);
        }
      }
      if (view === "diff") {
        try {
          const result = await getRunDiff(store, runId, { mode, path: filePath, maxBytes });
          if (!result.ok) return visibilityErrorResult(result);
          return textResult({
            runId,
            mode: result.mode,
            base_sha: result.base_sha,
            base_source: result.base_source,
            content: result.content,
            truncated: result.truncated,
            untracked: result.untracked,
          });
        } catch (err) {
          const mapped = mapStoreLookupError(err, { policy: "run" });
          return textResult({ error: mapped.error, status: mapped.status }, true);
        }
      }
      try {
        const result = await readCheckoutFileBytes(store, runId, filePath!);
        if (!result.ok) return visibilityErrorResult(result);
        const classified = classifyArtifactContent(filePath!, result.bytes);
        if (classified.kind === "image") {
          return imageResult(classified.mimeType, result.bytes, {
            runId,
            path: filePath!,
            mimeType: classified.mimeType,
          });
        }
        if (classified.kind === "utf8") {
          return textResult({ runId, path: filePath, content: result.bytes.toString("utf8") });
        }
        return textResult({ error: "Checkout file is not valid UTF-8 text", status: 400 }, true);
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "artifact" });
        return textResult({ error: mapped.error, status: mapped.status }, true);
      }
    },
  );
}