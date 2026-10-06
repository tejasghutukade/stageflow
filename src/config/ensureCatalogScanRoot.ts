import { readFile, writeFile } from "node:fs/promises";
import { isSeq, parseDocument } from "yaml";
import { manifestPathForProject } from "./loadStageflowManifest.js";

/** Directory scanned for workshop-authored pipelines and tasks. */
export const WORKSHOP_PACKAGE_ROOT = "workshop";

export function normalizeCatalogDir(directory: string): string {
  return directory.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/** Untitled workshop saves land here so Run can see them without a new catalog edit. */
export function defaultWorkshopPackageDirectory(
  pipelineId: string | undefined,
): string {
  const slug = (pipelineId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${WORKSHOP_PACKAGE_ROOT}/${slug || "untitled"}`;
}

/**
 * Catalog root that covers this package directory.
 * Packages under `workshop/` share one root. Any other folder is listed itself
 * so a named save still shows up without scanning a whole parent tree.
 */
export function catalogScanRootForDirectory(directory: string): string {
  const normalized = normalizeCatalogDir(directory);
  if (
    normalized === WORKSHOP_PACKAGE_ROOT ||
    normalized.startsWith(`${WORKSHOP_PACKAGE_ROOT}/`)
  ) {
    return WORKSHOP_PACKAGE_ROOT;
  }
  return normalized;
}

function isCovered(entries: readonly string[], root: string): boolean {
  return entries.some((entry) => {
    const normalized = normalizeCatalogDir(entry);
    return root === normalized || root.startsWith(`${normalized}/`);
  });
}

/**
 * Make sure `stageflow.yaml` scans `directory` for both pipelines and tasks.
 * Returns true when the manifest changed. Missing or unreadable manifests are left alone.
 */
export async function ensureCatalogScanRoot(
  projectRoot: string,
  directory: string,
): Promise<boolean> {
  const root = catalogScanRootForDirectory(directory);
  if (!root || root.split("/").includes("..")) return false;

  const manifestPath = manifestPathForProject(projectRoot);
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    return false;
  }

  const doc = parseDocument(text);
  let changed = false;
  for (const key of ["pipelines", "tasks"] as const) {
    const seq = doc.getIn(["catalog", key]);
    if (!isSeq(seq)) continue;
    const values = seq.toJSON();
    const entries = Array.isArray(values)
      ? values.filter((item): item is string => typeof item === "string")
      : [];
    if (isCovered(entries, root)) continue;
    seq.add(root);
    changed = true;
  }
  if (!changed) return false;
  const next = String(doc);
  await writeFile(
    manifestPath,
    next.endsWith("\n") ? next : `${next}\n`,
    "utf8",
  );
  return true;
}
