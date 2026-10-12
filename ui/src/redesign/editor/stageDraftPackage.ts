import { parse } from "yaml";
import type { DraftPackagePayload, PipelineListing } from "../../api";
import { normalizeYamlPath } from "./draftYaml";

export type StageDraftPackage = {
  draft: DraftPackagePayload;
  listing: PipelineListing;
  stageId: string;
};

function stageIdFromPath(path: string): string {
  const base = normalizeYamlPath(path).split("/").pop() ?? path;
  return base.replace(/\.ya?ml$/i, "") || base;
}

function usesForPath(path: string): string {
  const normalized = normalizeYamlPath(path);
  return normalized.startsWith("./") ? normalized : `./${normalized}`;
}

export function buildStageDraftPackage(
  stagePath: string,
  content: string,
  projectRoot?: string,
): StageDraftPackage {
  const path = normalizeYamlPath(stagePath);
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stage YAML must be a mapping at the document root");
  }
  const body = parsed as Record<string, unknown>;
  const fromBody =
    typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;
  const stageId = fromBody ?? stageIdFromPath(path);
  const stageBody = fromBody ? body : { ...body, id: stageId };
  const uses = usesForPath(path);

  const draft: DraftPackagePayload = {
    pipeline: {
      id: stageId,
      stages: [{ id: stageId, uses }],
    },
    stages: [{ path, body: stageBody }],
  };

  const listing: PipelineListing = {
    path,
    id: stageId,
    stages: [{ id: stageId, uses_path: path }],
    ...(projectRoot ? { project_root: projectRoot } : {}),
  };

  return { draft, listing, stageId };
}
