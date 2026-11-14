import { z } from "zod";
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
import { mapStoreLookupError } from "../server/operatorResults.js";
import { imageResult, textResult } from "./toolResults.js";

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
    "list_checkout_changes",
    {
      description:
        "List dirty/untracked paths in the run's bound checkout. Repository and git path bindings use git status; non-git path bindings use filesystem fingerprints. Unbound → run_not_bound; reclaimed checkout → checkout_reclaimed. Caps at 500 entries with truncated: true.",
      inputSchema: z.object({
        runId: z.string(),
      }),
    },
    async ({ runId }) => {
      try {
        const result = await listCheckoutChanges(store, runId);
        if (!result.ok) return visibilityErrorResult(result);
        return textResult({
          runId,
          changes: result.changes,
          truncated: result.truncated,
        });
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "run" });
        return textResult(
          { error: mapped.error, status: mapped.status },
          true,
        );
      }
    },
  );

  server.registerTool(
    "get_run_diff",
    {
      description:
        "Diff the run's bound git checkout against its recorded base SHA (resolved_sha). mode defaults to stat; patch enforces maxBytes (default 262144) with truncated: true. Unbound → run_not_bound; non-git path → not_a_git_repository; reclaimed → checkout_reclaimed.",
      inputSchema: z.object({
        runId: z.string(),
        mode: z.enum(["stat", "patch"]).optional(),
        path: z.string().optional(),
        maxBytes: z.number().optional(),
      }),
    },
    async ({ runId, mode, path: filterPath, maxBytes }) => {
      try {
        const result = await getRunDiff(store, runId, {
          mode,
          path: filterPath,
          maxBytes,
        });
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
        return textResult(
          { error: mapped.error, status: mapped.status },
          true,
        );
      }
    },
  );

  server.registerTool(
    "read_checkout_file",
    {
      description:
        "Read a file from the run's bound checkout by relative path (contained under checkout_root). Same deny-list as read_artifact (.pi-agent, auth.json, traversal). Images return an MCP image block; UTF-8 returns JSON { runId, path, content }.",
      inputSchema: z.object({
        runId: z.string(),
        path: z.string(),
      }),
    },
    async ({ runId, path: relativePath }) => {
      try {
        const result = await readCheckoutFileBytes(store, runId, relativePath);
        if (!result.ok) return visibilityErrorResult(result);
        const classified = classifyArtifactContent(relativePath, result.bytes);
        if (classified.kind === "image") {
          return imageResult(classified.mimeType, result.bytes, {
            runId,
            path: relativePath,
            mimeType: classified.mimeType,
          });
        }
        if (classified.kind === "utf8") {
          return textResult({
            runId,
            path: relativePath,
            content: result.bytes.toString("utf8"),
          });
        }
        return textResult(
          { error: "Checkout file is not valid UTF-8 text", status: 400 },
          true,
        );
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "artifact" });
        return textResult(
          { error: mapped.error, status: mapped.status },
          true,
        );
      }
    },
  );
}
