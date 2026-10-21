import path from "node:path";
import { realpath } from "node:fs/promises";
import { STAGE_ID_PATTERN } from "./createStage.js";
import {
  createTask,
  findTaskIdCollision,
  resolveTaskDirectory,
  validateTaskId,
  type CreateTaskResult,
} from "./createTask.js";

export const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type ImportTaskInput = {
  repo: string;
  number: number;
  directory: string;
};

export type ImportTaskParseError = {
  ok: false;
  status: 400;
  error: string;
};

export type IssueFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<Response>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseImportTaskBody(body: unknown): ImportTaskInput | ImportTaskParseError {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }
  if (typeof body.repo !== "string" || !GITHUB_REPO_PATTERN.test(body.repo)) {
    return { ok: false, status: 400, error: "repo must be a GitHub owner/repo" };
  }
  if (typeof body.number !== "number" || !Number.isInteger(body.number) || body.number <= 0) {
    return { ok: false, status: 400, error: "number must be a positive integer" };
  }
  if (typeof body.directory !== "string" || body.directory.trim().length === 0) {
    return { ok: false, status: 400, error: "directory is required" };
  }
  const directory = body.directory.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (directory.length === 0) {
    return { ok: false, status: 400, error: "directory is required" };
  }
  return { repo: body.repo, number: body.number, directory };
}

export function slugIssueTitle(title: string, issueNumber: number): string {
  const fallback = `issue-${issueNumber}`;
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 64) {
    slug = slug.slice(0, 64).replace(/-+$/g, "");
  }
  if (!slug || !STAGE_ID_PATTERN.test(slug)) return fallback;
  return slug;
}

export function taskIdWithSuffix(baseId: string, suffixNumber: number): string {
  const suffix = `-${suffixNumber}`;
  let stem = baseId;
  if (stem.length + suffix.length > 64) {
    stem = stem.slice(0, 64 - suffix.length).replace(/-+$/g, "");
  }
  if (!stem || !STAGE_ID_PATTERN.test(stem)) stem = "issue";
  const candidate = `${stem}${suffix}`;
  if (candidate.length <= 64 && STAGE_ID_PATTERN.test(candidate)) return candidate;
  return `issue${suffix}`;
}

async function allocateTaskId(
  projectRoot: string,
  directory: string,
  baseId: string,
): Promise<string | null> {
  for (let n = 1; n <= 100; n += 1) {
    const id = n === 1 ? baseId : taskIdWithSuffix(baseId, n);
    const idError = validateTaskId(id);
    if (idError) continue;
    const targetPath = path.join(directory, `${id}.task.yaml`);
    const collision = await findTaskIdCollision(projectRoot, id, targetPath);
    if (!collision) return id;
  }
  return null;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "stageflow",
  };
  const token = process.env.GITHUB_TOKEN;
  if (typeof token === "string" && token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function importTaskFromIssue(
  rawProjectRoot: string,
  input: ImportTaskInput,
  fetchImpl: IssueFetch = (url, init) => fetch(url, init),
): Promise<CreateTaskResult> {
  if (!GITHUB_REPO_PATTERN.test(input.repo)) {
    return { ok: false, status: 400, error: "repo must be a GitHub owner/repo" };
  }
  if (!Number.isInteger(input.number) || input.number <= 0) {
    return { ok: false, status: 400, error: "number must be a positive integer" };
  }
  const projectRoot = await realpath(rawProjectRoot).catch(() => rawProjectRoot);
  const directory = resolveTaskDirectory(projectRoot, input.directory);
  if (!directory) {
    return { ok: false, status: 400, error: "directory must be inside the project root" };
  }

  const url = `https://api.github.com/repos/${input.repo}/issues/${input.number}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: githubHeaders() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: message };
  }
  if (response.status === 404) {
    return {
      ok: false,
      status: 404,
      error: `GitHub issue not found: ${input.repo}#${input.number}`,
    };
  }
  if (!response.ok) {
    return { ok: false, status: 502, error: `GitHub request failed (${response.status})` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: "GitHub response was not JSON" };
  }
  if (!isPlainObject(payload) || typeof payload.title !== "string" || payload.title.length === 0) {
    return { ok: false, status: 502, error: "GitHub issue is missing a title" };
  }
  const context = typeof payload.body === "string" ? payload.body : "";
  const baseId = slugIssueTitle(payload.title, input.number);
  const id = await allocateTaskId(projectRoot, directory, baseId);
  if (!id) {
    return { ok: false, status: 409, error: "Unable to allocate a task id" };
  }
  return createTask(projectRoot, {
    directory: input.directory,
    id,
    goal: payload.title,
    ...(context.length > 0 ? { context } : {}),
  });
}
