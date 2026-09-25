import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  diff,
  lsFilesOthersZ,
  revParse,
  statusPorcelainZ,
} from "../git/operations.js";
import type { RunMeta, RunStore } from "../runstore/port.js";
import { projectRunBindingDetail } from "../runstore/runProjection.js";
import { mapStoreLookupError } from "../server/operatorResults.js";
import type { McpToolDeps } from "./deps.js";
import {
  assertSafeRunId,
  CHECKOUT_PATH_MESSAGES,
  classifyArtifactContent,
  resolveContainedRelativePath,
} from "./readArtifact.js";
import { imageResult, textResult } from "./toolResults.js";

export const CHECKOUT_CHANGES_CAP = 500;
export const DEFAULT_DIFF_MAX_BYTES = 262_144;

export type CheckoutChangeStatus =
  | "added"
  | "untracked"
  | "modified"
  | "deleted";

export type CheckoutChangeEntry = {
  path: string;
  status: CheckoutChangeStatus;
};

export type CheckoutVisibilityCode =
  | "run_not_bound"
  | "checkout_reclaimed"
  | "not_a_git_repository";

export type CheckoutVisibilityError = {
  ok: false;
  code: CheckoutVisibilityCode;
  error: string;
  status: number;
};

export type BoundCheckout = {
  ok: true;
  runId: string;
  meta: RunMeta;
  checkoutRoot: string;
  isGit: boolean;
};

async function detectGitCheckout(root: string): Promise<boolean> {
  try {
    const inside = await revParse(root, ["--is-inside-work-tree"]);
    return inside === "true";
  } catch {
    return false;
  }
}

export async function resolveBoundCheckout(
  store: RunStore,
  runId: string,
): Promise<BoundCheckout | CheckoutVisibilityError> {
  assertSafeRunId(runId);
  let meta: RunMeta;
  try {
    meta = await store.readRunMeta(runId);
  } catch (err) {
    const mapped = mapStoreLookupError(err, { policy: "run" });
    throw new Error(mapped.error);
  }
  const binding = projectRunBindingDetail(meta);
  if (binding.kind === "unbound") {
    return {
      ok: false,
      code: "run_not_bound",
      error: "run is not bound to a checkout",
      status: 400,
    };
  }
  const checkoutRoot = meta.checkout_root?.trim();
  if (!checkoutRoot) {
    return {
      ok: false,
      code: "checkout_reclaimed",
      error: "checkout has been reclaimed",
      status: 404,
    };
  }
  if (!existsSync(checkoutRoot)) {
    return {
      ok: false,
      code: "checkout_reclaimed",
      error: "checkout has been reclaimed",
      status: 404,
    };
  }
  const isGit = await detectGitCheckout(checkoutRoot);
  return { ok: true, runId, meta, checkoutRoot, isGit };
}

function nulSplit(output: string): string[] {
  return output.split("\0").filter((part) => part.length > 0);
}

export function parseStatusPorcelainZ(output: string): CheckoutChangeEntry[] {
  const parts = nulSplit(output);
  const changes: CheckoutChangeEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.length < 3) continue;
    const xy = entry.slice(0, 2);
    const firstPath = entry.slice(3);
    const isRenameOrCopy = xy[0] === "R" || xy[0] === "C";
    let filePath = firstPath;
    if (isRenameOrCopy) {
      const next = parts[i + 1];
      if (next !== undefined) {
        filePath = next;
        i += 1;
      }
    }
    if (xy === "??") {
      changes.push({ path: filePath, status: "untracked" });
      continue;
    }
    if (xy === "!!") continue;
    if (xy.includes("D") && !isRenameOrCopy) {
      changes.push({ path: filePath, status: "deleted" });
      continue;
    }
    if (xy[0] === "A" || xy[1] === "A" || isRenameOrCopy) {
      changes.push({ path: filePath, status: "added" });
      continue;
    }
    changes.push({ path: filePath, status: "modified" });
  }
  return changes;
}

function capChanges(changes: CheckoutChangeEntry[]): {
  changes: CheckoutChangeEntry[];
  truncated: boolean;
} {
  if (changes.length <= CHECKOUT_CHANGES_CAP) {
    return { changes, truncated: false };
  }
  return {
    changes: changes.slice(0, CHECKOUT_CHANGES_CAP),
    truncated: true,
  };
}

async function fingerprintFile(
  root: string,
  relativePath: string,
): Promise<string> {
  const target = path.join(root, relativePath);
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      const targetPath = await readlink(target);
      return `link:${createHash("sha256").update(targetPath).digest("hex")}`;
    }
    if (!stats.isFile()) return `other:${stats.mode}:${stats.size}`;
    const contents = await readFile(target);
    return `file:${createHash("sha256").update(contents).digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function listNonGitFiles(
  root: string,
  relativeDir = "",
): Promise<string[]> {
  const absDir = relativeDir ? path.join(root, relativeDir) : root;
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".pi-agent" || entry.name === ".git") continue;
    const rel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (entry.name === "auth.json") continue;
    if (entry.isSymbolicLink() || entry.isFile()) {
      files.push(rel.split(path.sep).join("/"));
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await listNonGitFiles(root, rel)));
    }
  }
  return files;
}

async function listNonGitChanges(
  checkoutRoot: string,
): Promise<{ changes: CheckoutChangeEntry[]; truncated: boolean }> {
  const files = (await listNonGitFiles(checkoutRoot)).sort();
  const changes: CheckoutChangeEntry[] = [];
  for (const file of files) {
    const fingerprint = await fingerprintFile(checkoutRoot, file);
    if (fingerprint === "missing") continue;
    changes.push({ path: file, status: "untracked" });
    if (changes.length > CHECKOUT_CHANGES_CAP) break;
  }
  return capChanges(changes);
}

export async function listCheckoutChanges(
  store: RunStore,
  runId: string,
): Promise<
  | { ok: true; changes: CheckoutChangeEntry[]; truncated: boolean }
  | CheckoutVisibilityError
> {
  const bound = await resolveBoundCheckout(store, runId);
  if (!bound.ok) return bound;
  if (!bound.isGit) {
    const listed = await listNonGitChanges(bound.checkoutRoot);
    return { ok: true, ...listed };
  }
  const porcelain = await statusPorcelainZ(bound.checkoutRoot);
  return { ok: true, ...capChanges(parseStatusPorcelainZ(porcelain)) };
}

export type GetRunDiffInput = {
  mode?: "stat" | "patch";
  path?: string;
  maxBytes?: number;
};

export type GetRunDiffSuccess = {
  ok: true;
  mode: "stat" | "patch";
  base_sha: string;
  base_source: "resolved_sha" | "HEAD";
  content: string;
  truncated: boolean;
  untracked: string[];
};

export async function getRunDiff(
  store: RunStore,
  runId: string,
  input: GetRunDiffInput = {},
): Promise<GetRunDiffSuccess | CheckoutVisibilityError> {
  const bound = await resolveBoundCheckout(store, runId);
  if (!bound.ok) return bound;
  if (!bound.isGit) {
    return {
      ok: false,
      code: "not_a_git_repository",
      error: "checkout is not a git repository",
      status: 400,
    };
  }

  const mode = input.mode ?? "stat";
  const maxBytes =
    typeof input.maxBytes === "number" && Number.isFinite(input.maxBytes)
      ? Math.max(0, Math.floor(input.maxBytes))
      : DEFAULT_DIFF_MAX_BYTES;

  let baseSha = bound.meta.resolved_sha?.trim() || undefined;
  let baseSource: "resolved_sha" | "HEAD" = "resolved_sha";
  if (!baseSha) {
    baseSha = await revParse(bound.checkoutRoot, ["HEAD"]);
    baseSource = "HEAD";
  }

  const pathArgs =
    input.path !== undefined && input.path.trim().length > 0
      ? ["--", input.path]
      : ["--"];

  const diffArgs =
    mode === "patch"
      ? ["--patch", "--no-color", baseSha, ...pathArgs]
      : ["--stat", baseSha, ...pathArgs];

  let content = await diff(bound.checkoutRoot, diffArgs);
  const othersRaw = await lsFilesOthersZ(bound.checkoutRoot);
  let untracked = nulSplit(othersRaw);
  if (input.path !== undefined && input.path.trim().length > 0) {
    const filter = input.path.replace(/\\/g, "/");
    untracked = untracked.filter(
      (file) => file === filter || file.startsWith(`${filter}/`),
    );
  }

  let truncated = false;
  if (mode === "patch" && content.length > maxBytes) {
    content = content.slice(0, maxBytes);
    truncated = true;
  }
  if (untracked.length > CHECKOUT_CHANGES_CAP) {
    untracked = untracked.slice(0, CHECKOUT_CHANGES_CAP);
    truncated = true;
  }

  return {
    ok: true,
    mode,
    base_sha: baseSha,
    base_source: baseSource,
    content,
    truncated,
    untracked,
  };
}

export async function readCheckoutFileBytes(
  store: RunStore,
  runId: string,
  relativePath: string,
): Promise<
  | { ok: true; bytes: Buffer; path: string }
  | CheckoutVisibilityError
> {
  const bound = await resolveBoundCheckout(store, runId);
  if (!bound.ok) return bound;
  const realPath = await resolveContainedRelativePath(
    bound.checkoutRoot,
    relativePath,
    CHECKOUT_PATH_MESSAGES,
  );
  return { ok: true, bytes: await readFile(realPath), path: relativePath };
}

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
