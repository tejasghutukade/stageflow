import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HTML_LIBRARY_MAX = 6;

export type HtmlLibraryFileKind = "script" | "style" | "asset";

export type HtmlLibraryFile = {
  path: string;
  kind: HtmlLibraryFileKind;
  integrity: string;
  packageFile: string;
};

export type HtmlLibrary = {
  name: string;
  version: string;
  displayName: string;
  globalName: string;
  packageName: string;
  licence: string;
  needsEval: boolean;
  assets: boolean;
  bytes: number;
  hint: string;
  files: readonly HtmlLibraryFile[];
};

export type HtmlLibraryRef = {
  name: string;
  version: string;
  allowEval?: boolean;
};

function loadHtmlLibraries(): readonly HtmlLibrary[] {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "htmlLibraries.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { libraries: HtmlLibrary[] };
  return parsed.libraries;
}

export const HTML_LIBRARIES: readonly HtmlLibrary[] = loadHtmlLibraries();

export function artifactEvalLibsAllowed(env: { STAGEFLOW_ARTIFACT_ALLOW_EVAL_LIBS?: string }): boolean {
  return env.STAGEFLOW_ARTIFACT_ALLOW_EVAL_LIBS === "1";
}

export function htmlLibraryId(library: { name: string; version: string }): string {
  return `${library.name}@${library.version}`;
}

export function htmlLibraryCatalogIds(): string {
  return HTML_LIBRARIES.map((library) => htmlLibraryId(library)).join(", ");
}

export function findHtmlLibrary(name: string, version: string): HtmlLibrary | undefined {
  return HTML_LIBRARIES.find((library) => library.name === name && library.version === version);
}

export type ShellLibraryFile = {
  path: string;
  kind: HtmlLibraryFileKind;
  integrity: string;
};

export type ShellLibrary = {
  name: string;
  version: string;
  needsEval: boolean;
  assets: boolean;
  files: ShellLibraryFile[];
};

export function shellLibraryTable(): ShellLibrary[] {
  return HTML_LIBRARIES.map((library) => ({
    name: library.name,
    version: library.version,
    needsEval: library.needsEval,
    assets: library.assets,
    files: library.files.map((file) => ({ path: file.path, kind: file.kind, integrity: file.integrity })),
  }));
}
