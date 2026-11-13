import path from "node:path";

export const STAGE_FILENAME_SUFFIXES = [".stage.yaml", ".stage.yml"] as const;

const YAML_SUFFIXES = [".yaml", ".yml"];

function stripSuffix(name: string, suffixes: readonly string[]): string {
  const lower = name.toLowerCase();
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

/** Basename with `.stage.yaml`/`.stage.yml` removed, then `.yaml`/`.yml`. Case-insensitive. */
export function stageFilenameStem(filePath: string): string {
  const base = path.basename(filePath);
  return stripSuffix(stripSuffix(base, STAGE_FILENAME_SUFFIXES), YAML_SUFFIXES);
}
